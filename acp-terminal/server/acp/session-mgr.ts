import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { store } from '../store.js';
import { getGitInfo } from '../git.js';
import { hasRunningBackground, isWorkingInBackground, rankSession, sortSessions } from '../rank.js';
import { getAgent, hasAgent, listAgents } from '../agents/registry.js';
import { AcpClientHost, HostClosedError, TurnInFlightError, capToolOutput, normalizeClaudeModel, type ChunkMeta, type CompactionEvent, type ElicitationOutcome } from './client-host.js';
import { describeElicitationAnswer, validateElicitationContent } from './elicitation.js';
import { HANDOFF_SUMMARY_PROMPT, autoCompactDecision, capSummary, contextWindowFor, latestCompaction, readAutoCompactDefault, writeAutoCompactDefault } from '../compaction.js';
import { ptyManager } from '../pty-manager.js';
import { getUploadsDir } from '../paths.js';
import { getClaudeRateLimits, updateClaudeRateLimitsFromSdk } from '../subscriptions.js';
import { cachedAgentOptions, effortChoicesFor, effortLabel, markNewModels, rememberAgentOptions, resolveModelValue } from './agent-options.js';
import { logQueueEvent } from '../queue-log.js';
import { appendSubagentText, completeAsyncSubagent, endAgentTasks, stopAgentTask, stopTranscriptWatchers, syncAgentTasks, trackAsyncTask, trackTaskText, trackToolCall, trackToolCallUpdate, watchSubagentTranscript } from './agent-tasks.js';
import { AUTO_EFFORT } from '../types.js';
import type { AcpSession, ParkedAgentResume, AgentCommand, TaskAudit, AutoCompactSetting, CompactionRecord, AgentOptions, AgentTask, AgentTaskTextDelta, AsyncTaskUpdate, QueuedPrompt, ContextTransferMode, ElicitationAction, ElicitationRecord, FileAttachment, PendingElicitation, PendingPermission, PlanEntry, SessionSummary, ThinkingEffort, ToolCallRecord, TurnMessage, UserAnnotations } from '../types.js';

/**
 * Format conversation history into a structured briefing block for context transfer.
 * In 'compact' mode, internal thoughts and raw tool outputs are omitted, and responses
 * are distilled into key decisions, file changes, and instructions to save token context.
 * `catchUp` is for an agent session continued after other agents (`by`) handled the
 * conversation: the turns are only the ones it missed, and the header says so.
 */
export function formatSessionHistory(
  turns: TurnMessage[],
  opts?: { compact?: boolean; maxTurns?: number; catchUp?: { by: string[] } }
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
  const catchUpBy = opts?.catchUp && (opts.catchUp.by.length > 0 ? opts.catchUp.by.join(' and ') : 'another agent');
  // A catch-up claims to cover everything since; when it is cut, it says how much is left out
  const leftOut = relevantTurns.length - slice.length;
  const catchUpTurns = leftOut > 0
    ? `These are the last ${slice.length} of the ${relevantTurns.length} turns since then (the ${leftOut} before them are left out)`
    : 'These are the turns since then';
  const lines: string[] = catchUpBy
    ? [
        `[Catch-up Since You Last Took Part (${compact ? 'Compacted' : 'Recent Turns'})]`,
        `You still have this conversation up to where you last took part. ${catchUpTurns}, while ${catchUpBy} handled the conversation:`,
      ]
    : [
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

/** The model to stamp on an agent turn: the one the agent runs when it refused the chosen one. */
function stampedModel(s: AcpSession, host: AcpClientHost): string | undefined {
  return host.modelRefused ? host.options?.currentModel ?? s.model : s.model;
}

/**
 * Say in the conversation that the agent refused the chosen model and which one it runs
 * instead. The choice stays on the session, so the next start tries it again; the note is
 * not repeated until the model is switched. Returns the note it added, or null.
 */
export function noteModelRefused(s: AcpSession, host: AcpClientHost, beforeTurnId?: string): TurnMessage | null {
  const refused = host.modelRefused;
  if (!refused) return null;
  const opts = host.options;
  const running = opts?.models.find((m) => m.value === opts.currentModel)?.label || opts?.currentModel || 'its default model';
  const content = `⚠️ ${s.agentName.replace(/ \(ACP\)$/, '')} did not accept model ${refused.model} (${refused.reason}), so it is running ${running}.`;
  const last = [...s.turns].reverse().find((t) => t.role === 'system' && (t.id.endsWith('-model') || t.content?.startsWith('Switched model to')));
  if (last?.content === content) return null;
  const now = Date.now();
  const note: TurnMessage = { id: `sys-${now}-model`, role: 'system', content, timestamp: now };
  const at = beforeTurnId ? s.turns.findIndex((t) => t.id === beforeTurnId) : -1;
  if (at === -1) s.turns.push(note);
  else s.turns.splice(at, 0, note);
  return note;
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

export class InvalidOptionError extends Error {}

/** An answer to a form that cannot be taken; `status` is the HTTP status that says why. */
export class ElicitationAnswerError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export class AgentNotRunningError extends Error {
  constructor() {
    super('The agent is stopped. Start it first, or compact anyway to resend recent turns for the summary');
  }
}

/** The running agent refused the model itself (set_config_option), as opposed to any later step of a switch. */
class ModelRefusedError extends Error {}

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
  /** Whether the sidebar was last told a session is working in the background. */
  private inBackground = new Map<string, boolean>();

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
  private dropHost(sessionId: string, reason = 'Stopped'): void {
    const running = this.activeHosts.get(sessionId);
    if (running?.sessionId) this.endAgentSession(sessionId, running.sessionId, reason);
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
    this.refreshBackgroundStatus(sessionId);
  }

  init(): void {
    store.init();
    // Recover any orphaned 'working' or 'crashed' sessions left behind by server restarts or crashes
    const sessions = store.getAll();
    for (const session of sessions) {
      if (session.agentId === 'claude' && session.model) {
        // A custom id is kept: the agent says at start whether it takes it
        const normalized = normalizeClaudeModel(session.model, session.model);
        if (session.model !== normalized) {
          session.model = normalized;
          store.save(session, { touch: false });
        }
      }
      // Default titles used to name the agent too; its icon says that now, so just the folder
      if (session.titleSource === 'auto' && isOldDefaultTitle(session.title, session.cwd)) {
        session.title = path.basename(session.cwd);
        store.save(session, { touch: false });
      }
      // Agent names used to end in "(ACP)", which told the user nothing
      if (renameOldAgentNames(session)) store.save(session, { touch: false });
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
              runningAgentName = 'Claude Code';
              runningModel = target.includes('opus') ? 'opus' : target.includes('haiku') ? 'haiku' : 'sonnet';
            } else if (target.includes('gemini') || target.includes('antigravity')) {
              runningAgentId = 'antigravity';
              runningAgentName = 'Google Antigravity';
              runningModel = target;
            } else if (target.includes('codex') || target.includes('luna') || target.includes('terra')) {
              runningAgentId = 'codex';
              runningAgentName = 'Codex CLI';
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
      // No agent survives a server restart, so a stored approval request or form can never be answered
      if (!host && clearPendingRequests(session)) {
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
      hasPendingElicitation: Boolean(s.pendingElicitation),
      pendingElicitationTitle: s.pendingElicitation ? oneLine(s.pendingElicitation.message) : undefined,
      tokenCount: s.usage.contextTokens || (s.usage.inputTokens + s.usage.outputTokens),
      turnCount: s.turns.length,
      model: s.model || getAgent(s.agentId)?.defaultModel,
      isAgentRunning: this.activeHosts.has(s.id),
      compacting: this.compactionRuns.has(s.id) || s.turns.some((t) => t.compaction?.status === 'running'),
      workingInBackground: isWorkingInBackground(s, s.state),
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
    s.canSteer = Boolean(this.activeHosts.get(s.id)?.supportsSteering);
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
    const session = store.get(sessionId);
    const host = this.activeHosts.get(sessionId) ?? this.startingHosts.get(sessionId)?.host;
    for (const task of tasks) {
      // Stamped once, when first seen: which agent, model and agent session it ran under. A task
      // older than the running agent (e.g. stopped when it exited) came from another run: left as is
      if (session && host && !task.audit?.agentId && task.startedAt >= host.createdAt) {
        task.audit = {
          ...task.audit,
          agentId: session.agentId,
          agentName: session.agentName,
          model: host.options?.currentModel ?? session.model,
          agentSessionId: host.sessionId ?? undefined,
        };
      }
      if (session && task.audit && !task.audit.transcriptPath) {
        const file = claudeSubagentTranscript(session, task.audit);
        if (file) task.audit.transcriptPath = file;
      }
    }
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
    /** An existing conversation owned by this agent to continue in this new CodePit session. */
    importAgentSessionId?: string;
  }): Promise<AcpSession> {
    if (!hasAgent(opts.agentId)) throw new Error(`Unknown agent: ${opts.agentId}`);
    const id = `acp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const agent = getAgent(opts.agentId);
    let model = opts.model || agent.defaultModel;
    if (agent.id === 'claude') {
      model = normalizeClaudeModel(model, model);
    }
    const git = await getGitInfo(opts.cwd);
    const folderName = path.basename(opts.cwd) || 'workspace';
    // The vendor icon already says which agent: the default title is just the folder
    const title = opts.title || folderName;
    const importAgentSessionId = opts.importAgentSessionId?.trim();
    if (importAgentSessionId && !isSafeImportedSessionId(importAgentSessionId)) {
      throw new Error('The agent session id contains unsupported characters');
    }
    // Two CodePit sessions continuing one agent session would write into the same conversation
    const owner = importAgentSessionId ? agentSessionOwner(agent.id, importAgentSessionId) : undefined;
    if (owner) throw new Error(`That agent session is already continued by the CodePit session "${owner.title}"`);

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
      // An imported conversation is deliberately only an agent resume, not a copy of its
      // transcript into CodePit. The source app remains the owner of that history.
      ...(importAgentSessionId
        ? { agentResume: { agentId: agent.id, sessionId: importAgentSessionId, cwd: opts.cwd, savedAt: Date.now() }, skipClaudeAdoption: true }
        : {}),
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

  /**
   * The running agent for a session, starting it if needed. A new start continues the saved
   * agent session when the agent can resume it; otherwise it is a new agent session, and
   * the next prompt hands it the conversation (contextHandoffPending). `beforeTurnId` places
   * the note about how it started before that turn (the prompt that caused the start).
   */
  private async ensureHost(session: AcpSession, opts: { beforeTurnId?: string } = {}): Promise<AcpClientHost> {
    const existing = this.activeHosts.get(session.id);
    if (existing) return existing;
    const starting = this.startingHosts.get(session.id);
    if (starting) return starting.promise;

    const host = this.createHost(session);
    host.resumeSessionId = resumableSessionId(session) ?? adoptClaudeSession(session, opts.beforeTurnId);
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
      if (current) {
        if (host.mcpInfo) current.mcp = host.mcpInfo;
        this.recordAgentStart(current, host, opts.beforeTurnId);
        noteModelRefused(current, host, opts.beforeTurnId);
        store.save(current, { touch: false });
        this.emit('sessionStream', {
          sessionId: current.id,
          type: 'agentSession',
          // Always an array so the client's shallow merge clears an emptied list
          session: { agentSessionId: current.agentSessionId, agentResume: current.agentResume, parkedAgentResumes: current.parkedAgentResumes ?? [], agentSessions: current.agentSessions, turns: current.turns },
        });
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
    host.mode = session.mode;
    host.fastMode = session.fastMode;

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
          model: stampedModel(s, host),
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

    host.on('agentOptions', (reported: AgentOptions) => {
      const s = store.get(session.id);
      if (!s) return;
      const options = markNewModels(s.agentId, reported);
      s.agentOptions = options;
      // Cache under the stored model id only when the agent is actually running that model
      const runningStored = !options.currentModel || resolveModelValue(s.model, options.models) === options.currentModel;
      rememberAgentOptions(s.agentId, runningStored ? s.model : undefined, options);
      const note = reconcileEffort(s, options);
      // Claude Code only runs ultracode on models with an xhigh level
      if (s.ultracode && options.efforts.length > 0 && !options.efforts.some((e) => e.value === 'xhigh')) s.ultracode = false;
      store.save(s, { touch: false });
      this.emit('sessionStream', {
        sessionId: s.id,
        type: 'agentOptions',
        session: { agentOptions: options, effort: s.effort, canSteer: host.supportsSteering, ultracode: s.ultracode },
        ...(note ? { turn: note } : {}),
      });
    });

    host.on('availableCommands', (commands: AgentCommand[]) => {
      const s = store.get(session.id);
      if (!s) return;
      s.agentCommands = commands;
      store.save(s, { touch: false });
      this.emit('sessionStream', { sessionId: s.id, type: 'agentCommands', session: { agentCommands: commands } });
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

    host.on('elicitationRequested', (asked: PendingElicitation) => {
      const s = store.get(session.id);
      if (!s) return;
      const record: ElicitationRecord = { requestId: asked.requestId, message: asked.message, fields: asked.fields, status: 'pending', requestedAt: asked.requestedAt };
      // The question goes on the call that asked it (Claude's AskUserQuestion), else on a card of its own
      let owner = findToolCall(s, asked.toolCallId);
      const e = owner ? asked : { ...asked, toolCallId: `elicitation:${asked.requestId}` };
      s.pendingElicitation = e;
      s.state = 'blocked';
      if (owner) {
        owner.call.elicitation = record;
      } else {
        const turn = ensureAgentTurn(s);
        const call: ToolCallRecord = {
          id: e.toolCallId,
          title: oneLine(e.message) || 'Question',
          kind: 'other',
          toolName: 'Question',
          status: 'pending',
          startedAt: e.requestedAt,
          elicitation: record,
        };
        turn.toolCalls = turn.toolCalls || [];
        turn.toolCalls.push(call);
        turn.segments = turn.segments || [];
        turn.segments.push({ kind: 'tool', id: `seg-${call.id}`, toolCallId: call.id });
        owner = { turn, call };
      }
      store.save(s);
      // Not 'toolCall': that event marks the session working, and it is waiting on the user
      this.emit('sessionStream', { sessionId: s.id, type: 'elicitation', toolCall: owner.call, turn: owner.turn, session: { pendingElicitation: e, state: s.state } });
      this.emit('elicitationRequested', { sessionId: s.id, elicitation: e });
      this.emit('sessionsUpdated', this.listSessions());
    });

    host.on('elicitationResolved', (requestId: string, outcome: ElicitationOutcome) => {
      const s = store.get(session.id);
      if (!s) return;
      if (s.pendingElicitation?.requestId === requestId) s.pendingElicitation = null;
      // Answered, or withdrawn by the agent, the turn carries on; a cancel from here ends it
      if ((outcome.action !== 'cancel' || outcome.withdrawn) && host.isTurnInFlight) s.state = 'working';
      const owner = findElicitationCall(s, requestId);
      if (owner) settleElicitationRecord(owner.call, outcome);
      store.save(s);
      if (owner) this.emit('sessionStream', { sessionId: s.id, type: 'elicitation', toolCall: owner.call, turn: owner.turn, session: { pendingElicitation: s.pendingElicitation ?? null, state: s.state } });
      this.emit('elicitationResolved', { sessionId: s.id, requestId, action: outcome.action });
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
      // The agent may outlive its failed turn: answer what it still waits on, not just the record
      host.cancelPendingRequests();
      clearPendingRequests(s);
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
          model: stampedModel(s, host),
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
      if (host.sessionId) this.endAgentSession(session.id, host.sessionId, 'The agent process exited');
      this.activeHosts.delete(session.id);
      this.activePrompts.delete(session.id);
      activeAgentTurn = null;
      this.settleAgentCompactions(session.id, 'Stopped when the agent exited');
      this.settleBackgroundWork(session.id, 'Stopped when the agent exited');
      const s = store.get(session.id);
      if (s && (s.state === 'working' || s.state === 'blocked' || s.pendingPermission || s.pendingElicitation)) {
        s.state = 'needs_you';
        clearPendingRequests(s);
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

    const savedAttachments = saveAttachments(sessionId, attachments);

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
    // Claude's keywords go to the agent, not into the transcript; a slash command takes none
    const keywords = isSlashCommand(promptText) ? [] : takeKeywords(session);
    const userTurn = session.turns[session.turns.length - 1];
    if (keywords.length > 0) userTurn.keywords = keywords;
    // /clear empties Claude's own context: continuing that session later would not bring it back
    if (promptText.trim() === '/clear') dropAgentResume(session, 'Context cleared by /clear');

    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());

    let endedCleanly = false;
    let turnStopReason: string | undefined;
    try {
      const host = await this.ensureHost(session, { beforeTurnId: userTurn.id });
      // Stopped or replaced while the agent was starting: the newer action owns the session now
      if (this.activePrompts.get(sessionId) !== seq) return;
      // A new agent session (not a continued one) gets the conversation so far with this prompt
      const promptWithAttachments = withKeywords(withAttachmentNotes(promptText, savedAttachments), keywords);
      let promptToSendToHost = promptWithAttachments;
      const current = store.get(sessionId);
      if (current?.contextHandoffPending) {
        const turns = handoffTurns(current, userTurn.id);
        const historyBlock = formatSessionHistory(turns, {
          compact: current.contextMode !== 'full',
          catchUp: catchUpFor(current, turns),
        });
        if (historyBlock) {
          promptToSendToHost = `${historyBlock}\n\n[Active User Request]\n${promptWithAttachments}`;
        }
        current.contextHandoffPending = false;
        delete current.catchUpAfterTurnId;
        store.save(current, { touch: false });
      }
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

  /**
   * Queue a message behind the running turn, or send it straight away when nothing is running.
   * A queue paused by a stopped or failed turn (or a server restart) does not hold a new message
   * back: it goes out now, and the paused queue follows once that turn ends cleanly.
   */
  async queuePrompt(sessionId: string, text: string, attachments?: FileAttachment[]): Promise<{ queued: boolean }> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!this.isTurnInFlight(sessionId)) {
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
    logQueueEvent(sessionId, 'queued', item);
    return { queued: true };
  }

  updateQueuedPrompt(sessionId: string, queueId: string, text: string): AcpSession {
    const session = this.requireQueued(sessionId, queueId);
    session.queuedPrompts = session.queuedPrompts!.map((q) => (q.id === queueId ? { ...q, text } : q));
    this.saveQueue(session);
    logQueueEvent(sessionId, 'edited', { id: queueId, text });
    return session;
  }

  removeQueuedPrompt(sessionId: string, queueId: string): AcpSession {
    const session = this.requireQueued(sessionId, queueId);
    const removed = session.queuedPrompts!.find((q) => q.id === queueId);
    session.queuedPrompts = session.queuedPrompts!.filter((q) => q.id !== queueId);
    this.saveQueue(session);
    if (removed) logQueueEvent(sessionId, 'removed', removed);
    return session;
  }

  /**
   * Send this queued message now. An agent that takes messages during a turn gets it added
   * to the running turn; otherwise the running turn, if any, is stopped first.
   */
  async sendQueuedNow(sessionId: string, queueId: string): Promise<void> {
    const session = this.requireQueued(sessionId, queueId);
    const item = session.queuedPrompts!.find((q) => q.id === queueId)!;
    if (this.canSteer(sessionId)) {
      await this.steerQueued(sessionId, item);
      return;
    }
    // Taken out before anything is awaited, so a second "Send now" finds it gone instead of sending it twice
    session.queuedPrompts = session.queuedPrompts!.filter((q) => q.id !== queueId);
    this.saveQueue(session);
    logQueueEvent(sessionId, 'sent-now', item);
    if (this.isTurnInFlight(sessionId)) await this.cancelPrompt(sessionId);
    this.runPrompt(sessionId, item.text, item.attachments, item);
  }

  /** A turn is running that the agent can take a message into (a compaction's run is not one). */
  private canSteer(sessionId: string): boolean {
    const host = this.activeHosts.get(sessionId);
    return Boolean(host?.supportsSteering && host.isTurnInFlight && this.activePrompts.has(sessionId) && !this.compactionRuns.has(sessionId));
  }

  private async steerQueued(sessionId: string, item: QueuedPrompt): Promise<void> {
    const host = this.activeHosts.get(sessionId)!;
    const session = store.get(sessionId)!;
    const saved = saveAttachments(sessionId, item.attachments);
    const keywords = isSlashCommand(item.text) ? [] : takeKeywords(session);
    // Recorded before it is sent, so the agent's answer to it lands below it
    const turn: TurnMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: item.text,
      attachments: saved.length > 0 ? saved : undefined,
      timestamp: Date.now(),
      agentId: session.agentId,
      agentName: session.agentName,
      model: session.model,
      ...(keywords.length > 0 ? { keywords } : {}),
    };
    session.turns.push(turn);
    session.lastPrompt = item.text;
    session.queuedPrompts = (session.queuedPrompts || []).filter((q) => q.id !== item.id);
    this.saveQueue(session);
    this.emit('sessionStream', { sessionId, type: 'turnAdded', turn });

    let outcome: Awaited<ReturnType<AcpClientHost['steer']>> | undefined;
    let failure: unknown;
    try {
      outcome = await host.steer(withKeywords(withAttachmentNotes(item.text, saved), keywords), saved);
    } catch (err) {
      failure = err;
    }
    if (outcome === 'injected' || outcome === 'startedNewTurn') {
      logQueueEvent(sessionId, 'steered', item, outcome);
      return;
    }
    logQueueEvent(sessionId, 'requeued', item, failure ? String((failure as Error).message || failure) : 'no turn was running');

    // Not delivered: take the message back out of the transcript and put it first in the queue
    const s = store.get(sessionId);
    if (s) {
      s.turns = s.turns.filter((t) => t.id !== turn.id);
      // Ultrathink was meant for this message, which has not gone out yet
      if (keywords.includes('ultrathink')) s.ultrathinkNext = true;
      s.queuedPrompts = [item, ...(s.queuedPrompts || []).filter((q) => q.id !== item.id)];
      this.saveQueue(s);
      this.emit('sessionStream', { sessionId, type: 'turnRemoved', session: { turns: s.turns } });
    }
    if (failure) throw failure;
    // The turn ended as it was sent: it goes out as the next prompt
    if (!this.isTurnInFlight(sessionId)) this.sendNextQueued(sessionId);
  }

  private sendNextQueued(sessionId: string): void {
    const session = store.get(sessionId);
    const next = session?.queuedPrompts?.[0];
    if (!session || !next || this.isTurnInFlight(sessionId)) return;
    session.queuedPrompts = session.queuedPrompts!.slice(1);
    this.saveQueue(session);
    logQueueEvent(sessionId, 'sent', next);
    this.runPrompt(sessionId, next.text, next.attachments, next);
  }

  /**
   * Send without waiting. A queued item that sendPrompt refused before recording it (a turn
   * still in flight) goes back to the front of the queue instead of being lost.
   */
  private runPrompt(sessionId: string, text: string, attachments?: FileAttachment[], fromQueue?: QueuedPrompt): void {
    this.sendPrompt(sessionId, text, attachments).catch((err) => {
      console.error(`[session-mgr] Error executing prompt for ${sessionId}:`, err);
      if (!fromQueue || !(err instanceof TurnInFlightError)) return;
      const s = store.get(sessionId);
      if (!s || s.queuedPrompts?.some((q) => q.id === fromQueue.id)) return;
      s.queuedPrompts = [fromQueue, ...(s.queuedPrompts || [])];
      this.saveQueue(s);
      logQueueEvent(sessionId, 'requeued', fromQueue, 'a turn was still running');
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
    // Claude's "approve and clear context" plan options restart Claude under the same session
    // id with an empty context; continuing that id later would bring the old context back
    if (optionId.startsWith('exit-plan-clear-')) {
      const s = store.get(sessionId);
      if (s?.agentResume) {
        delete s.agentResume;
        store.save(s, { touch: false });
      }
    }
    return host.resolvePermission(optionId);
  }

  /**
   * Answer the form the agent is waiting on: accept with the user's answers (checked against
   * the form first), decline to skip it, or cancel.
   */
  resolveElicitation(sessionId: string, requestId: string, action: ElicitationAction, content?: unknown): void {
    if (!store.get(sessionId)) throw new ElicitationAnswerError(`Session ${sessionId} not found`, 404);
    const pending = this.activeHosts.get(sessionId)?.pendingElicitation;
    if (!pending || pending.requestId !== requestId) throw new ElicitationAnswerError('That question was already answered or withdrawn', 409);
    let answer: ElicitationOutcome = { action };
    if (action === 'accept') {
      const checked = validateElicitationContent(pending.fields, content);
      if (!checked.ok) throw new ElicitationAnswerError(checked.error, 400);
      answer = { action, content: checked.content };
    }
    this.activeHosts.get(sessionId)!.resolveElicitation(requestId, answer);
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    // Let go of the turn before waiting on the agent: one that still ends cleanly (the agent
    // missed the cancel) must not start the next queued message, and once the wait is over
    // the entry may belong to a newer message
    this.activePrompts.delete(sessionId);
    const host = this.activeHosts.get(sessionId);
    if (host) {
      await host.cancel();
    }
    // Settle it now: its prompt may resolve after the next message has already started
    const run = this.compactionRuns.get(sessionId);
    if (run) this.finishCompaction(sessionId, run, { stopReason: 'cancelled' });
    const session = store.get(sessionId);
    if (session) {
      session.state = 'needs_you';
      clearPendingRequests(session);
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
    this.dropHost(sessionId, 'Stopped');
    ptyManager.release(`session-term-${sessionId}`);

    session.state = 'parked';
    session.agentStopped = true;
    clearPendingRequests(session);
    session.activeTerminalId = undefined;
    session.isAgentRunning = false;
    session.updatedAt = Date.now();

    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: resumableSessionId(session)
        ? `🛑 Agent process stopped. Your next message starts it again and continues the same agent session.`
        : `🛑 Agent process stopped. Your next message starts a new agent session with a summary of this conversation.`,
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
      targetModel = normalizeClaudeModel(targetModel, targetModel);
    }

    // Same agent, and it can switch models while running: keep the process and its conversation.
    // A clean slate is the exception: it asks for a new agent session
    const liveHost = targetAgent.id === session.agentId && contextMode !== 'none' ? this.activeHosts.get(sessionId) : undefined;
    if (liveHost?.canSwitchModel) {
      try {
        return await this.switchModelLive(session, liveHost, targetModel, newEffort);
      } catch (err: any) {
        const agentLabel = targetAgent.name.replace(/ \(ACP\)$/, '');
        // An agent that takes models at launch (Codex) gets one it refused live on a restart,
        // which would cut off a running turn
        const restartable = err instanceof ModelRefusedError && Boolean(targetAgent.modelConfigEnv);
        if (restartable && (this.isTurnInFlight(sessionId) || this.compactionRuns.has(sessionId))) {
          throw new TurnInFlightError(`${agentLabel} takes model ${targetModel} only on a restart: switch once the current turn has finished`);
        }
        if (!(err instanceof HostClosedError) && !restartable) {
          throw new Error(`${agentLabel} did not accept model ${targetModel}: ${err.message}`);
        }
        // The agent exited meanwhile, or takes the model at launch: fall through to a restart with a handover
      }
    }

    // Shutdown previous host process so new host can be spun up on next turn
    this.dropHost(sessionId, 'Model or agent switched');
    if (targetAgent.id !== session.agentId || targetModel !== session.model) {
      // Choices and window belong to the old model; the new one reports its own when it starts
      session.agentOptions = cachedAgentOptions(targetAgent.id, targetModel);
      session.contextWindow = undefined;
    }

    // Another agent's turn: this agent's session is set aside to continue on a switch back
    const switching = targetAgent.id !== session.agentId;
    if (switching && contextMode !== 'none') parkAgentResume(session, targetAgent.name);
    // The catch-up mark belongs to the agent session being left
    if (switching || contextMode === 'none') delete session.catchUpAfterTurnId;
    // Every set-aside session holds the context a clean slate drops
    if (contextMode === 'none') dropParkedResumes(session, () => true, 'Dropped by a clean slate');

    session.agentId = targetAgent.id;
    session.agentName = targetAgent.name;
    session.model = targetModel;
    if (newEffort !== undefined) {
      session.effort = newEffort;
    }

    session.contextMode = contextMode;
    // Another agent cannot continue this one's session, and a clean slate means a new one
    if (session.agentResume && (session.agentResume.agentId !== targetAgent.id || contextMode === 'none')) {
      dropAgentResume(session, contextMode === 'none' ? 'Dropped by a clean slate' : `Not continued after you switched to ${targetAgent.name.replace(/ \(ACP\)$/, '')}`);
    }
    if (contextMode === 'none') {
      session.contextStartIndex = session.turns.length;
      session.skipClaudeAdoption = true;
    }
    // A kept agent session that was never sent the conversation still owes it; a new one is told on start
    if (switching || contextMode === 'none' || !resumableSessionId(session)) session.contextHandoffPending = false;
    // Back to an agent set aside here: continue its session, caught up on the turns it missed
    const restored = switching && contextMode !== 'none' ? takeParkedResume(session) : undefined;
    const handover = restored
      ? `continues ${shortId(restored.sessionId)}`
      : contextMode === 'none' || !hasHandoffContext(session) ? '' : resumableSessionId(session) && !session.contextHandoffPending ? 'kept' : contextMode;

    // Reset crashed, blocked, or working state since old host is shutdown
    if (session.state === 'crashed' || session.state === 'blocked' || session.state === 'working') {
      session.state = 'needs_you';
    }
    clearPendingRequests(session);

    // A level the new model is known not to offer falls back to Auto (the agent's report settles unknown models)
    const effortNote = session.agentOptions ? reconcileEffort(session, session.agentOptions) : null;
    const effortLabel = session.effort && session.effort !== AUTO_EFFORT ? ` [Effort: ${session.effort}]` : '';
    const contextLabel = handover ? ` [Context: ${handover}]` : '';
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
      await host.applyModel(targetModel).catch((err) => {
        throw err instanceof HostClosedError ? err : new ModelRefusedError(err?.message || String(err));
      });
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

  /** Record how the agent started: a continued or a new agent session, and what the next prompt must carry. */
  private recordAgentStart(s: AcpSession, host: AcpClientHost, beforeTurnId?: string): void {
    const id = host.sessionId ?? undefined;
    const tried = host.resumeSessionId;
    const now = Date.now();
    s.agentSessionId = id;
    if (id && host.canResume) s.agentResume = { agentId: s.agentId, sessionId: id, cwd: s.cwd, savedAt: now };
    else delete s.agentResume;

    const records = (s.agentSessions ??= []);
    // Any still marked open were cut off without a stop (CodePit itself was restarted)
    for (const r of records) if (r.id !== id && !r.endedAt && !r.endReason) r.endReason = 'Ended when CodePit restarted';
    const model = host.options?.currentModel ?? s.model;
    const known = id ? records.find((r) => r.id === id) : undefined;
    if (known && host.resumed) {
      Object.assign(known, { lastStartedAt: now, resumes: known.resumes + 1, model });
      delete known.endedAt;
      delete known.endReason;
    } else if (id) {
      records.push({
        id,
        agentId: s.agentId,
        agentName: s.agentName,
        model,
        startedAt: now,
        lastStartedAt: now,
        resumes: host.resumed ? 1 : 0,
        ...(tried && !host.resumed ? { replacedBecause: host.resumeError ?? `${s.agentName} cannot continue sessions` } : {}),
        ...(s.agentId === 'claude' ? { transcriptPath: claudeSessionTranscript(s.cwd, id) } : {}),
      });
    }

    // A new agent session gets the conversation with the next prompt; a continued one has it
    // (a continued one that was started but never sent a prompt still owes it). One continued
    // after another agent's turns gets those; one that failed to continue was never caught up
    const catchingUp = host.resumed && s.catchUpAfterTurnId !== undefined;
    if (!host.resumed) delete s.catchUpAfterTurnId;
    s.contextHandoffPending = host.resumed && !catchingUp ? Boolean(s.contextHandoffPending) : hasHandoffContext(s, beforeTurnId);
    if (catchingUp && !s.contextHandoffPending) delete s.catchUpAfterTurnId;
    if (tried && !host.resumed) {
      const setAside = records.find((r) => r.id === tried && r.endReason?.startsWith('Set aside when you switched'));
      if (setAside) setAside.endReason = 'Could not be continued when you switched back';
    }
    let note: string | undefined;
    if (host.resumed) {
      note = catchingUp && s.contextHandoffPending
        ? `↪️ Continued agent session ${shortId(id)}: the agent gets the turns since it last took part.`
        : `↪️ Continued agent session ${shortId(id)}: the agent still has the whole conversation.`;
    }
    else if (tried) {
      note = `⚠️ Could not continue agent session ${shortId(tried)} (${host.resumeError ?? 'not supported'}). Started a new one${
        s.contextHandoffPending ? ', which gets a summary of this conversation' : ''
      }.`;
    }
    if (!note) return;
    const turn: TurnMessage = { id: `sys-${now}-agent`, role: 'system', content: note, timestamp: now };
    const at = beforeTurnId ? s.turns.findIndex((t) => t.id === beforeTurnId) : -1;
    if (at === -1) s.turns.push(turn);
    else s.turns.splice(at, 0, turn);
  }

  /** Mark an agent session as ended (its process stopped or exited). */
  private endAgentSession(sessionId: string, agentSessionId: string, reason: string): void {
    const rec = store.get(sessionId)?.agentSessions?.find((r) => r.id === agentSessionId);
    if (!rec || rec.endedAt) return;
    rec.endedAt = Date.now();
    rec.endReason = reason;
  }

  /**
   * Set the current agent session aside: the next message starts a new one, handed a summary
   * of the conversation (or recent turns, or nothing for a clean slate). The agent's own
   * transcript files are left where they are.
   */
  async forgetAgentSession(sessionId: string, contextMode: ContextTransferMode = 'compact'): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (this.isTurnInFlight(sessionId) || this.startingHosts.has(sessionId)) {
      throw new TurnInFlightError('Wait for the current turn to finish before starting a fresh agent session');
    }
    this.dropHost(sessionId, 'Set aside for a fresh agent session');
    ptyManager.release(`session-term-${sessionId}`);
    // A form or approval from work outside a turn died with the agent
    if (clearPendingRequests(session) && session.state === 'blocked') session.state = 'needs_you';
    dropAgentResume(session, 'Set aside for a fresh agent session');
    delete session.catchUpAfterTurnId;
    session.skipClaudeAdoption = true;
    session.contextMode = contextMode;
    session.contextHandoffPending = false;
    if (contextMode === 'none') {
      session.contextStartIndex = session.turns.length;
      // Other agents' set-aside sessions hold the context a clean slate drops
      dropParkedResumes(session, () => true, 'Dropped by a clean slate');
    }
    session.isAgentRunning = false;
    session.activeTerminalId = undefined;
    session.turns.push({
      id: `sys-${Date.now()}`,
      role: 'system',
      content:
        contextMode === 'none'
          ? '🆕 Agent session set aside. Your next message starts a new agent session with a clean slate.'
          : `🆕 Agent session set aside. Your next message starts a new agent session with ${contextMode === 'full' ? 'the recent turns' : 'a summary'} of this conversation.`,
      timestamp: Date.now(),
    });
    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    this.emit('sessionStream', { sessionId, type: 'sessionStopped', session });
    return session;
  }

  /**
   * Claude's ultrathink (deeper reasoning on the next message) and ultracode (multi-agent
   * workflow orchestration on every message, at xhigh effort). Both are keywords Claude Code
   * reads in the prompt; CodePit adds them to what it sends, not to the transcript.
   */
  async setSessionUltra(sessionId: string, opts: { ultracode?: boolean; ultrathinkNext?: boolean }): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.agentId !== 'claude') throw new InvalidOptionError('Ultrathink and ultracode are Claude Code features');
    if (opts.ultrathinkNext !== undefined) session.ultrathinkNext = opts.ultrathinkNext;
    if (opts.ultracode === true && !session.ultracode) {
      // Claude Code offers ultracode on the models with an xhigh effort level
      const levels = effortChoicesFor(session.agentId, session.model, session.agentOptions);
      if (!levels.some((e) => e.value === 'xhigh')) throw new InvalidOptionError(`${session.model || 'This model'} does not support ultracode`);
      await this.setSessionEffort(sessionId, 'xhigh');
    }
    if (opts.ultracode !== undefined) session.ultracode = opts.ultracode;
    return this.saveSettingChange(session, 'sessionUltraUpdated', {
      ultracode: session.ultracode,
      ultrathinkNext: session.ultrathinkNext,
      effort: session.effort,
    });
  }

  /**
   * Set the agent's approval mode (one of agentOptions.modes). It replaces this app's
   * auto-approve, which would otherwise answer every prompt whatever the mode says.
   */
  async setSessionMode(sessionId: string, mode: string): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const known = session.agentOptions?.modes;
    if (known?.length && !known.some((m) => m.value === mode)) throw new InvalidOptionError(`${session.agentName} has no "${mode}" mode`);
    const host = this.activeHosts.get(sessionId);
    if (host?.options?.modeConfigId) await host.applyMode(mode);
    else if (host) host.mode = mode;
    else this.startingHosts.get(sessionId)?.promise.then((h) => (store.get(sessionId)?.mode === mode ? h.applyMode(mode) : undefined)).catch((err) => console.warn(`[session-mgr] Mode not applied to ${sessionId}: ${err.message}`));
    session.mode = mode;
    session.user = { ...session.user, autoApprove: false };
    return this.saveSettingChange(session, 'sessionModeUpdated', { mode, user: session.user });
  }

  /** Turn fast mode on or off; applied now when the agent runs, else when it starts. */
  async setSessionFastMode(sessionId: string, enabled: boolean): Promise<AcpSession> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const host = this.activeHosts.get(sessionId);
    if (host?.options?.fast) await host.applyFastMode(enabled);
    else if (host) host.fastMode = enabled;
    session.fastMode = enabled;
    return this.saveSettingChange(session, 'sessionFastModeUpdated', { fastMode: enabled });
  }

  private saveSettingChange(session: AcpSession, type: string, patch: Partial<AcpSession>): AcpSession {
    session.updatedAt = Date.now();
    store.save(session);
    this.emit('sessionsUpdated', this.listSessions());
    // The agent's updated options (current mode, fast on/off) go out with it
    this.emit('sessionStream', { sessionId: session.id, type, session: { ...patch, agentOptions: session.agentOptions } });
    return session;
  }

  /**
   * Compact the session's context. An agent with its own compaction (it offers a `compact`
   * command, as Claude Code and Codex do) runs it inside the same agent session. Any other
   * agent is asked for a handoff summary and then restarted; the summary is the first
   * context the next prompt carries. Earlier turns stay in the transcript: the compaction's
   * system turn marks the boundary. Returns at once; progress streams as 'compaction' events.
   */
  async compactSession(sessionId: string, opts: { trigger?: 'manual' | 'auto'; force?: boolean } = {}): Promise<AcpSession> {
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
    // A stopped agent has to be sent up to 20 recent turns to summarise, which costs tokens: only when asked to
    if (!host && !opts.force) throw new AgentNotRunningError();
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
      const host = await this.ensureHost(session);
      if (this.compactionRuns.get(sessionId) !== run) return;
      // A new agent session has none of the conversation; a continued one has all of it
      const needsHistory = Boolean(store.get(sessionId)?.contextHandoffPending);
      let prompt = '/compact';
      if (run.method === 'handoff') {
        prompt = HANDOFF_SUMMARY_PROMPT;
        // A freshly started agent has none of the conversation yet: give it what there is to summarise
        if (needsHistory) {
          const turns = handoffTurns(session, run.turnId);
          const history = formatSessionHistory(turns, { compact: false, maxTurns: 20, catchUp: catchUpFor(session, turns) });
          if (history) prompt = `${history}\n\n${prompt}`;
        }
        // The agent now has the history; the next prompt must not send it again
        const s = store.get(sessionId);
        if (s?.contextHandoffPending) {
          s.contextHandoffPending = false;
          delete s.catchUpAfterTurnId;
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
      // Restart: the next prompt starts a fresh agent with the summary as its first context.
      // The old agent session still holds everything the summary replaces: never continue it
      this.dropHost(sessionId, 'Replaced by a summary (compaction)');
      dropAgentResume(s, 'Replaced by a summary (compaction)');
      // Nothing is left to answer a form or approval the old agent was waiting on
      if (clearPendingRequests(s) && s.state === 'blocked') s.state = 'needs_you';
      // The new agent session gets the whole conversation (the summary), not a catch-up
      delete s.catchUpAfterTurnId;
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
    // The sidebar shows "Compacting" while one runs
    if (u.status) this.emit('sessionsUpdated', this.listSessions());
    return added;
  }

  /** Re-rank and tell the sidebar when background work starts or stops counting as "working in background". */
  private refreshBackgroundStatus(sessionId: string): void {
    const s = store.get(sessionId);
    if (!s) return;
    const now = isWorkingInBackground(s, s.state);
    if (this.inBackground.get(sessionId) === now) return;
    this.inBackground.set(sessionId, now);
    store.save(s, { touch: false });
    this.emit('sessionsUpdated', this.listSessions());
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
      pendingPermission: Boolean(s.pendingPermission || s.pendingElicitation),
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
    this.refreshBackgroundStatus(sessionId);
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

    const git = await getGitInfo(current.cwd);

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

    // Terminate running host process so old conversation state is cleared from process memory.
    // Its own transcript still holds the undone turns, so it is not continued either
    this.dropHost(sessionId, 'Conversation rewound');
    dropAgentResume(session, 'Conversation rewound');
    delete session.catchUpAfterTurnId;
    // A set-aside agent session that saw undone turns would bring them back if continued
    const kept = new Set(session.turns.map((t) => t.id));
    dropParkedResumes(session, (p) => Boolean(p.lastSeenTurnId) && !kept.has(p.lastSeenTurnId!), 'Conversation rewound past where it was set aside');
    session.skipClaudeAdoption = true;
    // Rewound to before a clean slate: that clean slate is undone too
    if ((session.contextStartIndex ?? 0) > session.turns.length) delete session.contextStartIndex;

    // Recalculate session properties based on remaining turns
    const lastUserTurn = [...session.turns].reverse().find((t) => t.role === 'user');
    session.lastPrompt = lastUserTurn?.content || '';

    const lastAgentTurn = [...session.turns].reverse().find((t) => t.role === 'agent');
    session.recap = lastAgentTurn?.content
      ? lastAgentTurn.content.slice(0, 160).replace(/\n/g, ' ') + (lastAgentTurn.content.length > 160 ? '...' : '')
      : '';

    session.state = 'needs_you';
    clearPendingRequests(session);
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
    this.dropHost(sessionId, 'Session deleted');
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

function findElicitationCall(s: AcpSession, requestId: string): { turn: TurnMessage; call: ToolCallRecord } | null {
  for (const turn of s.turns) {
    const call = turn.toolCalls?.find((c) => c.elicitation?.requestId === requestId);
    if (call) return { turn, call };
  }
  return null;
}

const oneLine = (text: string) => {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

/** Record how a form ended on its card. A card of its own also ends as a call, with the answer as its output. */
function settleElicitationRecord(call: ToolCallRecord, outcome: ElicitationOutcome): void {
  const rec = call.elicitation;
  if (!rec || rec.status !== 'pending') return;
  rec.status = outcome.action === 'accept' ? 'accepted' : outcome.action === 'decline' ? 'declined' : 'cancelled';
  rec.resolvedAt = Date.now();
  const content = outcome.action === 'accept' ? outcome.content ?? {} : undefined;
  // A secret answer goes to the agent but is not kept in the session file
  if (content) rec.content = Object.fromEntries(Object.entries(content).filter(([key]) => !rec.fields.some((f) => f.key === key && f.secret)));
  // The agent's own call (AskUserQuestion) reports its own result
  if (!call.id.startsWith('elicitation:')) return;
  call.output = content ? describeElicitationAnswer(rec.fields, content) : outcome.action === 'decline' ? 'Skipped' : outcome.withdrawn ? 'Withdrawn by the agent' : 'Cancelled';
  call.status = outcome.action === 'cancel' ? 'failed' : 'completed';
  call.completedAt = rec.resolvedAt;
}

/**
 * Drop the approval request and form waiting on the user, for when the turn or the agent is
 * gone and no answer can reach it. True when there was anything to drop.
 */
function clearPendingRequests(s: AcpSession): boolean {
  let changed = Boolean(s.pendingPermission || s.pendingElicitation);
  s.pendingPermission = null;
  s.pendingElicitation = null;
  for (const turn of s.turns) {
    for (const call of turn.toolCalls || []) {
      if (call.elicitation?.status !== 'pending') continue;
      settleElicitationRecord(call, { action: 'cancel' });
      changed = true;
    }
  }
  return changed;
}

/** Write a prompt's attachments under the session's uploads, as the transcript records them. */
function saveAttachments(sessionId: string, attachments?: FileAttachment[]): FileAttachment[] {
  if (!attachments?.length) return [];
  const uploadDir = path.join(getUploadsDir(), sessionId);
  fs.mkdirSync(uploadDir, { recursive: true });
  return attachments.map((att) => {
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
    return {
      id: att.id || `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: att.name,
      size: att.size || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
      mimeType: att.mimeType,
      path: filePath,
      url: `/api/attachments/${sessionId}/${encodeURIComponent(safeName)}`,
      data: att.data,
      isImage: att.isImage ?? att.mimeType?.startsWith('image/'),
    };
  });
}

/** The prompt text with a note per attachment (and the content of small text files) in front. */
function withAttachmentNotes(text: string, saved: FileAttachment[]): string {
  if (saved.length === 0) return text;
  const notes: string[] = [];
  for (const att of saved) {
    if (att.isImage) {
      notes.push(`[Attached Image: ${att.name} (Saved at: ${att.path})]`);
    } else {
      notes.push(`[Attached File: ${att.name} (Saved at: ${att.path})]`);
      try {
        if (att.path && fs.existsSync(att.path) && att.size < 50000) {
          const textContent = fs.readFileSync(att.path, 'utf8');
          notes.push(`--- Begin File Content: ${att.name} ---\n${textContent}\n--- End File Content: ${att.name} ---`);
        }
      } catch {}
    }
  }
  return text ? `${notes.join('\n\n')}\n\n${text}` : notes.join('\n\n');
}

/** Where Claude Code keeps a subagent's transcript: <project>/<session id>/subagents/agent-<id>.jsonl, when it is there. */
function claudeSubagentTranscript(s: AcpSession, audit: TaskAudit): string | undefined {
  if (audit.agentId !== 'claude' || !audit.agentSessionId || !audit.subagentId) return undefined;
  if (!/^[\w-]+$/.test(audit.agentSessionId) || !/^[\w-]+$/.test(audit.subagentId)) return undefined;
  return claudeProjectDirs(s.cwd)
    .map((d) => path.join(d, audit.agentSessionId!, 'subagents', `agent-${audit.subagentId}.jsonl`))
    .find((f) => fs.existsSync(f));
}

// ---------------------------------------------------------------------------
// Continuing agent sessions and Claude keywords

/** The saved agent session this session may continue: same agent, same folder. */
function resumableSessionId(s: AcpSession): string | undefined {
  const r = s.agentResume;
  return r && r.agentId === s.agentId && r.cwd === s.cwd ? r.sessionId : undefined;
}

/**
 * The turns a new agent session is told about: after a clean slate only later ones, never `excludeId`.
 * A continued session catching up after another agent gets only the turns since it last took part.
 */
function handoffTurns(s: AcpSession, excludeId?: string): TurnMessage[] {
  const from = Math.max(s.contextStartIndex ?? 0, catchUpStart(s) ?? 0);
  return s.turns.slice(from).filter((t) => t.id !== excludeId);
}

/** Where the turns a continued agent session missed begin, when it is catching up and its last turn still exists. */
function catchUpStart(s: AcpSession): number | undefined {
  if (!s.catchUpAfterTurnId) return undefined;
  const at = s.turns.findIndex((t) => t.id === s.catchUpAfterTurnId);
  return at === -1 ? undefined : at + 1;
}

/** formatSessionHistory's catch-up option for a handoff: the other agents that answered meanwhile. */
function catchUpFor(s: AcpSession, turns: TurnMessage[]): { by: string[] } | undefined {
  if (catchUpStart(s) === undefined) return undefined;
  const names = turns.filter((t) => t.role === 'agent' && t.agentName && t.agentId !== s.agentId).map((t) => t.agentName!.replace(/ \(ACP\)$/, ''));
  return { by: [...new Set(names)] };
}

/**
 * On a switch to another agent: set the current agent session aside, to continue when the
 * conversation switches back. One still owed the conversation never saw it, so there is
 * nothing to continue (unless all it is owed is a catch-up: it saw up to that mark).
 */
function parkAgentResume(s: AcpSession, targetName: string): void {
  const sessionId = resumableSessionId(s);
  const caughtUpTo = s.catchUpAfterTurnId;
  if (!sessionId || (s.contextHandoffPending && caughtUpTo === undefined)) return;
  // Not a trailing message: one still on its way ("send now") is taken back out if it fails,
  // and a mark that is gone would hand the whole conversation over again
  let seen = s.turns.length - 1;
  while (seen >= 0 && s.turns[seen].role === 'user') seen--;
  const lastSeenTurnId = caughtUpTo !== undefined ? caughtUpTo || undefined : s.turns[seen]?.id;
  // At most one per agent: an older one of this agent (another folder) gives way
  dropParkedResumes(s, (p) => p.agentId === s.agentId, 'Replaced by a later session of this agent');
  (s.parkedAgentResumes ??= []).push({
    agentId: s.agentId,
    agentName: s.agentName,
    sessionId,
    cwd: s.cwd,
    savedAt: s.agentResume!.savedAt,
    parkedAt: Date.now(),
    model: s.model,
    ...(lastSeenTurnId ? { lastSeenTurnId } : {}),
  });
  const rec = s.agentSessions?.find((r) => r.id === sessionId);
  if (rec) {
    rec.endedAt ??= Date.now();
    rec.endReason = `Set aside when you switched to ${targetName.replace(/ \(ACP\)$/, '')}; continues if you switch back`;
  }
}

/** The set-aside session of the agent now serving `s`, made the one to continue, with its catch-up mark. */
function takeParkedResume(s: AcpSession): ParkedAgentResume | undefined {
  const parked = s.parkedAgentResumes?.find((p) => p.agentId === s.agentId && p.cwd === s.cwd);
  if (!parked) return undefined;
  s.parkedAgentResumes = s.parkedAgentResumes!.filter((p) => p !== parked);
  if (s.parkedAgentResumes.length === 0) delete s.parkedAgentResumes;
  s.agentResume = { agentId: parked.agentId, sessionId: parked.sessionId, cwd: parked.cwd, savedAt: parked.savedAt };
  // '' when it saw no turns: the whole conversation is handed over, as to a new session
  s.catchUpAfterTurnId = parked.lastSeenTurnId ?? '';
  return parked;
}

/**
 * Forget the agent session to continue. One switched back to but not continued yet still reads
 * "continues if you switch back" on its record, which is no longer true: it says why instead.
 */
function dropAgentResume(s: AcpSession, reason: string): void {
  const id = s.agentResume?.sessionId;
  delete s.agentResume;
  if (!id || s.parkedAgentResumes?.some((p) => p.sessionId === id)) return;
  const rec = s.agentSessions?.find((r) => r.id === id);
  if (rec?.endReason?.startsWith('Set aside when you switched')) rec.endReason = reason;
}

/** Forget the set-aside agent sessions `drop` picks, saying why on their records. */
function dropParkedResumes(s: AcpSession, drop: (p: ParkedAgentResume) => boolean, reason: string): void {
  if (!s.parkedAgentResumes?.length) return;
  for (const p of s.parkedAgentResumes.filter(drop)) {
    const rec = s.agentSessions?.find((r) => r.id === p.sessionId);
    if (rec) rec.endReason = reason;
  }
  s.parkedAgentResumes = s.parkedAgentResumes.filter((p) => !drop(p));
  if (s.parkedAgentResumes.length === 0) delete s.parkedAgentResumes;
}

/** Whether there is a conversation a new agent session needs to be handed. */
function hasHandoffContext(s: AcpSession, excludeId?: string): boolean {
  const turns = handoffTurns(s, excludeId);
  return turns.some((t) => t.role === 'agent') || latestCompaction(turns) !== null;
}

const shortId = (id: string | undefined) => (id ? id.slice(0, 8) : 'unknown');

/** A title CodePit generated before default titles were just the folder: "<agent>[ (from <agent>)] in <folder>". */
const OLD_AGENT_NAMES = new Set(['Built-in ACP Demo Agent']);

/** The agent's current name for a name saved before the "(ACP)" suffix was dropped. */
function currentAgentName(name: string | undefined, agentId: string | undefined): string | undefined {
  if (!name || !(name.endsWith('(ACP)') || OLD_AGENT_NAMES.has(name))) return name;
  return agentId && hasAgent(agentId) ? getAgent(agentId).name : name.replace(/\s*\(ACP\)$/, '');
}

/** Rename saved agent names on the session, its turns and its agent sessions. Returns whether any changed. */
export function renameOldAgentNames(s: AcpSession): boolean {
  let changed = false;
  const rename = <T extends { agentName?: string; agentId?: string }>(o: T, agentId = o.agentId) => {
    const next = currentAgentName(o.agentName, agentId);
    if (next !== o.agentName) {
      o.agentName = next;
      changed = true;
    }
  };
  rename(s);
  for (const t of s.turns) if (t.agentName) rename(t);
  for (const r of s.agentSessions ?? []) rename(r);
  for (const p of s.parkedAgentResumes ?? []) rename(p);
  return changed;
}

export function isOldDefaultTitle(title: string, cwd: string): boolean {
  const folder = path.basename(cwd);
  const suffix = ` in ${folder}`;
  if (!folder || !title.endsWith(suffix)) return false;
  const head = title.slice(0, -suffix.length);
  const names = new Set(listAgents(true).map((a) => a.name));
  const isAgentName = (n: string) => names.has(n) || OLD_AGENT_NAMES.has(n) || n.endsWith('(ACP)');
  const from = head.match(/^(.+?) \(from .+\)$/);
  return isAgentName(head) || Boolean(from && isAgentName(from[1]));
}

/** Session candidates the New session dialog can offer without ever copying the source transcript. */
export interface ImportableAgentSession {
  id: string;
  agentId: string;
  /** A short, local-only preview of the latest user request or vendor-provided title. */
  label: string;
  updatedAt: number;
  transcriptPath?: string;
}

/** Real ACP agents accept arbitrary vendor session ids; keep the handoff value bounded and non-path-like. */
export function isSafeImportedSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
}

/**
 * Locally discover sessions for agents whose CLIs keep readable transcripts. Other ACP
 * adapters still support import by pasted id: their conversation store is intentionally
 * treated as private and is not guessed at here.
 */
export function listImportableAgentSessions(agentId: string, cwd: string): ImportableAgentSession[] {
  // One already continued by a CodePit session would get two conversations writing into it
  const bound = new Set(store.getAll().flatMap((s) => [...boundAgentSessions(s, agentId)]));
  if (agentId === 'claude') return listClaudeImportableSessions(cwd, bound);
  if (agentId === 'codex') return listCodexImportableSessions(cwd, bound);
  return [];
}

/** The agent sessions of `agentId` this CodePit session would continue: the current one and any set aside. */
function boundAgentSessions(s: AcpSession, agentId: string): string[] {
  return [s.agentResume, ...(s.parkedAgentResumes ?? [])].filter((r) => r?.agentId === agentId).map((r) => r!.sessionId);
}

/** The CodePit session that would already continue this agent session, if any. */
export function agentSessionOwner(agentId: string, agentSessionId: string): AcpSession | undefined {
  return store.getAll().find((s) => boundAgentSessions(s, agentId).includes(agentSessionId));
}

const importPreview = (text: string | undefined, fallback: string): string => {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean ? (clean.length > 180 ? `${clean.slice(0, 177)}…` : clean) : fallback;
};

function listClaudeImportableSessions(cwd: string, bound: Set<string>): ImportableAgentSession[] {
  const found = new Map<string, ImportableAgentSession>();
  for (const dir of claudeProjectDirs(cwd)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.jsonl$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      let updatedAt: number;
      try {
        updatedAt = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const id = path.basename(entry.name, '.jsonl');
      if (bound.has(id)) continue;
      // Folder names map every other character to '-', so /a/my-app and /a/my/app share one
      const started = claudeTranscriptCwd(file);
      if (started && !sameWorkspace(started, cwd)) continue;
      const candidate: ImportableAgentSession = {
        id,
        agentId: 'claude',
        label: importPreview(lastHumanPrompt(file), 'Claude conversation'),
        updatedAt,
        transcriptPath: file,
      };
      if ((found.get(id)?.updatedAt ?? 0) < updatedAt) found.set(id, candidate);
    }
  }
  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The folder a Claude Code transcript started in: the first entry that records one. */
function claudeTranscriptCwd(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.cwd === 'string' && entry.cwd) return entry.cwd;
      } catch {
        // a partial last line, or not JSON
      }
    }
  } catch {
    // unreadable: listed without the check
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

interface CodexTranscriptMeta {
  id?: string;
  cwd?: string;
}

function readCodexTranscriptMeta(file: string): CodexTranscriptMeta | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    // Only the first line is needed: read until it ends (it is ~20 KB), not the whole transcript
    const CHUNK = 64 * 1024;
    const chunks: Buffer[] = [];
    let read = 0;
    for (;;) {
      const buf = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, read);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      read += n;
      if (buf.subarray(0, n).includes(10) || read >= 1 << 20) break;
    }
    const line = Buffer.concat(chunks).toString('utf8').split('\n').find(Boolean);
    const entry = line ? JSON.parse(line) : undefined;
    if (entry?.type !== 'session_meta') return undefined;
    return { id: typeof entry.payload?.session_id === 'string' ? entry.payload.session_id : undefined, cwd: typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : undefined };
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Codex records the user turn as a response_item; scanning backwards keeps this quick for long transcripts. */
function lastCodexHumanPrompt(file: string): string | undefined {
  const CHUNK = 1 << 20;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let end = size;
    let carry = '';
    while (end > 0 && size - end < 16 * CHUNK) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = (buf.toString('utf8') + carry).split('\n');
      carry = start > 0 ? lines.shift() ?? '' : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          const payload = entry?.type === 'response_item' ? entry.payload : undefined;
          if (payload?.type !== 'message' || payload.role !== 'user') continue;
          const content = payload.content;
          if (typeof content === 'string' && content.trim()) return content;
          if (Array.isArray(content)) {
            const text = content.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('\n');
            if (text.trim()) return text;
          }
        } catch {
          // Ignore a partial line or a malformed event and keep looking.
        }
      }
      end = start;
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

function sameWorkspace(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function codexTranscriptFiles(root: string): string[] {
  const files: string[] = [];
  const dirs = [root];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  return files;
}

// What each rollout file held when last read, so a repeated listing only stats the files
const codexMetaCache = new Map<string, { mtimeMs: number; size: number; meta?: CodexTranscriptMeta; label?: string }>();

function listCodexImportableSessions(cwd: string, bound: Set<string>): ImportableAgentSession[] {
  // The override keeps tests hermetic and also supports a deliberately relocated Codex home.
  const root = path.join(process.env.CODEPIT_CODEX_CONFIG_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const candidates: ImportableAgentSession[] = [];
  const files = codexTranscriptFiles(root);
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    let cached = codexMetaCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, meta: readCodexTranscriptMeta(file) };
      codexMetaCache.set(file, cached);
    }
    const meta = cached.meta;
    if (!meta?.id || !isSafeImportedSessionId(meta.id) || bound.has(meta.id) || !meta.cwd || !sameWorkspace(meta.cwd, cwd)) continue;
    cached.label ??= importPreview(lastCodexHumanPrompt(file), 'Codex conversation');
    candidates.push({
      id: meta.id,
      agentId: 'codex',
      label: cached.label,
      updatedAt: stat.mtimeMs,
      transcriptPath: file,
    });
  }
  // Files that are gone do not stay cached
  if (codexMetaCache.size > files.length) {
    const present = new Set(files);
    for (const file of codexMetaCache.keys()) if (!present.has(file)) codexMetaCache.delete(file);
  }
  return candidates.sort((a, b) => b.updatedAt - a.updatedAt);
}

const isSlashCommand = (text: string) => text.trim().startsWith('/');

/** Claude's keywords due on this message; ultrathink is used up by it. */
function takeKeywords(s: AcpSession): string[] {
  if (s.agentId !== 'claude') return [];
  const keywords: string[] = [];
  if (s.ultrathinkNext) {
    keywords.push('ultrathink');
    s.ultrathinkNext = false;
  }
  if (s.ultracode) keywords.push('ultracode');
  return keywords;
}

/** Claude Code reads the keywords as bare words; outside quotes or code they take effect. */
function withKeywords(text: string, keywords: string[]): string {
  return keywords.length > 0 ? `${text}\n\n${keywords.join(' ')}` : text;
}

const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Claude Code's project folders for a cwd: it names them after the real path, so both are tried. */
function claudeProjectDirs(cwd: string): string[] {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    // folder gone; the recorded path is all there is
  }
  return [...new Set([real, cwd])].map((d) => path.join(claudeConfigDir(), 'projects', d.replace(/[^a-zA-Z0-9]/g, '-')));
}

/** Where Claude Code keeps a session's transcript (it may not exist before the first prompt). */
function claudeSessionTranscript(cwd: string, sessionId: string): string {
  const dirs = claudeProjectDirs(cwd);
  return dirs.map((d) => path.join(d, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f)) ?? path.join(dirs[0], `${sessionId}.jsonl`);
}

/** The user's own text in a prompt CodePit sent: without the handoff history or attachment notes. */
function promptCore(text: string): string {
  const marker = '[Active User Request]\n';
  const at = text.lastIndexOf(marker);
  const own = at === -1 ? text : text.slice(at + marker.length);
  return own
    .split('\n')
    .filter((line) => !line.startsWith('[Attached '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last prompt a person sent in a Claude Code transcript, read from the end of the file. */
export function lastHumanPrompt(file: string): string | undefined {
  const CHUNK = 1 << 20;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let end = size;
    let carry = '';
    // Up to 16 MB back: a long turn can write a lot of tool output after its prompt
    while (end > 0 && size - end < 16 * CHUNK) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = (buf.toString('utf8') + carry).split('\n');
      carry = start > 0 ? lines.shift() ?? '' : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        let e: any;
        try {
          e = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (e?.type !== 'user' || e.isMeta || e.isSidechain || e.message?.role !== 'user') continue;
        const content = e.message.content;
        const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
        if (blocks.some((b: any) => b?.type === 'tool_result')) continue;
        const text = blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
        if (!text.trim() || /^(<task-notification|<command-|<local-command|\[Request interrupted)/.test(text.trim())) continue;
        return text;
      }
      end = start;
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

/**
 * Sessions from before CodePit kept agent sessions have no record of theirs. For Claude, find
 * it once: the recent transcript in this folder whose last prompt is the session's last message.
 */
export function adoptClaudeSession(s: AcpSession, excludeTurnId?: string): string | undefined {
  if (s.agentId !== 'claude' || s.skipClaudeAdoption || s.agentSessions?.length || s.agentResume) return undefined;
  const last = [...s.turns].reverse().find((t) => t.role === 'user' && t.id !== excludeTurnId && t.content?.trim());
  const want = last ? promptCore(last.content!).slice(0, 200) : '';
  if (want.length < 8) return undefined;
  for (const dir of claudeProjectDirs(s.cwd)) {
    let files: Array<{ file: string; mtime: number }>;
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f))
        .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
    } catch {
      continue;
    }
    for (const { file } of files.sort((a, b) => b.mtime - a.mtime).slice(0, 8)) {
      const prompt = lastHumanPrompt(file);
      if (prompt && promptCore(prompt).includes(want)) return path.basename(file, '.jsonl');
    }
  }
  return undefined;
}
