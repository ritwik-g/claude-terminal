import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { store } from '../store.js';
import { getGitInfo } from '../git.js';
import { rankSession, sortSessions } from '../rank.js';
import { getAgent } from '../agents/registry.js';
import { AcpClientHost, normalizeClaudeModel } from './client-host.js';
import { ptyManager } from '../pty-manager.js';
import { getClaudeRateLimits, updateClaudeRateLimitsFromSdk } from '../subscriptions.js';
import type { AcpSession, ContextTransferMode, FileAttachment, PendingPermission, SessionSummary, ThinkingEffort, ToolCallRecord, TurnMessage, UserAnnotations } from '../types.js';

/**
 * Format conversation history into a structured briefing block for context transfer.
 * In 'compact' mode, internal thoughts and raw tool outputs are omitted, and responses
 * are distilled into key decisions, file changes, and instructions to save token context.
 */
export function formatSessionHistory(
  turns: TurnMessage[],
  opts?: { compact?: boolean; maxTurns?: number }
): string {
  const compact = opts?.compact !== false;
  const maxTurns = opts?.maxTurns ?? (compact ? 6 : 4);

  const relevantTurns = turns.filter(
    (t) => (t.role === 'user' || t.role === 'agent') && (t.content || (t.toolCalls && t.toolCalls.length > 0))
  );

  if (relevantTurns.length === 0) return '';

  const slice = relevantTurns.slice(-maxTurns);
  const lines: string[] = [
    `[Prior Conversation Context (${compact ? 'Compacted' : 'Recent Turns'})]`,
    `The following is context from prior turns in this session to maintain continuity:`,
  ];

  for (const turn of slice) {
    if (turn.role === 'user') {
      lines.push(`- User: "${(turn.content || '').trim()}"`);
    } else if (turn.role === 'agent') {
      const parts: string[] = [];
      if (turn.content) {
        let text = turn.content.trim();
        if (compact && text.length > 250) {
          text = text.slice(0, 250) + '...';
        }
        parts.push(text);
      }
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        const toolsList = turn.toolCalls
          .map((tc) => tc.title || tc.kind || 'Action')
          .slice(0, compact ? 3 : 5)
          .join(', ');
        parts.push(`[Executed: ${toolsList}${turn.toolCalls.length > (compact ? 3 : 5) ? '...' : ''}]`);
      }
      if (parts.length > 0) {
        lines.push(`- Assistant: ${parts.join(' ')}`);
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

export class SessionManager extends EventEmitter {
  private activeHosts = new Map<string, AcpClientHost>();
  private pollTimer: NodeJS.Timeout | null = null;

  init(): void {
    store.init();
    // Recover any orphaned 'working' or 'crashed' sessions left behind by server restarts or crashes
    const sessions = store.getAll();
    for (const session of sessions) {
      if (session.agentId === 'claude' && session.model) {
        const normalized = normalizeClaudeModel(session.model);
        if (session.model !== normalized) {
          session.model = normalized;
          store.save(session);
        }
      }
      // Backfill historical agentId and model on turns so model switching never erases history
      let sessionChanged = false;
      let runningAgentId = session.agentId;
      let runningAgentName = session.agentName;
      let runningModel = session.model;

      for (const turn of session.turns) {
        if (turn.role === 'system' && turn.content?.startsWith('Switched model to')) {
          const match = turn.content.match(/Switched model to ([\w\.-]+)/);
          if (match && match[1]) {
            const target = match[1];
            if (target.includes('sonnet') || target.includes('opus') || target.includes('haiku')) {
              runningAgentId = 'claude';
              runningAgentName = 'Claude Code (ACP)';
              runningModel = target.includes('opus') ? 'opus' : target.includes('haiku') ? 'haiku' : 'sonnet';
            } else if (target.includes('gemini') || target.includes('antigravity')) {
              runningAgentId = 'antigravity';
              runningAgentName = 'Google Antigravity (ACP)';
              runningModel = target;
            } else if (target.includes('codex') || target.includes('luna') || target.includes('terra')) {
              runningAgentId = 'codex';
              runningAgentName = 'Codex CLI (ACP)';
              runningModel = target;
            }
          }
        } else if (turn.role === 'agent') {
          if (!turn.agentId || !turn.model) {
            turn.agentId = runningAgentId;
            turn.agentName = runningAgentName;
            turn.model = runningModel;
            sessionChanged = true;
          }
        }
      }

      const host = this.activeHosts.get(session.id);
      if ((session.state === 'working' && (!host || !host.isTurnInFlight)) || session.state === 'crashed') {
        session.state = 'needs_you';
        sessionChanged = true;
      }
      if (sessionChanged) {
        store.save(session);
      }
    }
    this.startBackgroundPoller();
  }

  private startBackgroundPoller(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      let changed = false;
      const sessions = store.getAll();
      for (const session of sessions) {
        // Recover orphaned or idle working state if no turn is actively executing
        const host = this.activeHosts.get(session.id);
        if (session.state === 'working' && (!host || !host.isTurnInFlight || Date.now() - host.lastActivityAt > 60_000)) {
          session.state = 'needs_you';
          changed = true;
          this.emit('sessionStream', { sessionId: session.id, type: 'turnCompleted' });
        }

        // Auto-recover crashed state so user is never permanently stuck
        if (session.state === 'crashed') {
          session.state = 'needs_you';
          changed = true;
          this.emit('sessionStream', { sessionId: session.id, type: 'turnCompleted' });
        }

        // Check snooze expiry
        if (session.user.snoozedUntil && session.user.snoozedUntil <= Date.now()) {
          session.user.snoozedUntil = null;
          changed = true;
        }

        // Refresh git info
        if (session.cwd) {
          const oldGit = session.git;
          const newGit = await getGitInfo(session.cwd);
          if (
            !oldGit ||
            oldGit.uncommittedFiles !== newGit?.uncommittedFiles ||
            oldGit.unpushedCommits !== newGit?.unpushedCommits ||
            oldGit.branch !== newGit?.branch
          ) {
            session.git = newGit;
            changed = true;
          }
        }

        if (changed) {
          const { score, reasons, state } = rankSession(session);
          session.score = score;
          session.reasons = reasons;
          session.state = state;
          store.save(session);
        }
      }

      if (changed) {
        this.emit('sessionsUpdated', this.listSessions());
      }
    }, 10_000);
  }

  listSessions(): SessionSummary[] {
    const sessions = store.getAll();
    const sorted = sortSessions(sessions);

    return sorted.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      agentName: s.agentName,
      title: s.title,
      cwd: s.cwd,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      state: s.state,
      score: s.score,
      reasons: s.reasons,
      lastPrompt: s.lastPrompt,
      recap: s.recap,
      git: s.git,
      user: s.user,
      hasPendingPermission: Boolean(s.pendingPermission),
      pendingPermissionTitle: s.pendingPermission?.title,
      tokenCount: s.usage.contextTokens || (s.usage.inputTokens + s.usage.outputTokens),
      turnCount: s.turns.length,
      model: s.model || getAgent(s.agentId)?.defaultModel,
      isAgentRunning: this.activeHosts.has(s.id),
    }));
  }

  getSession(id: string): AcpSession | null {
    const s = store.get(id);
    if (!s) return null;
    if (
      s.agentId.toLowerCase().includes('claude') ||
      s.agentId.toLowerCase().includes('anthropic') ||
      (s.model && s.model.toLowerCase().includes('claude'))
    ) {
      s.rateLimits = s.rateLimits || getClaudeRateLimits();
    }
    s.isAgentRunning = this.activeHosts.has(s.id);
    return s;
  }

  async createSession(opts: {
    agentId: string;
    cwd: string;
    title?: string;
    model?: string;
    failoverFromId?: string;
    initialPrompt?: string;
  }): Promise<AcpSession> {
    const id = `acp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const agent = getAgent(opts.agentId);
    let model = opts.model || agent.defaultModel;
    if (agent.id === 'claude') {
      model = normalizeClaudeModel(model);
    }
    const git = await getGitInfo(opts.cwd);
    const folderName = path.basename(opts.cwd) || 'workspace';
    const title = opts.title || `${agent.name} in ${folderName}`;

    const session: AcpSession = {
      id,
      agentId: agent.id,
      agentName: agent.name,
      title,
      model,
      titleSource: opts.title ? 'user' : 'auto',
      cwd: opts.cwd,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      state: 'quiet',
      score: 10,
      reasons: ['initialized'],
      lastPrompt: '',
      recap: `Session created with ${agent.name} in ${folderName}`,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0 },
      git,
      user: {
        priority: null,
        pinned: false,
        snoozedUntil: null,
        tags: [],
        cleanup: false,
      },
      pendingPermission: null,
      turns: [],
      failoverFromId: opts.failoverFromId,
      rateLimits: (agent.id === 'claude' || agent.provider === 'anthropic') ? getClaudeRateLimits() : undefined,
    };

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());

    // Spin up host
    await this.ensureHost(session);

    if (opts.initialPrompt) {
      // fire prompt asynchronously
      this.sendPrompt(session.id, opts.initialPrompt).catch((err) => {
        console.error(`[session-mgr] Error sending initial prompt:`, err);
      });
    }

    return session;
  }

  private async ensureHost(session: AcpSession): Promise<AcpClientHost> {
    const existing = this.activeHosts.get(session.id);
    if (existing) return existing;

    const agent = getAgent(session.agentId);
    const host = new AcpClientHost(
      session.id,
      agent,
      session.cwd,
      () => {
        const s = store.get(session.id);
        return Boolean(s?.user.autoApprove);
      },
      session.model,
      session.effort
    );

    let activeAgentTurn: TurnMessage | null = null;

    host.on('thought', (text: string) => {
      const s = store.get(session.id);
      if (!s) return;
      if (!activeAgentTurn) {
        activeAgentTurn = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          thoughts: '',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          agentId: s.agentId,
          agentName: s.agentName,
          model: s.model,
        };
        s.turns.push(activeAgentTurn);
      }
      activeAgentTurn.thoughts = (activeAgentTurn.thoughts || '') + text;
      this.emit('sessionStream', { sessionId: s.id, type: 'thought', text, turn: activeAgentTurn });
    });

    host.on('message', (text: string) => {
      const s = store.get(session.id);
      if (!s) return;
      if (!activeAgentTurn) {
        activeAgentTurn = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          thoughts: '',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          agentId: s.agentId,
          agentName: s.agentName,
          model: s.model,
        };
        s.turns.push(activeAgentTurn);
      }
      activeAgentTurn.content = (activeAgentTurn.content || '') + text;
      s.recap = activeAgentTurn.content.slice(0, 160).replace(/\n/g, ' ') + (activeAgentTurn.content.length > 160 ? '...' : '');
      this.emit('sessionStream', { sessionId: s.id, type: 'message', text, turn: activeAgentTurn });
    });

    host.on('toolCall', (record: ToolCallRecord) => {
      const s = store.get(session.id);
      if (!s) return;
      if (!activeAgentTurn) {
        activeAgentTurn = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          thoughts: '',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          agentId: s.agentId,
          agentName: s.agentName,
          model: s.model,
        };
        s.turns.push(activeAgentTurn);
      }
      activeAgentTurn.toolCalls = activeAgentTurn.toolCalls || [];
      activeAgentTurn.toolCalls.push(record);
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'toolCall', toolCall: record, turn: activeAgentTurn });
    });

    host.on('toolCallUpdate', (record: ToolCallRecord) => {
      const s = store.get(session.id);
      if (!s || !activeAgentTurn || !activeAgentTurn.toolCalls) return;
      const idx = activeAgentTurn.toolCalls.findIndex((t) => t.id === record.id);
      if (idx !== -1) {
        activeAgentTurn.toolCalls[idx] = {
          ...activeAgentTurn.toolCalls[idx],
          ...record,
        };
      }
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'toolCallUpdate', toolCall: record, turn: activeAgentTurn });
    });

    host.on('usageUpdate', (usage) => {
      const s = store.get(session.id);
      if (!s) return;
      s.usage = {
        inputTokens: usage.inputTokens || s.usage.inputTokens,
        outputTokens: usage.outputTokens || s.usage.outputTokens,
        cachedTokens: usage.cachedTokens || s.usage.cachedTokens,
        contextTokens: usage.contextTokens || s.usage.contextTokens,
      };
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'usage', usage: s.usage });
    });

    host.on('permissionRequested', (perm: PendingPermission) => {
      const s = store.get(session.id);
      if (!s) return;
      s.pendingPermission = perm;
      s.state = 'blocked';
      store.save(s);
      this.emit('permissionRequested', { sessionId: s.id, permission: perm });
      this.emit('sessionsUpdated', this.listSessions());
    });

    host.on('permissionResolved', (permId: string) => {
      const s = store.get(session.id);
      if (!s) return;
      s.pendingPermission = null;
      s.state = 'working';
      store.save(s);
      this.emit('permissionResolved', { sessionId: s.id, permId });
      this.emit('sessionsUpdated', this.listSessions());
    });

    host.on('turnCompleted', () => {
      const s = store.get(session.id);
      if (!s) return;
      s.state = 'needs_you';
      activeAgentTurn = null;
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted' });
      this.emit('sessionsUpdated', this.listSessions());

      // Update git in background without blocking state transition
      getGitInfo(s.cwd).then((git) => {
        if (git) {
          const fresh = store.get(session.id);
          if (fresh) {
            fresh.git = git;
            store.save(fresh);
            this.emit('sessionsUpdated', this.listSessions());
          }
        }
      }).catch(() => {});
    });

    host.on('promptSuggestion', (suggestion: string) => {
      const s = store.get(session.id);
      if (s) {
        s.promptSuggestion = suggestion;
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'promptSuggestion', promptSuggestion: suggestion });
        this.emit('sessionsUpdated', this.listSessions());
      }
    });

    host.on('rateLimitUpdate', (info: any) => {
      updateClaudeRateLimitsFromSdk(info);
      const s = store.get(session.id);
      if (s) {
        s.rateLimits = getClaudeRateLimits();
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'rateLimits', rateLimits: s.rateLimits });
        this.emit('sessionsUpdated', this.listSessions());
      }
    });

    host.on('error', (err) => {
      console.warn(`[session-mgr] Agent error on session ${session.id}:`, err);
      const s = store.get(session.id);
      if (!s) return;
      s.state = 'needs_you';
      if (!activeAgentTurn) {
        activeAgentTurn = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          thoughts: '',
          content: `⚠️ Agent error: ${err.message || 'The agent process encountered an error.'}`,
          toolCalls: [],
          timestamp: Date.now(),
          agentId: s.agentId,
          agentName: s.agentName,
          model: s.model,
        };
        s.turns.push(activeAgentTurn);
      } else if (!activeAgentTurn.content) {
        activeAgentTurn.content = `⚠️ Agent error: ${err.message || 'The agent process encountered an error.'}`;
      }
      activeAgentTurn = null;
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted' });
      this.emit('sessionsUpdated', this.listSessions());
    });

    host.on('terminalCreated', (termId: string) => {
      const s = store.get(session.id);
      if (!s) return;
      s.activeTerminalId = termId;
      store.save(s);
      this.emit('sessionsUpdated', this.listSessions());
      this.emit('sessionStream', { sessionId: s.id, type: 'terminalCreated', terminalId: termId });
    });

    host.on('terminalReleased', () => {
      const s = store.get(session.id);
      if (!s) return;
      s.activeTerminalId = undefined;
      store.save(s);
      this.emit('sessionsUpdated', this.listSessions());
      this.emit('sessionStream', { sessionId: s.id, type: 'terminalReleased' });
    });

    host.on('closed', () => {
      this.activeHosts.delete(session.id);
      const s = store.get(session.id);
      if (s && s.state === 'working') {
        s.state = 'needs_you';
        activeAgentTurn = null;
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted' });
        this.emit('sessionsUpdated', this.listSessions());
      }
    });

    await host.start();
    this.activeHosts.set(session.id, host);
    return host;
  }

  async sendPrompt(sessionId: string, promptText: string, attachments?: FileAttachment[]): Promise<void> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Process and save any attachments to disk
    const savedAttachments: FileAttachment[] = [];
    if (attachments && attachments.length > 0) {
      const uploadDir = path.join(os.homedir(), '.acp-terminal', 'uploads', sessionId);
      fs.mkdirSync(uploadDir, { recursive: true });
      for (const att of attachments) {
        const safeName = (att.name || `file_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(uploadDir, safeName);
        if (att.data) {
          try {
            const rawBase64 = att.data.replace(/^data:[^;]+;base64,/, '');
            fs.writeFileSync(filePath, Buffer.from(rawBase64, 'base64'));
          } catch (e) {
            console.error(`[session-mgr] Failed to write attachment ${safeName}:`, e);
          }
        }
        savedAttachments.push({
          id: att.id || `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: att.name,
          size: att.size || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
          mimeType: att.mimeType,
          path: filePath,
          url: `/api/attachments/${sessionId}/${encodeURIComponent(safeName)}`,
          data: att.data,
          isImage: att.isImage ?? att.mimeType?.startsWith('image/'),
        });
      }
    }

    session.lastPrompt = promptText;
    session.turns.push({
      id: `usr-${Date.now()}`,
      role: 'user',
      content: promptText,
      attachments: savedAttachments.length > 0 ? savedAttachments : undefined,
      timestamp: Date.now(),
      agentId: session.agentId,
      agentName: session.agentName,
      model: session.model,
    });

    session.state = 'working';
    session.promptSuggestion = undefined;
    // If the host is not currently in memory (e.g. server daemon restarted or agent re-initialized),
    // automatically seed the newly spawned agent process with the prior conversation history
    if (!this.activeHosts.has(sessionId) && session.turns.length > 1) {
      session.contextHandoffPending = true;
    }

    // Prepare prompt to deliver to host
    let promptWithAttachments = promptText;
    if (savedAttachments.length > 0) {
      const attachmentSummaries: string[] = [];
      for (const att of savedAttachments) {
        if (att.isImage) {
          attachmentSummaries.push(`[Attached Image: ${att.name} (Saved at: ${att.path})]`);
        } else {
          attachmentSummaries.push(`[Attached File: ${att.name} (Saved at: ${att.path})]`);
          try {
            if (att.path && fs.existsSync(att.path) && att.size < 50000) {
              const textContent = fs.readFileSync(att.path, 'utf8');
              attachmentSummaries.push(`--- Begin File Content: ${att.name} ---\n${textContent}\n--- End File Content: ${att.name} ---`);
            }
          } catch {}
        }
      }
      promptWithAttachments = promptText
        ? `${attachmentSummaries.join('\n\n')}\n\n${promptText}`
        : attachmentSummaries.join('\n\n');
    }

    let promptToSendToHost = promptWithAttachments;
    if (session.contextHandoffPending) {
      const priorTurns = session.turns.slice(0, -1);
      const historyBlock = formatSessionHistory(priorTurns, {
        compact: session.contextMode !== 'full',
      });
      if (historyBlock) {
        promptToSendToHost = `${historyBlock}\n\n[Active User Request]\n${promptWithAttachments}`;
      }
      session.contextHandoffPending = false;
    }

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());

    try {
      const host = await this.ensureHost(session);
      await host.sendPrompt(promptToSendToHost, savedAttachments);
    } catch (err: any) {
      console.error(`[session-mgr] Error executing prompt for ${sessionId}:`, err);
      const s = store.get(sessionId);
      if (s) {
        const lastTurn = s.turns[s.turns.length - 1];
        if (!lastTurn || lastTurn.role !== 'agent') {
          s.turns.push({
            id: `msg-${Date.now()}`,
            role: 'agent',
            thoughts: '',
            content: `⚠️ ${err.message || 'The agent encountered an error processing your request.'}`,
            toolCalls: [],
            timestamp: Date.now(),
          });
        } else if (!lastTurn.content) {
          lastTurn.content = `⚠️ ${err.message || 'The agent encountered an error processing your request.'}`;
        }
        store.save(s);
      }
    } finally {
      // ABSOLUTE GUARANTEE: The session is NEVER left in 'working' status when sendPrompt ends
      const s = store.get(sessionId);
      if (s && (s.state === 'working' || s.state === 'crashed')) {
        s.state = 'needs_you';
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted', session: s });
        this.emit('sessionsUpdated', this.listSessions());
      }
    }
  }

  async resolvePermission(sessionId: string, optionId: string): Promise<boolean> {
    const host = this.activeHosts.get(sessionId);
    if (!host) return false;
    return host.resolvePermission(optionId);
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    const host = this.activeHosts.get(sessionId);
    if (host) {
      await host.cancel();
    }
    const session = store.get(sessionId);
    if (session) {
      session.state = 'needs_you';
      store.save(session);
      this.emit('sessionStream', { sessionId: session.id, type: 'turnCompleted', session });
      this.emit('sessionsUpdated', this.listSessions());
    }
  }

  /**
   * Stop / Park the underlying agent subprocess and release its terminal without deleting session history.
   * Kills the ACP client host child process (SIGTERM -> SIGKILL) and releases the PTY terminal.
   * Marks context handoff as pending so the next prompt will automatically re-spawn the agent seamlessly.
   */
  async stopSessionAgent(sessionId: string): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const host = this.activeHosts.get(sessionId);
    if (host) {
      if (host.isTurnInFlight) {
        await host.cancel().catch(() => {});
      }
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }
    ptyManager.release(`session-term-${sessionId}`);

    session.state = 'parked';
    session.pendingPermission = null;
    session.activeTerminalId = undefined;
    session.isAgentRunning = false;
    session.contextHandoffPending = session.turns.length > 0;
    session.updatedAt = Date.now();

    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: `🛑 Agent process stopped. Subprocess & terminal resources released. The agent will automatically re-spawn when you send your next message.`,
      timestamp: Date.now(),
    });

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionStopped', session });

    return session;
  }

  /**
   * Start / Resume the underlying agent subprocess for a session.
   */
  async startSessionAgent(sessionId: string): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    await this.ensureHost(session);
    session.isAgentRunning = true;
    if (session.state === 'parked') {
      session.state = 'needs_you';
    }
    session.updatedAt = Date.now();

    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: `▶️ Agent process started. Ready for prompts.`,
      timestamp: Date.now(),
    });

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionStarted', session });

    return session;
  }

  /**
   * Switch the active agent engine and/or model for an existing session IN-PLACE.
   * Shuts down the previous agent host so the next prompt launches the new agent seamlessly.
   * Automatically prepares conversation context handover (compacted or full) for the new engine.
   */
  async setSessionAgent(
    sessionId: string,
    newAgentId: string,
    newModel?: string,
    newEffort?: ThinkingEffort,
    contextMode: ContextTransferMode = 'compact'
  ): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const prevAgentName = session.agentName;
    const targetAgent = getAgent(newAgentId);
    let targetModel = newModel || targetAgent.defaultModel;
    if (targetAgent.id === 'claude') {
      targetModel = normalizeClaudeModel(targetModel);
    }

    // Shutdown previous host process so new host can be spun up on next turn
    const oldHost = this.activeHosts.get(sessionId);
    if (oldHost) {
      oldHost.shutdown();
      this.activeHosts.delete(sessionId);
    }

    session.agentId = targetAgent.id;
    session.agentName = targetAgent.name;
    session.model = targetModel;
    if (newEffort !== undefined) {
      session.effort = newEffort;
    }

    session.contextMode = contextMode;
    const hasPriorTurns = session.turns.some((t) => t.role === 'user' || t.role === 'agent');
    session.contextHandoffPending = contextMode !== 'none' && hasPriorTurns;

    // Reset crashed, blocked, or working state since old host is shutdown
    if (session.state === 'crashed' || session.state === 'blocked' || session.state === 'working') {
      session.state = 'needs_you';
      session.pendingPermission = null;
    }

    const effortLabel = session.effort && session.effort !== 'off' ? ` [Effort: ${session.effort}]` : '';
    const contextLabel = session.contextHandoffPending ? ` [Context: ${contextMode}]` : '';
    // Record an informative system event in the conversation
    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: `Switched model to ${targetModel || targetAgent.name}${effortLabel}${contextLabel}`,
      timestamp: Date.now(),
    });

    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionSwitched', session });

    return session;
  }

  /**
   * Set or update thinking / reasoning effort for a session.
   * Restarts the host process on the next prompt to apply reasoning parameters.
   */
  async setSessionEffort(sessionId: string, effort: ThinkingEffort): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.effort = effort;

    // Shutdown running host so new reasoning budget applies on next prompt
    const host = this.activeHosts.get(sessionId);
    if (host) {
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }

    if (session.state === 'working' || session.state === 'crashed') {
      session.state = 'needs_you';
    }

    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionEffortUpdated', effort, session });

    return session;
  }

  /**
   * Compact conversation context for a session.
   * Distills verbose turns and past tool outputs into a single consolidated summary turn,
   * keeping the active goal and resetting the ACP subprocess memory to maximize context efficiency.
   */
  async compactSession(sessionId: string): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const relevantTurns = session.turns.filter((t) => t.role === 'user' || t.role === 'agent');
    if (relevantTurns.length <= 1) {
      return session; // nothing substantial to compact
    }

    // Extract original goal and last user prompt
    const userPrompts = session.turns.filter((t) => t.role === 'user').map((t) => t.content || '');
    const firstPrompt = userPrompts[0] || session.title;
    const lastPrompt = userPrompts[userPrompts.length - 1] || session.lastPrompt || firstPrompt;

    // Collect touched files from tool calls
    const touchedFiles = new Set<string>();
    for (const turn of session.turns) {
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          const input: any = tc.input;
          if (input?.path) touchedFiles.add(input.path);
          if (input?.file) touchedFiles.add(input.file);
        }
      }
    }
    const filesSummary = touchedFiles.size > 0 ? Array.from(touchedFiles).slice(0, 8).join(', ') : '';

    const summaryLines = [
      `📦 **Session Context Compacted**`,
      `- **Initial Goal**: "${firstPrompt}"`,
      `- **Current Goal / State**: "${lastPrompt}"`,
      session.recap ? `- **Recap of progress**: ${session.recap}` : '',
      filesSummary ? `- **Files referenced/modified**: ${filesSummary}${touchedFiles.size > 8 ? ` (+${touchedFiles.size - 8} more)` : ''}` : '',
      `\n*Earlier verbose turns and tool outputs have been compacted into this checkpoint to free up context.*`
    ].filter(Boolean).join('\n');

    const compactedTurn: TurnMessage = {
      id: `compact-${Date.now()}`,
      role: 'system',
      content: summaryLines,
      timestamp: Date.now(),
    };

    session.turns = [compactedTurn];
    session.contextMode = 'compact';
    session.contextHandoffPending = true;

    // Reset host subprocess memory so on next prompt the agent starts with the lean context
    const host = this.activeHosts.get(sessionId);
    if (host) {
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }

    session.state = 'needs_you';
    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionCompacted', session });

    return session;
  }

  /**
   * Failover / Switch Agent:
   * Transfers active repository context, conversation history, and recap into a new session powered by targetAgentId,
   * or updates the session in-place if opts.inPlace is true.
   */
  async switchAgent(
    sessionId: string,
    targetAgentId: string,
    opts?: {
      model?: string;
      archivePrevious?: boolean;
      inPlace?: boolean;
      customPrompt?: string;
      skipInitialPrompt?: boolean;
      contextMode?: ContextTransferMode;
    }
  ): Promise<AcpSession> {
    if (opts?.inPlace) {
      const session = await this.setSessionAgent(sessionId, targetAgentId, opts.model, undefined, opts.contextMode);
      if (!opts?.skipInitialPrompt) {
        const continuationPrompt =
          opts?.customPrompt ||
          `Please continue working on the active task: "${session.lastPrompt || session.recap || 'Continue the repository task'}".`;
        this.sendPrompt(session.id, continuationPrompt).catch((err) => {
          console.error(`[session-mgr] Error sending continuation prompt on in-place switch:`, err);
        });
      }
      return session;
    }

    const current = store.get(sessionId);
    if (!current) throw new Error(`Session ${sessionId} not found`);

    const targetAgent = getAgent(targetAgentId);
    const git = await getGitInfo(current.cwd);

    const folderName = path.basename(current.cwd) || 'workspace';
    const newTitle = `${targetAgent.name} (from ${current.agentName}) in ${folderName}`;

    // If requested, archive/clean up previous session
    if (opts?.archivePrevious) {
      current.user.cleanup = true;
      store.save(current);
    }

    // Synthesize context handoff prompt with structured conversation history
    let initialPrompt: string | undefined = undefined;
    if (!opts?.skipInitialPrompt) {
      if (opts?.customPrompt) {
        initialPrompt = opts.customPrompt;
      } else {
        const activeGoal = current.lastPrompt || current.recap || 'Continue the repository task';
        const contextMode = opts?.contextMode || 'compact';
        let historySection = '';
        if (contextMode !== 'none') {
          const formattedHistory = formatSessionHistory(current.turns, { compact: contextMode === 'compact' });
          if (formattedHistory) {
            historySection = `\n${formattedHistory}\n`;
          }
        }

        initialPrompt = [
          `[Agent Switch / Failover Handover]`,
          `- Workspace: ${current.cwd}`,
          `- Git branch: ${git?.branch || 'main'}, Uncommitted files: ${git?.uncommittedFiles || 0}`,
          `- Previous Agent: ${current.agentName}${current.model ? ` (${current.model})` : ''}`,
          `- Active Goal: "${activeGoal}"`,
          historySection,
          `Please proceed directly with addressing the active goal above. Do not perform exhaustive repo-wide scans unless directly relevant to this specific task.`
        ].filter(Boolean).join('\n');
      }
    }

    const newSession = await this.createSession({
      agentId: targetAgentId,
      cwd: current.cwd,
      title: newTitle,
      model: opts?.model,
      failoverFromId: current.id,
      initialPrompt,
    });

    return newSession;
  }

  /**
   * Rollback / Undo conversation turns to a specific point.
   * Shuts down any running ACP agent host so subsequent turns do not persist in subprocess memory.
   */
  async rollbackSession(
    sessionId: string,
    opts: {
      turnId?: string;
      action: 'revert_to_this' | 'revert_before_this' | 'undo_last';
    }
  ): Promise<{ session: AcpSession; restoredPrompt?: string }> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (session.turns.length === 0) {
      return { session };
    }

    let restoredPrompt: string | undefined = undefined;

    if (opts.action === 'undo_last') {
      const removedTurn = session.turns.pop();
      if (removedTurn?.role === 'user') {
        restoredPrompt = removedTurn.content;
      }
    } else if (opts.turnId) {
      const targetIndex = session.turns.findIndex((t) => t.id === opts.turnId);
      if (targetIndex === -1) {
        throw new Error(`Turn ${opts.turnId} not found in session`);
      }

      const targetTurn = session.turns[targetIndex];

      if (opts.action === 'revert_before_this') {
        // Revert before this turn: remove targetTurn and all subsequent turns
        if (targetTurn.role === 'user') {
          restoredPrompt = targetTurn.content;
        }
        session.turns = session.turns.slice(0, targetIndex);
      } else if (opts.action === 'revert_to_this') {
        // Revert to this turn: keep up to and including targetTurn, remove all subsequent turns
        session.turns = session.turns.slice(0, targetIndex + 1);
      }
    } else {
      throw new Error('turnId is required for revert_to_this and revert_before_this');
    }

    // Terminate running host process so old conversation state is cleared from process memory
    const host = this.activeHosts.get(sessionId);
    if (host) {
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }

    // Recalculate session properties based on remaining turns
    const lastUserTurn = [...session.turns].reverse().find((t) => t.role === 'user');
    session.lastPrompt = lastUserTurn?.content || '';

    const lastAgentTurn = [...session.turns].reverse().find((t) => t.role === 'agent');
    session.recap = lastAgentTurn?.content
      ? lastAgentTurn.content.slice(0, 160).replace(/\n/g, ' ') + (lastAgentTurn.content.length > 160 ? '...' : '')
      : '';

    session.state = 'needs_you';
    session.pendingPermission = null;
    session.activeTerminalId = undefined;
    session.updatedAt = Date.now();

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionRollback', session });

    return { session, restoredPrompt };
  }

  updateAnnotations(sessionId: string, updates: Partial<UserAnnotations>): AcpSession | null {
    const updated = store.updateAnnotations(sessionId, updates);
    if (updated) {
      this.emit('sessionsUpdated', this.listSessions());
    }
    return updated;
  }

  deleteSession(sessionId: string): boolean {
    const host = this.activeHosts.get(sessionId);
    if (host) {
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }
    ptyManager.release(`session-term-${sessionId}`);
    const res = store.delete(sessionId);
    if (res) {
      this.emit('sessionsUpdated', this.listSessions());
    }
    return res;
  }

  shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const host of this.activeHosts.values()) {
      host.shutdown();
    }
    this.activeHosts.clear();
  }
}

export const sessionManager = new SessionManager();
