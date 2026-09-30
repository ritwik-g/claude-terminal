import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { store } from '../store.js';
import { getGitInfo } from '../git.js';
import { rankSession, sortSessions } from '../rank.js';
import { getAgent, hasAgent } from '../agents/registry.js';
import { AcpClientHost, HostClosedError, TurnInFlightError, capToolOutput, normalizeClaudeModel, type ChunkMeta, type CompactionEvent } from './client-host.js';
import { HANDOFF_SUMMARY_PROMPT, autoCompactDecision, capSummary, contextWindowFor, latestCompaction, readAutoCompactDefault, writeAutoCompactDefault } from '../compaction.js';
import { ptyManager } from '../pty-manager.js';
import { getUploadsDir } from '../paths.js';
import { getClaudeRateLimits, updateClaudeRateLimitsFromSdk } from '../subscriptions.js';
import { cachedAgentOptions, effortLabel, rememberAgentOptions, resolveModelValue } from './agent-options.js';
import { appendSubagentText, completeAsyncSubagent, endAgentTasks, stopAgentTask, stopTranscriptWatchers, syncAgentTasks, trackAsyncTask, trackTaskText, trackToolCall, trackToolCallUpdate, watchSubagentTranscript } from './agent-tasks.js';
import { AUTO_EFFORT } from '../types.js';
import type { AcpSession, AutoCompactSetting, CompactionRecord, AgentOptions, AgentTask, AgentTaskTextDelta, AsyncTaskUpdate, QueuedPrompt, ContextTransferMode, FileAttachment, PendingPermission, PlanEntry, SessionSummary, ThinkingEffort, ToolCallRecord, TurnMessage, UserAnnotations } from '../types.js';

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

  // The latest compaction summary stands in for every turn before it; only later turns are listed
  const checkpoint = latestCompaction(turns);
  const relevantTurns = turns.slice(checkpoint ? checkpoint.index + 1 : 0).filter(
    (t) => (t.role === 'user' || t.role === 'agent') && (t.content || (t.toolCalls && t.toolCalls.length > 0))
  );

  if (relevantTurns.length === 0 && !checkpoint) return '';

  const slice = relevantTurns.slice(-maxTurns);
  const lines: string[] = [
    `[Prior Conversation Context (${compact ? 'Compacted' : 'Recent Turns'})]`,
    `The following is context from prior turns in this session to maintain continuity:`,
  ];
  if (checkpoint) {
    lines.push('Summary of the conversation so far (written when its context was compacted):', checkpoint.summary);
    if (slice.length > 0) lines.push('Turns since that summary:');
  }

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

/**
 * Reset an effort the current model does not offer to Auto, and record why in the
 * conversation. Returns the note it added, or null when the effort stands.
 */
export function reconcileEffort(s: AcpSession, options: AgentOptions): TurnMessage | null {
  if (!s.effort || s.effort === AUTO_EFFORT) return null;
  if (options.efforts.some((e) => e.value === s.effort)) return null;
  const previous = s.effort;
  s.effort = AUTO_EFFORT;
  const model = options.models.find((m) => m.value === options.currentModel)?.label || s.model || s.agentName;
  const reason = options.efforts.length === 0
    ? `${model} has no effort setting`
    : `${model} does not offer ${effortLabel(previous)} effort`;
  const note: TurnMessage = {
    id: `sys-${Date.now()}-effort`,
    role: 'system',
    content: `${reason}, so effort is back to Auto.`,
    timestamp: Date.now(),
  };
  s.turns.push(note);
  return note;
}

// A 'working' turn with no agent, permission or terminal activity for this long is treated as hung
const STALE_TURN_MS = 10 * 60_000;

export class QueuedPromptNotFoundError extends Error {
  constructor() {
    super('That queued message was already sent or removed');
  }
}

export class NothingToCompactError extends Error {
  constructor() {
    super('Nothing new to compact since the last compaction');
  }
}

export class SessionManager extends EventEmitter {
  private activeHosts = new Map<string, AcpClientHost>();
  // Hosts still in start(): concurrent ensureHost() calls share one spawn
  private startingHosts = new Map<string, { host: AcpClientHost; promise: Promise<AcpClientHost> }>();
  // sendPrompt ownership per session; a newer prompt, cancel or host teardown takes it away
  private activePrompts = new Map<string, number>();
  private promptSeq = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  // A compaction in progress per session; the agent's output during it goes to the compaction, not the transcript
  private compactionRuns = new Map<string, CompactionRun>();
  // `<sessionId>:<agent compaction id>` -> the card of a compaction the agent started on its own
  private agentCompactions = new Map<string, string>();
  // "Compact when finished" held back by background work: the stop reason of the turn it follows
  private autoCompactAfterBackground = new Map<string, string | undefined>();

  constructor() {
    super();
    // Terminal output counts as turn activity, so a long-running command is not taken for a hung turn
    ptyManager.on('data', (evt: { sessionId: string }) => {
      const host = this.activeHosts.get(evt.sessionId);
      if (host) host.lastActivityAt = Date.now();
    });
  }

  /** True while a prompt is being delivered or the agent is still working on it. */
  isTurnInFlight(sessionId: string): boolean {
    return this.activePrompts.has(sessionId) || Boolean(this.activeHosts.get(sessionId)?.isTurnInFlight);
  }

  /** Shut down the session's agent (running or still starting) and drop turn ownership. */
  private dropHost(sessionId: string): void {
    const run = this.compactionRuns.get(sessionId);
    if (run) this.finishCompaction(sessionId, run, { stopReason: 'cancelled' });
    this.settleAgentCompactions(sessionId, 'Stopped when the agent was stopped');
    this.settleBackgroundWork(sessionId, 'Stopped when the agent was stopped');
    const host = this.activeHosts.get(sessionId);
    if (host) {
      host.shutdown();
      this.activeHosts.delete(sessionId);
    }
    const starting = this.startingHosts.get(sessionId);
    if (starting) {
      starting.host.shutdown();
      this.startingHosts.delete(sessionId);
    }
    this.activePrompts.delete(sessionId);
  }

  /**
   * Close the cards of compactions the agent started on its own: with its process gone no
   * update will ever end them. Our own run is left to finishCompaction.
   */
  private settleAgentCompactions(sessionId: string, reason: string): void {
    for (const key of this.agentCompactions.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.agentCompactions.delete(key);
    }
    const s = store.get(sessionId);
    if (!s) return;
    const ownTurnId = this.compactionRuns.get(sessionId)?.turnId;
    const settled = s.turns.filter((t) => t.compaction?.status === 'running' && t.id !== ownTurnId);
    if (settled.length === 0) return;
    for (const turn of settled) {
      turn.compaction = { ...turn.compaction!, status: 'cancelled', error: reason, endedAt: Date.now() };
      turn.content = compactionLabel(turn.compaction);
    }
    store.save(s, { touch: false });
    for (const turn of settled) this.emit('sessionStream', { sessionId, type: 'compaction', turn });
  }

  private settleBackgroundWork(sessionId: string, reason: string): void {
    // Work cut short by a stop is not a finished run to compact after
    this.autoCompactAfterBackground.delete(sessionId);
    const s = store.get(sessionId);
    if (!s || !endBackgroundWork(s, reason)) return;
    store.save(s, { touch: false });
    this.emit('sessionStream', { sessionId, type: 'backgroundSettled' });
  }

  init(): void {
    store.init();
    // Recover any orphaned 'working' or 'crashed' sessions left behind by server restarts or crashes
    const sessions = store.getAll();
    for (const session of sessions) {
      if (session.agentId === 'claude' && session.model) {
        const normalized = normalizeClaudeModel(session.model);
        if (session.model !== normalized) {
          session.model = normalized;
          store.save(session, { touch: false });
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
      // No agent survives a server restart, so a stored approval request can never be answered
      if (session.pendingPermission && !host) {
        session.pendingPermission = null;
        sessionChanged = true;
      }
      if (!host && endBackgroundWork(session, 'Stopped when the server restarted')) {
        sessionChanged = true;
      }
      for (const turn of session.turns) {
        if (turn.compaction?.status === 'running' && !host) {
          turn.compaction = { ...turn.compaction, status: 'failed', error: 'Stopped when the server restarted', endedAt: Date.now() };
          turn.content = compactionLabel(turn.compaction);
          sessionChanged = true;
        }
      }
      if (session.activeTerminalId && !ptyManager.getTerminal(session.activeTerminalId)) {
        session.activeTerminalId = undefined;
        sessionChanged = true;
      }
      if (sessionChanged) {
        store.save(session, { touch: false });
      }
    }
    this.startBackgroundPoller();
  }

  private startBackgroundPoller(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      let anyChanged = false;
      const sessions = store.getAll();
      for (const session of sessions) {
        let changed = false;
        // Recover orphaned 'working' state when no turn is executing, and cancel a turn gone silent
        const host = this.activeHosts.get(session.id);
        if (this.compactionRuns.has(session.id) && host?.isTurnInFlight && Date.now() - host.lastActivityAt > STALE_TURN_MS) {
          console.warn(`[session-mgr] Compaction on ${session.id} silent for ${STALE_TURN_MS / 60_000}m; cancelling`);
          this.cancelPrompt(session.id).catch(() => {});
          continue;
        }
        if (session.state === 'working') {
          if (!this.isTurnInFlight(session.id)) {
            session.state = 'needs_you';
            changed = true;
            this.emit('sessionStream', { sessionId: session.id, type: 'turnCompleted' });
          } else if (host?.isTurnInFlight && Date.now() - host.lastActivityAt > STALE_TURN_MS) {
            console.warn(`[session-mgr] Turn on ${session.id} silent for ${STALE_TURN_MS / 60_000}m; cancelling`);
            this.cancelPrompt(session.id).catch(() => {});
            continue;
          }
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

        // Refresh git info (getGitInfo returns a stable null for non-git directories)
        if (session.cwd) {
          const oldGit = session.git;
          const newGit = await getGitInfo(session.cwd);
          if (
            (oldGit === null) !== (newGit === null) ||
            (oldGit && newGit && (
              oldGit.uncommittedFiles !== newGit.uncommittedFiles ||
              oldGit.unpushedCommits !== newGit.unpushedCommits ||
              oldGit.branch !== newGit.branch
            ))
          ) {
            session.git = newGit;
            changed = true;
          }
        }

        if (changed) {
          // Bookkeeping only: keep updatedAt so the recency ranking reflects real activity
          store.save(session, { touch: false });
          anyChanged = true;
        }
      }

      if (anyChanged) {
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
      rankFactors: s.rankFactors,
      rankSummary: s.rankSummary,
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
    // Older sessions get their agent tasks built; undone or compacted turns take theirs along
    if (syncAgentTasks(s)) store.save(s, { touch: false });
    return s;
  }

  /** Broadcast changed agent tasks, and start watching any async subagent that only a transcript can end. */
  /** Stream a chunk trackTaskText just added to the task's last segment. */
  private emitTaskText(sessionId: string, task: AgentTask, text: string, toolCallId?: string): void {
    const seg = task.segments?.[task.segments.length - 1];
    if (!seg || (seg.kind !== 'text' && seg.kind !== 'thought')) return;
    const taskText: AgentTaskTextDelta = { taskId: task.id, segmentId: seg.id, kind: seg.kind, text, toolCallId };
    if (seg.kind === 'text' && seg.messageId) taskText.messageId = seg.messageId;
    this.emit('sessionStream', { sessionId, type: 'agentTaskText', taskText });
  }

  private agentTasksChanged(sessionId: string, tasks: AgentTask[]): AgentTask[] | undefined {
    for (const task of tasks) {
      if (task.kind !== 'subagent' || task.status !== 'running' || !task.toolCallId) continue;
      const call = findToolCall(store.get(sessionId)!, task.toolCallId)?.call;
      if (!call?.agentOutputFile) continue;
      watchSubagentTranscript(
        `${sessionId}:${task.id}`,
        call.agentOutputFile,
        () => store.get(sessionId)?.agentTasks?.find((t) => t.id === task.id)?.status === 'running',
        (report) => {
          const s = store.get(sessionId);
          const done = s && completeAsyncSubagent(s, task.id, report);
          if (!s || !done) return;
          store.save(s, { touch: false });
          const owner = done.call && findToolCall(s, done.call.id);
          this.emit('sessionStream', { sessionId, type: 'backgroundUpdate', toolCall: done.call, turn: owner?.turn, agentTasks: [done.task] });
          this.recheckAutoCompact(sessionId);
        },
        () => {
          // A task left 'running' for good would hold back "Compact when finished" forever
          const s = store.get(sessionId);
          const ended = s && stopAgentTask(s, task.id, 'No sign of it finishing after 6 hours');
          if (!s || !ended) return;
          store.save(s, { touch: false });
          this.emit('sessionStream', { sessionId, type: 'agentTask', agentTasks: [ended] });
          this.recheckAutoCompact(sessionId);
        }
      );
    }
    return tasks.length > 0 ? tasks : undefined;
  }

  async createSession(opts: {
    agentId: string;
    cwd: string;
    title?: string;
    model?: string;
    failoverFromId?: string;
    initialPrompt?: string;
  }): Promise<AcpSession> {
    if (!hasAgent(opts.agentId)) throw new Error(`Unknown agent: ${opts.agentId}`);
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
      autoCompact: readAutoCompactDefault(),
    };

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());

    // Spin up host; a session whose agent never started is removed rather than left as a zombie
    try {
      await this.ensureHost(session);
    } catch (err) {
      this.dropHost(id);
      store.delete(id);
      this.emit('sessionsUpdated', this.listSessions());
      throw err;
    }

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
    const starting = this.startingHosts.get(session.id);
    if (starting) return starting.promise;

    const host = this.createHost(session);
    const promise = (async () => {
      try {
        await host.start();
      } catch (err) {
        // Kill whatever start() managed to spawn so a failed start never leaks a process
        host.shutdown();
        throw err;
      } finally {
        if (this.startingHosts.get(session.id)?.host === host) this.startingHosts.delete(session.id);
      }
      if (host.isShutdown) throw new Error('Agent was stopped while starting');
      this.activeHosts.set(session.id, host);
      const current = store.get(session.id);
      if (current && host.mcpInfo) {
        current.mcp = host.mcpInfo;
        store.save(current, { touch: false });
      }
      return host;
    })();
    this.startingHosts.set(session.id, { host, promise });
    return promise;
  }

  private createHost(session: AcpSession): AcpClientHost {
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

    const ensureAgentTurn = (s: AcpSession): TurnMessage => {
      // A reply the agent started on its own (e.g. after a background task finished) has no
      // prompt whose end closes it, so a message sent since then starts the next reply
      if (activeAgentTurn) {
        const at = s.turns.findIndex((t) => t.id === activeAgentTurn!.id);
        if (at === -1 || s.turns.slice(at + 1).some((t) => t.role === 'user')) activeAgentTurn = null;
      }
      if (!activeAgentTurn) {
        activeAgentTurn = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          thoughts: '',
          content: '',
          toolCalls: [],
          segments: [],
          timestamp: Date.now(),
          agentId: s.agentId,
          agentName: s.agentName,
          model: s.model,
        };
        s.turns.push(activeAgentTurn);
      }
      activeAgentTurn.segments = activeAgentTurn.segments || [];
      return activeAgentTurn;
    };

    host.on('thought', (text: string, meta: ChunkMeta) => {
      const s = store.get(session.id);
      if (!s) return;
      if (this.compactionRuns.has(session.id)) return; // reasoning behind a summary is not shown
      if (meta.parentToolUseId) {
        // A subagent's reasoning stays out of the main transcript; its own view shows it
        const task = trackTaskText(s, meta.parentToolUseId, 'thought', text);
        if (task) this.emitTaskText(s.id, task, text);
        return;
      }
      const turn = ensureAgentTurn(s);
      turn.thoughts = (turn.thoughts || '') + text;
      appendTextSegment(turn, 'thought', text);
      this.emit('sessionStream', { sessionId: s.id, type: 'thought', text, turn: withoutToolCalls(turn) });
    });

    host.on('message', (text: string, meta: ChunkMeta) => {
      const s = store.get(session.id);
      if (!s) return;
      const run = this.compactionRuns.get(session.id);
      if (run) {
        // The handoff summary; kept out of the transcript and shown in the compaction's card
        if (!meta.parentToolUseId) run.text += text;
        return;
      }
      if (meta.parentToolUseId) {
        // A subagent's reply belongs to the call that spawned it, not the main thread.
        const owner = findToolCall(s, meta.parentToolUseId);
        const task = trackTaskText(s, meta.parentToolUseId, 'text', text, meta.messageId);
        if (owner) owner.call.subagentText = appendSubagentText(owner.call.subagentText, text);
        // Only the chunk goes out, as for the main thread; resending the whole call or task per chunk grows with its length
        if (task) this.emitTaskText(s.id, task, text, owner?.call.id);
        else if (owner) this.emit('sessionStream', { sessionId: s.id, type: 'toolCallUpdate', toolCall: owner.call, turn: owner.turn });
        return;
      }
      const turn = ensureAgentTurn(s);
      // A new messageId starts a new message; join with a paragraph break so the
      // aggregate content doesn't glue sentences together ("…instead.I'll…").
      const startsNewMessage = Boolean(turn.content) && !continuesLastText(turn, meta.messageId);
      turn.content = (turn.content || '') + (startsNewMessage && !turn.content!.endsWith('\n') ? '\n\n' : '') + text;
      appendTextSegment(turn, 'text', text, meta.messageId);
      // The recap previews the agent's latest message, not the start of the turn.
      const latest = (turn.segments!.filter((seg) => seg.kind === 'text').pop() as { text: string } | undefined)?.text || turn.content;
      s.recap = latest.trim().replace(/\s+/g, ' ').slice(0, 160) + (latest.length > 160 ? '…' : '');
      this.emit('sessionStream', { sessionId: s.id, type: 'message', text, turn: withoutToolCalls(turn) });
    });

    host.on('toolCall', (record: ToolCallRecord) => {
      const s = store.get(session.id);
      if (!s) return;
      // A subagent's calls can arrive after the parent's turn has ended; keep
      // them with the turn that holds the spawning call.
      const owner = record.parentToolUseId ? findToolCall(s, record.parentToolUseId) : null;
      // A call made while compacting stays with the compaction's turn, out of the reply flow
      const run = this.compactionRuns.get(session.id);
      const compactionTurn = !owner && run ? s.turns.find((t) => t.id === run.turnId) : undefined;
      const turn = owner ? owner.turn : compactionTurn ?? ensureAgentTurn(s);
      turn.toolCalls = turn.toolCalls || [];
      turn.toolCalls.push(record);
      if (!record.parentToolUseId && !compactionTurn) {
        turn.segments = turn.segments || [];
        turn.segments.push({ kind: 'tool', id: `seg-${record.id}`, toolCallId: record.id });
      }
      const agentTasks = this.agentTasksChanged(s.id, trackToolCall(s, record));
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'toolCall', toolCall: record, turn, agentTasks });
    });

    host.on('toolCallUpdate', (record: ToolCallRecord) => {
      const s = store.get(session.id);
      if (!s) return;
      const owner = findToolCall(s, record.id);
      if (!owner) return;
      const patch = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
      Object.assign(owner.call, patch);
      const agentTasks = this.agentTasksChanged(s.id, trackToolCallUpdate(s, owner.call));
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'toolCallUpdate', toolCall: owner.call, turn: owner.turn, agentTasks });
    });

    // Background shells and other async work settle after their tool call has
    // completed; the task's final state is what ends the "Background" status.
    const taskCalls = new Map<string, string>();
    const taskOutputs = new Map<string, string>();
    host.on('asyncTask', (u: AsyncTaskUpdate) => {
      if (u.toolCallId) taskCalls.set(u.asyncTaskId, u.toolCallId);
      const callId = u.toolCallId ?? taskCalls.get(u.asyncTaskId);
      const s = store.get(session.id);
      if (!s) return;
      // Every task gets a record, even one no tool call can be matched to
      const idsBefore = (s.agentTasks || []).map((t) => t.id);
      const task = trackAsyncTask(s, u, callId && findToolCall(s, callId) ? callId : undefined);
      // A duplicate record merged into this one is gone; the client must drop it too
      const removed = idsBefore.filter((id) => !s.agentTasks?.some((t) => t.id === id));
      const removedAgentTaskIds = removed.length > 0 ? removed : undefined;
      const owner = callId ? findToolCall(s, callId) : null;
      if (!owner) {
        if (task) {
          store.save(s, { touch: false });
          this.emit('sessionStream', { sessionId: s.id, type: 'agentTask', agentTasks: [task], removedAgentTaskIds });
          this.recheckAutoCompact(s.id);
        }
        return;
      }
      const call = owner.call;
      call.background = true;
      if (u.outputFilePath) taskOutputs.set(u.asyncTaskId, u.outputFilePath);
      if (u.state && u.state !== 'running') {
        call.backgroundState = u.state;
        call.backgroundEndedAt = Date.now();
        if (u.summary) call.backgroundSummary = u.summary;
        // The call's own output is only "running in background with ID …"; show what it printed
        const output = readTaskOutput(u.outputFilePath ?? taskOutputs.get(u.asyncTaskId));
        if (output !== undefined) call.output = output;
      } else if (!call.backgroundState) {
        call.backgroundState = 'running';
      }
      if (task) trackToolCallUpdate(s, call);
      store.save(s, { touch: false });
      // Not 'toolCallUpdate': the turn may be long over, and that event marks the session working
      this.emit('sessionStream', { sessionId: s.id, type: 'backgroundUpdate', toolCall: call, turn: owner.turn, agentTasks: task ? [task] : undefined, removedAgentTaskIds });
      this.recheckAutoCompact(s.id);
    });

    host.on('plan', (entries: PlanEntry[]) => {
      const s = store.get(session.id);
      if (!s) return;
      s.plan = entries;
      store.save(s);
      this.emit('sessionStream', { sessionId: s.id, type: 'plan', plan: entries, session: { plan: entries } });
    });

    host.on('agentOptions', (options: AgentOptions) => {
      const s = store.get(session.id);
      if (!s) return;
      s.agentOptions = options;
      // Cache under the stored model id only when the agent is actually running that model
      const runningStored = !options.currentModel || resolveModelValue(s.model, options.models) === options.currentModel;
      rememberAgentOptions(s.agentId, runningStored ? s.model : undefined, options);
      const note = reconcileEffort(s, options);
      store.save(s, { touch: false });
      this.emit('sessionStream', {
        sessionId: s.id,
        type: 'agentOptions',
        session: { agentOptions: options, effort: s.effort },
        ...(note ? { turn: note } : {}),
      });
    });

    host.on('contextWindow', (size: number) => {
      const s = store.get(session.id);
      if (!s || s.contextWindow === size) return;
      s.contextWindow = size;
      store.save(s, { touch: false });
      this.emit('sessionStream', { sessionId: s.id, type: 'contextWindow', session: { contextWindow: size } });
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

    host.on('permissionResolved', (permId: string, info?: { cancelled: boolean }) => {
      const s = store.get(session.id);
      if (!s) return;
      s.pendingPermission = null;
      if (!info?.cancelled) s.state = 'working';
      store.save(s);
      this.emit('permissionResolved', { sessionId: s.id, permId });
      this.emit('sessionsUpdated', this.listSessions());
    });

    host.on('turnCompleted', () => {
      const s = store.get(session.id);
      if (!s) return;
      activeAgentTurn = null;
      // The compaction settles its own state, and must not count as a fresh reply
      if (this.compactionRuns.has(session.id)) return;
      s.state = 'needs_you';
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
      if (this.compactionRuns.has(session.id)) {
        // Reported on the compaction's card when its prompt fails
        activeAgentTurn = null;
        return;
      }
      s.state = 'needs_you';
      s.pendingPermission = null;
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

    host.on('compaction', (u: CompactionEvent) => {
      if (this.applyCompactionUpdate(session.id, u)) activeAgentTurn = null;
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
      // Only the registered host may clear the session; a replaced host's exit must not orphan its successor
      if (this.activeHosts.get(session.id) !== host) return;
      this.activeHosts.delete(session.id);
      this.activePrompts.delete(session.id);
      activeAgentTurn = null;
      this.settleAgentCompactions(session.id, 'Stopped when the agent exited');
      this.settleBackgroundWork(session.id, 'Stopped when the agent exited');
      const s = store.get(session.id);
      if (s && (s.state === 'working' || s.state === 'blocked' || s.pendingPermission)) {
        s.state = 'needs_you';
        s.pendingPermission = null;
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted' });
        this.emit('sessionsUpdated', this.listSessions());
      }
    });

    return host;
  }

  async sendPrompt(sessionId: string, promptText: string, attachments?: FileAttachment[]): Promise<void> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    // One turn at a time: the web client cancels the running turn before sending ("Send & Interrupt")
    if (this.isTurnInFlight(sessionId)) throw new TurnInFlightError();
    const seq = ++this.promptSeq;
    this.activePrompts.set(sessionId, seq);
    // This turn's own end decides about compaction now
    this.autoCompactAfterBackground.delete(sessionId);

    // Process and save any attachments to disk
    const savedAttachments: FileAttachment[] = [];
    if (attachments && attachments.length > 0) {
      const uploadDir = path.join(getUploadsDir(), sessionId);
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
    session.agentStopped = false;
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

    let endedCleanly = false;
    let turnStopReason: string | undefined;
    try {
      const host = await this.ensureHost(session);
      const { stopReason } = await host.sendPrompt(promptToSendToHost, savedAttachments);
      turnStopReason = stopReason;
      endedCleanly = stopReason === 'end_turn';
    } catch (err: any) {
      // Host torn down by stop/switch/rollback/delete: that action already updated the session
      if (err instanceof HostClosedError && err.byShutdown) return;
      console.error(`[session-mgr] Error executing prompt for ${sessionId}:`, err);
      const s = store.get(sessionId);
      if (s && this.activePrompts.get(sessionId) === seq) {
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
      // ABSOLUTE GUARANTEE: The session is NEVER left in 'working' status when sendPrompt ends,
      // unless a newer prompt now owns the session
      const owned = this.activePrompts.get(sessionId) === seq;
      if (owned) this.activePrompts.delete(sessionId);
      const s = owned ? store.get(sessionId) : null;
      if (s && (s.state === 'working' || s.state === 'crashed')) {
        s.state = 'needs_you';
        store.save(s);
        this.emit('sessionStream', { sessionId: s.id, type: 'turnCompleted', session: s });
        this.emit('sessionsUpdated', this.listSessions());
      }
      // A stopped or failed turn leaves the queue alone so the user decides what happens next
      if (owned && endedCleanly) this.sendNextQueued(sessionId);
      // "Compact when finished" goes after the queue has drained, never between queued messages
      if (owned) this.maybeAutoCompact(sessionId, turnStopReason);
    }
  }

  /** Queue a message behind the running turn, or send it straight away when nothing is running. */
  async queuePrompt(sessionId: string, text: string, attachments?: FileAttachment[]): Promise<{ queued: boolean }> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!this.isTurnInFlight(sessionId) && !session.queuedPrompts?.length) {
      this.runPrompt(sessionId, text, attachments);
      return { queued: false };
    }
    const item: QueuedPrompt = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      attachments: attachments?.length ? attachments : undefined,
      queuedAt: Date.now(),
    };
    session.queuedPrompts = [...(session.queuedPrompts || []), item];
    this.saveQueue(session);
    return { queued: true };
  }

  updateQueuedPrompt(sessionId: string, queueId: string, text: string): AcpSession {
    const session = this.requireQueued(sessionId, queueId);
    session.queuedPrompts = session.queuedPrompts!.map((q) => (q.id === queueId ? { ...q, text } : q));
    this.saveQueue(session);
    return session;
  }

  removeQueuedPrompt(sessionId: string, queueId: string): AcpSession {
    const session = this.requireQueued(sessionId, queueId);
    session.queuedPrompts = session.queuedPrompts!.filter((q) => q.id !== queueId);
    this.saveQueue(session);
    return session;
  }

  /** Stop the running turn, if any, and send this queued message now. */
  async sendQueuedNow(sessionId: string, queueId: string): Promise<void> {
    const session = this.requireQueued(sessionId, queueId);
    const item = session.queuedPrompts!.find((q) => q.id === queueId)!;
    if (this.isTurnInFlight(sessionId)) await this.cancelPrompt(sessionId);
    const fresh = store.get(sessionId)!;
    fresh.queuedPrompts = (fresh.queuedPrompts || []).filter((q) => q.id !== queueId);
    this.saveQueue(fresh);
    this.runPrompt(sessionId, item.text, item.attachments);
  }

  private sendNextQueued(sessionId: string): void {
    const session = store.get(sessionId);
    const next = session?.queuedPrompts?.[0];
    if (!session || !next || this.isTurnInFlight(sessionId)) return;
    session.queuedPrompts = session.queuedPrompts!.slice(1);
    this.saveQueue(session);
    this.runPrompt(sessionId, next.text, next.attachments);
  }

  private runPrompt(sessionId: string, text: string, attachments?: FileAttachment[]): void {
    this.sendPrompt(sessionId, text, attachments).catch((err) => {
      console.error(`[session-mgr] Error executing prompt for ${sessionId}:`, err);
    });
  }

  private requireQueued(sessionId: string, queueId: string): AcpSession {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.queuedPrompts?.some((q) => q.id === queueId)) throw new QueuedPromptNotFoundError();
    return session;
  }

  private saveQueue(session: AcpSession): void {
    session.updatedAt = Date.now();
    store.save(session);
    // Always an array so the client's shallow merge clears an emptied queue
    this.emit('sessionStream', { sessionId: session.id, type: 'queueUpdated', session: { queuedPrompts: session.queuedPrompts || [] } });
    this.emit('sessionsUpdated', this.listSessions());
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
    // Settle it now: its prompt may resolve after the next message has already started
    const run = this.compactionRuns.get(sessionId);
    if (run) this.finishCompaction(sessionId, run, { stopReason: 'cancelled' });
    this.activePrompts.delete(sessionId);
    const session = store.get(sessionId);
    if (session) {
      session.state = 'needs_you';
      session.pendingPermission = null;
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
    if (host?.isTurnInFlight) {
      await host.cancel().catch(() => {});
    }
    this.dropHost(sessionId);
    ptyManager.release(`session-term-${sessionId}`);

    session.state = 'parked';
    session.agentStopped = true;
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
    session.agentStopped = false;
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

    if (!hasAgent(newAgentId)) throw new Error(`Unknown agent: ${newAgentId}`);
    const prevAgentName = session.agentName;
    const targetAgent = getAgent(newAgentId);
    let targetModel = newModel || targetAgent.defaultModel;
    if (targetAgent.id === 'claude') {
      targetModel = normalizeClaudeModel(targetModel);
    }

    // Same agent, and it can switch models while running: keep the process and its conversation
    const liveHost = targetAgent.id === session.agentId ? this.activeHosts.get(sessionId) : undefined;
    if (liveHost?.canSwitchModel) {
      try {
        return await this.switchModelLive(session, liveHost, targetModel, newEffort);
      } catch (err: any) {
        if (!(err instanceof HostClosedError)) {
          throw new Error(`${targetAgent.name.replace(/ \(ACP\)$/, '')} did not accept model ${targetModel}: ${err.message}`);
        }
        // The agent exited meanwhile: fall through to a restart with a handover
      }
    }

    // Shutdown previous host process so new host can be spun up on next turn
    this.dropHost(sessionId);
    if (targetAgent.id !== session.agentId || targetModel !== session.model) {
      // Choices and window belong to the old model; the new one reports its own when it starts
      session.agentOptions = cachedAgentOptions(targetAgent.id, targetModel);
      session.contextWindow = undefined;
    }

    session.agentId = targetAgent.id;
    session.agentName = targetAgent.name;
    session.model = targetModel;
    if (newEffort !== undefined) {
      session.effort = newEffort;
    }

    session.contextMode = contextMode;
    const hasPriorTurns = session.turns.some((t) => t.role === 'user' || t.role === 'agent') || latestCompaction(session.turns) !== null;
    session.contextHandoffPending = contextMode !== 'none' && hasPriorTurns;

    // Reset crashed, blocked, or working state since old host is shutdown
    if (session.state === 'crashed' || session.state === 'blocked' || session.state === 'working') {
      session.state = 'needs_you';
      session.pendingPermission = null;
    }

    // A level the new model is known not to offer falls back to Auto (the agent's report settles unknown models)
    const effortNote = session.agentOptions ? reconcileEffort(session, session.agentOptions) : null;
    const effortLabel = session.effort && session.effort !== AUTO_EFFORT ? ` [Effort: ${session.effort}]` : '';
    const contextLabel = session.contextHandoffPending ? ` [Context: ${contextMode}]` : '';
    // Record an informative system event in the conversation
    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: `Switched model to ${targetModel || targetAgent.name}${effortLabel}${contextLabel}`,
      timestamp: Date.now(),
    });
    if (effortNote) {
      // Keep the note after the switch line it explains
      session.turns.splice(session.turns.indexOf(effortNote), 1);
      session.turns.push(effortNote);
    }

    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionSwitched', session });

    return session;
  }

  /**
   * Model switch within the running agent (ACP set_config_option): the process and its
   * conversation stay, so no handover is needed.
   */
  private async switchModelLive(
    session: AcpSession,
    host: AcpClientHost,
    targetModel: string | undefined,
    newEffort: ThinkingEffort | undefined
  ): Promise<AcpSession> {
    const sessionId = session.id;
    // The new model's choices arrive during applyModel and may add an effort note; it goes after this line
    const switchLineAt = session.turns.length;
    if (targetModel && targetModel !== session.model) {
      await host.applyModel(targetModel);
      session.model = targetModel;
      // The agent reports the new window with its next usage
      session.contextWindow = undefined;
    }
    session.turns.splice(switchLineAt, 0, {
      id: `sys-${Date.now()}`,
      role: 'system',
      content: `Switched model to ${targetModel || session.agentName} (same conversation)`,
      timestamp: Date.now(),
    });
    // applyModel already reported the new model's choices, which reset an unsupported level to Auto
    if (newEffort !== undefined && newEffort !== session.effort) {
      const options = host.options;
      const supported = newEffort === AUTO_EFFORT || Boolean(options?.efforts.some((e) => e.value === newEffort));
      if (supported) {
        if (options?.effortConfigId) await host.applyEffort(newEffort);
        session.effort = newEffort;
      }
    }
    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionSwitched', session });
    return session;
  }

  /**
   * Set thinking / reasoning effort for a session. A running agent takes it at once and
   * keeps its conversation; otherwise it is stored and applied when the agent starts.
   */
  async setSessionEffort(sessionId: string, effort: ThinkingEffort): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const host = this.activeHosts.get(sessionId);
    if (host?.options?.effortConfigId) {
      // Throws when the agent rejects it, leaving the stored effort as it was
      await host.applyEffort(effort);
    } else {
      // Still starting: it may already be past applying the old effort, so apply once it is up
      this.startingHosts.get(sessionId)?.promise
        .then((h) => (h.options?.effortConfigId && store.get(sessionId)?.effort === effort ? h.applyEffort(effort) : undefined))
        .catch((err) => console.warn(`[session-mgr] Effort not applied to ${sessionId}: ${err.message}`));
    }
    session.effort = effort;

    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionEffortUpdated', effort, session });

    return session;
  }

  /**
   * Compact the session's context. An agent with its own compaction (it offers a `compact`
   * command, as Claude Code and Codex do) runs it inside the same agent session. Any other
   * agent is asked for a handoff summary and then restarted; the summary is the first
   * context the next prompt carries. Earlier turns stay in the transcript: the compaction's
   * system turn marks the boundary. Returns at once; progress streams as 'compaction' events.
   */
  async compactSession(sessionId: string, opts: { trigger?: 'manual' | 'auto' } = {}): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (this.compactionRuns.has(sessionId)) return session;
    if (this.isTurnInFlight(sessionId)) throw new TurnInFlightError('Wait for the current turn to finish before compacting');

    let lastBoundary = -1;
    session.turns.forEach((t, i) => {
      if (t.compaction?.status === 'completed' || (t.role === 'system' && !t.compaction && t.id.startsWith('compact-'))) lastBoundary = i;
    });
    if (!session.turns.slice(lastBoundary + 1).some((t) => t.role === 'agent')) throw new NothingToCompactError();

    const host = this.activeHosts.get(sessionId);
    // A pending handoff means the running agent has not been given the conversation yet
    // (e.g. restarted with Start agent), so it has nothing of its own to compact
    const hostHasContext = Boolean(host) && !session.contextHandoffPending;
    const method: CompactionRecord['method'] = hostHasContext && host!.availableCommands.includes('compact') ? 'native' : 'handoff';
    // The handoff restarts the agent, which would cut off work it still runs in the background
    if (method === 'handoff' && host && hasRunningBackground(session)) {
      throw new Error('Background work is still running; compact once it has finished');
    }

    const trigger = opts.trigger ?? 'manual';
    const compaction: CompactionRecord = {
      status: 'running',
      method,
      trigger,
      startedAt: Date.now(),
      preTokens: session.usage.contextTokens || undefined,
    };
    const turn: TurnMessage = { id: `compact-${Date.now()}`, role: 'system', content: compactionLabel(compaction), timestamp: Date.now(), compaction };
    session.turns.push(turn);
    // It owns the session like a prompt does, so messages sent meanwhile are queued behind it
    const seq = ++this.promptSeq;
    this.activePrompts.set(sessionId, seq);
    const run: CompactionRun = { turnId: turn.id, method, seq, text: '' };
    this.compactionRuns.set(sessionId, run);
    // An automatic one is housekeeping after a finished turn, not new activity to rank on
    store.save(session, { touch: trigger === 'manual' });
    this.emit('sessionStream', { sessionId, type: 'compaction', turn });
    this.emit('sessionsUpdated', this.listSessions());

    void this.runCompaction(sessionId, run);
    return session;
  }

  private async runCompaction(sessionId: string, run: CompactionRun): Promise<void> {
    let outcome: { stopReason?: string; error?: string };
    try {
      const session = store.get(sessionId);
      if (!session) return;
      const needsHistory = !this.activeHosts.has(sessionId) || Boolean(session.contextHandoffPending);
      const host = await this.ensureHost(session);
      if (this.compactionRuns.get(sessionId) !== run) return;
      let prompt = '/compact';
      if (run.method === 'handoff') {
        prompt = HANDOFF_SUMMARY_PROMPT;
        // A freshly started agent has none of the conversation yet: give it what there is to summarise
        if (needsHistory) {
          const history = formatSessionHistory(session.turns.filter((t) => t.id !== run.turnId), { compact: false, maxTurns: 20 });
          if (history) prompt = `${history}\n\n${prompt}`;
        }
        // The agent now has the history; the next prompt must not send it again
        const s = store.get(sessionId);
        if (s?.contextHandoffPending) {
          s.contextHandoffPending = false;
          store.save(s, { touch: false });
        }
      }
      const { stopReason } = await host.sendPrompt(prompt);
      outcome = { stopReason };
    } catch (err: any) {
      outcome =
        err instanceof HostClosedError && err.byShutdown
          ? { stopReason: 'cancelled' }
          : { stopReason: 'error', error: err?.message || String(err) };
    }
    this.finishCompaction(sessionId, run, outcome);
  }

  /** Close a compaction run with how its prompt ended. Later calls for the same run do nothing. */
  private finishCompaction(sessionId: string, run: CompactionRun, outcome: { stopReason?: string; error?: string }): void {
    if (this.compactionRuns.get(sessionId) !== run) return;
    this.compactionRuns.delete(sessionId);
    const owned = this.activePrompts.get(sessionId) === run.seq;
    if (owned) this.activePrompts.delete(sessionId);
    const s = store.get(sessionId);
    if (!s) return;
    const turn = s.turns.find((t) => t.id === run.turnId);
    const c = turn?.compaction;
    if (turn && c) {
      // A native run may already have been settled by the agent's own lifecycle updates
      if (c.status === 'running') {
        if (outcome.stopReason === 'end_turn') {
          const summary = run.method === 'handoff' ? capSummary(run.text) : '';
          // A native run the agent never reported on compacted nothing (e.g. an empty conversation)
          if (run.method === 'native') Object.assign(c, run.agentCompactionId ? { status: 'completed' } : { status: 'failed', error: 'The agent did not report a compaction' });
          else if (summary) Object.assign(c, { status: 'completed', summary });
          else Object.assign(c, { status: 'failed', error: 'The agent did not write a summary' });
        } else if (outcome.stopReason === 'cancelled') {
          c.status = 'cancelled';
        } else {
          c.status = 'failed';
          c.error = outcome.error || `The agent stopped (${outcome.stopReason ?? 'no reason given'})`;
        }
      }
      c.endedAt ??= Date.now();
      if (c.summary) c.summary = capSummary(c.summary);
      if (c.status === 'completed' && c.postTokens === undefined) {
        if (run.method === 'handoff' && c.summary) {
          // Roughly what the restarted agent starts with: the summary, at ~4 characters a token
          c.postTokens = Math.ceil(c.summary.length / 4);
          c.postTokensEstimated = true;
        } else if (s.usage.contextTokens && s.usage.contextTokens !== c.preTokens) {
          c.postTokens = s.usage.contextTokens;
        }
      }
      turn.content = compactionLabel(c);
    }
    if (c?.status === 'completed' && run.method === 'handoff') {
      // Restart: the next prompt starts a fresh agent with the summary as its first context
      this.dropHost(sessionId);
      s.contextHandoffPending = true;
      s.usage = { ...s.usage, contextTokens: c.postTokens ?? 0 };
    }
    // The turn before it already asked for the user; the compaction itself does not
    if (s.state === 'working') s.state = 'needs_you';
    store.save(s, { touch: false });
    this.emit('sessionStream', { sessionId, type: 'sessionCompacted', turn, session: { usage: s.usage } });
    this.emit('sessionsUpdated', this.listSessions());
    // Messages queued while it ran go out now, as after any clean turn
    if (owned && outcome.stopReason === 'end_turn') this.sendNextQueued(sessionId);
  }

  /**
   * A compaction lifecycle update from the agent. During our native run it fills in that
   * run's card; otherwise the agent compacted on its own (e.g. Claude near a full window)
   * and gets a card of its own. Returns true when a card was added, so the reply that
   * follows starts below it.
   */
  private applyCompactionUpdate(sessionId: string, u: CompactionEvent): boolean {
    const s = store.get(sessionId);
    if (!s) return false;
    const run = this.compactionRuns.get(sessionId);
    let added = false;
    let turn: TurnMessage | undefined;
    if (run?.method === 'native' && (!run.agentCompactionId || run.agentCompactionId === u.compactionId)) {
      run.agentCompactionId = u.compactionId;
      turn = s.turns.find((t) => t.id === run.turnId);
    } else {
      const key = `${sessionId}:${u.compactionId}`;
      const known = this.agentCompactions.get(key);
      turn = known ? s.turns.find((t) => t.id === known) : undefined;
      if (!turn) {
        if (!u.status) return false; // a summary chunk for a compaction never seen starting
        const compaction: CompactionRecord = {
          status: 'running',
          method: 'native',
          trigger: 'agent',
          startedAt: Date.now(),
          preTokens: s.usage.contextTokens || undefined,
        };
        turn = { id: `compact-${Date.now()}`, role: 'system', content: '', timestamp: Date.now(), compaction };
        s.turns.push(turn);
        this.agentCompactions.set(key, turn.id);
        added = true;
      }
    }
    const c = turn?.compaction;
    if (!turn || !c) return false;
    if (u.summaryChunk) c.summary = (c.summary || '') + u.summaryChunk;
    if (u.summary !== undefined) c.summary = u.summary;
    if (u.error) c.error = u.error;
    if (u.preTokens !== undefined) c.preTokens = u.preTokens;
    if (u.postTokens !== undefined) c.postTokens = u.postTokens;
    if (u.status && u.status !== 'in_progress' && c.status === 'running') {
      c.status = u.status;
      c.endedAt = Date.now();
      if (c.summary) c.summary = capSummary(c.summary);
    }
    // Summary chunks stream in quickly; the next status update carries them to disk and the UI
    if (!u.status && !added) return false;
    turn.content = compactionLabel(c);
    store.save(s, { touch: false });
    this.emit('sessionStream', { sessionId, type: 'compaction', turn });
    return added;
  }

  /** Start "Compact when finished" when the turn that just ended qualifies. */
  private maybeAutoCompact(sessionId: string, stopReason?: string): void {
    const s = store.get(sessionId);
    if (!s?.autoCompact?.enabled || this.isTurnInFlight(sessionId) || this.compactionRuns.has(sessionId)) return;
    const decision = autoCompactDecision({
      setting: s.autoCompact,
      stopReason,
      queuedCount: s.queuedPrompts?.length ?? 0,
      backgroundRunning: hasRunningBackground(s),
      pendingPermission: Boolean(s.pendingPermission),
      contextTokens: s.usage.contextTokens,
      contextWindow: contextWindowFor(s),
    });
    if (!decision.compact) {
      if (decision.waitForBackground) this.autoCompactAfterBackground.set(sessionId, stopReason);
      return;
    }
    console.log(`[session-mgr] Compacting ${sessionId} after its turn: ${decision.reason}`);
    this.compactSession(sessionId, { trigger: 'auto' }).catch((err) => {
      console.warn(`[session-mgr] Automatic compaction of ${sessionId} not started: ${err.message}`);
    });
  }

  /** Decide again for a turn whose compaction waited on background work, once none is left running. */
  private recheckAutoCompact(sessionId: string): void {
    if (!this.autoCompactAfterBackground.has(sessionId)) return;
    const s = store.get(sessionId);
    if (s && hasRunningBackground(s)) return;
    const stopReason = this.autoCompactAfterBackground.get(sessionId);
    this.autoCompactAfterBackground.delete(sessionId);
    if (s) this.maybeAutoCompact(sessionId, stopReason);
  }

  /** Set "Compact when finished" for a session; the choice becomes the default for new sessions too. */
  setAutoCompact(sessionId: string, setting: AutoCompactSetting): AcpSession {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.autoCompact = setting;
    store.save(session, { touch: false });
    writeAutoCompactDefault(setting);
    this.emit('sessionStream', { sessionId, type: 'autoCompactUpdated', session: { autoCompact: setting } });
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
    this.dropHost(sessionId);

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
    this.dropHost(sessionId);
    ptyManager.release(`session-term-${sessionId}`);
    const res = store.delete(sessionId);
    if (res) {
      // Attachments are stored per session under uploads/<sessionId>
      try {
        const uploadsBase = getUploadsDir();
        const uploadDir = path.resolve(uploadsBase, sessionId);
        if (path.dirname(uploadDir) === path.resolve(uploadsBase)) {
          fs.rmSync(uploadDir, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn(`[session-mgr] Failed to remove uploads for ${sessionId}:`, err);
      }
      this.emit('sessionsUpdated', this.listSessions());
    }
    return res;
  }

  shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const id of [...this.activeHosts.keys(), ...this.startingHosts.keys()]) {
      this.dropHost(id);
    }
    // Agent terminals go with their hosts; this also ends the interactive session shells
    ptyManager.releaseAll();
  }
}

export const sessionManager = new SessionManager();

/** Appends streamed text to the turn's last segment of the same kind and message, or starts a new one. */
function appendTextSegment(turn: TurnMessage, kind: 'text' | 'thought', text: string, messageId?: string): void {
  const segments = (turn.segments = turn.segments || []);
  const last = segments[segments.length - 1];
  if (last && last.kind === kind && (kind === 'thought' || continuesLastText(turn, messageId))) {
    last.text += text;
    return;
  }
  const id = `seg-${Date.now().toString(36)}-${segments.length}`;
  segments.push(kind === 'text' ? { kind, id, text, messageId } : { kind, id, text });
}

/**
 * The turn as sent with each text chunk. Tool calls (and their output) are left
 * out because a chunk never changes them and the client merges the turn into
 * its copy, keeping the tool calls it already has.
 */
function withoutToolCalls(turn: TurnMessage): Omit<TurnMessage, 'toolCalls'> {
  const { toolCalls: _toolCalls, ...rest } = turn;
  return rest;
}

/** True when a text chunk extends the turn's last segment rather than starting a new message. */
function continuesLastText(turn: TurnMessage, messageId?: string): boolean {
  const last = turn.segments?.[turn.segments.length - 1];
  return last?.kind === 'text' && (last.messageId ?? null) === (messageId ?? null);
}

/** Finds a tool call anywhere in the session, newest turn first. */
const TASK_OUTPUT_READ_LIMIT = 256 * 1024;

/** The tail of a background task's output file, capped like any tool output. */
function readTaskOutput(file: string | undefined): string | undefined {
  // The adapter names files like <tmp>/…/tasks/<id>.output; read nothing else
  if (!file || !path.isAbsolute(file) || !file.endsWith('.output')) return undefined;
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TASK_OUTPUT_READ_LIMIT);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return capToolOutput(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Mark background work still running as stopped: it cannot outlive the agent process. */
function endBackgroundWork(s: AcpSession, reason: string): boolean {
  let changed = false;
  for (const turn of s.turns) {
    for (const call of turn.toolCalls || []) {
      if (call.background && (call.backgroundState ?? 'running') === 'running') {
        call.backgroundState = 'stopped';
        call.backgroundSummary = reason;
        call.backgroundEndedAt = Date.now();
        changed = true;
      }
    }
  }
  stopTranscriptWatchers(s.id);
  if (endAgentTasks(s, reason)) changed = true;
  return changed;
}

interface CompactionRun {
  turnId: string;
  method: CompactionRecord['method'];
  /** Prompt ownership, as in activePrompts. */
  seq: number;
  /** The agent's reply so far: the handoff summary. */
  text: string;
  /** The agent's own id for the compaction, once it reports one. */
  agentCompactionId?: string;
}

/** Background shells, workflows or async subagents still running after the turn ended. */
function hasRunningBackground(s: AcpSession): boolean {
  if (s.agentTasks?.some((t) => t.status === 'running')) return true;
  return s.turns.some((t) => t.toolCalls?.some((c) => c.background && (c.backgroundState ?? 'running') === 'running'));
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The compaction turn's text: what the card shows, and what search and older clients see. */
function compactionLabel(c: CompactionRecord): string {
  const who = c.trigger === 'auto' ? ' automatically' : c.trigger === 'agent' ? ' by the agent' : '';
  switch (c.status) {
    case 'running':
      return 'Compacting context…';
    case 'completed': {
      const tokens =
        c.preTokens && c.postTokens !== undefined
          ? `: ${kTokens(c.preTokens)} → ${c.postTokensEstimated ? '~' : ''}${kTokens(c.postTokens)} tokens`
          : '';
      return `Context compacted${who}${tokens}`;
    }
    case 'cancelled':
      return 'Compaction stopped';
    default:
      return `Compaction failed${c.error ? `: ${c.error}` : ''}`;
  }
}

function findToolCall(s: AcpSession, toolCallId: string): { turn: TurnMessage; call: ToolCallRecord } | null {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    const call = turn.toolCalls?.find((t) => t.id === toolCallId);
    if (call) return { turn, call };
  }
  return null;
}
