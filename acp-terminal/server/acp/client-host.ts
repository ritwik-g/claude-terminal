import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import * as acp from '@agentclientprotocol/sdk';
import { ptyManager } from '../pty-manager.js';
import type { AgentDescriptor, FileAttachment, PendingPermission, ToolCallRecord, TokenUsage } from '../types.js';

export function normalizeClaudeModel(model?: string): string {
  if (!model) return 'sonnet';
  const m = model.toLowerCase().trim();
  if (m === 'sonnet' || m === 'opus' || m === 'haiku') return m;
  if (m.includes('opus-4-6') || m.includes('opus-4.6')) return 'claude-opus-4-6';
  if (m.includes('opus-4-5') || m.includes('opus-4.5')) return 'claude-opus-4-5';
  if (m.includes('haiku-4-5') || m.includes('haiku-4.5')) return 'claude-haiku-4-5';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

/** Thrown by sendPrompt when the session already has a turn running. */
export class TurnInFlightError extends Error {
  constructor(message = 'A turn is already in progress for this session; cancel it before sending another prompt') {
    super(message);
    this.name = 'TurnInFlightError';
  }
}

/** Rejection for requests still pending when the host is shut down or the agent process exits. */
export class HostClosedError extends Error {
  constructor(public readonly byShutdown: boolean) {
    super(byShutdown ? 'Agent host was shut down' : 'Agent process exited');
    this.name = 'HostClosedError';
  }
}

// How long cancel() waits for the agent to wind the turn down before abandoning it
const CANCEL_GRACE_MS = 5_000;

type PermissionEntry = {
  data: PendingPermission;
  resolve: (res: acp.RequestPermissionResponse) => void;
};

export interface ClientHostEvents {
  thought: (text: string) => void;
  message: (text: string) => void;
  toolCall: (record: ToolCallRecord) => void;
  toolCallUpdate: (record: ToolCallRecord) => void;
  usageUpdate: (usage: TokenUsage) => void;
  permissionRequested: (perm: PendingPermission) => void;
  permissionResolved: (permId: string, info: { cancelled: boolean }) => void;
  turnCompleted: (stopReason: string) => void;
  promptSuggestion: (suggestion: string) => void;
  error: (err: Error) => void;
  closed: () => void;
}

export class AcpClientHost extends EventEmitter {
  private child: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  // Permission requests are answered in arrival order; only the head is shown to the user
  private permissionQueue: PermissionEntry[] = [];
  // Agent-created terminals, released when the host shuts down
  private terminalIds = new Set<string>();
  private isInitialized = false;
  // Bumped per prompt and on abandon/shutdown so a stale turn cannot clobber a newer one
  private turnSeq = 0;
  private inflightPrompt: Promise<unknown> | null = null;
  private closed: HostClosedError | null = null;
  private rejectClosed!: (err: HostClosedError) => void;
  private readonly closeSignal: Promise<never>;
  public sessionId: string | null = null;
  public isTurnInFlight = false;
  public lastActivityAt = Date.now();

  constructor(
    public readonly sessionRecordId: string,
    public readonly agent: AgentDescriptor,
    public readonly cwd: string,
    private readonly isAutoApprove?: () => boolean,
    public readonly model?: string,
    public readonly effort?: string
  ) {
    super();
    this.closeSignal = new Promise<never>((_resolve, reject) => {
      this.rejectClosed = reject;
    });
    this.closeSignal.catch(() => {});
  }

  get isShutdown(): boolean {
    return this.closed?.byShutdown === true;
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  /** Race an agent request against the host closing, so callers never hang on a dead process. */
  private untilClosed<T>(p: Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    return Promise.race([p, this.closeSignal]);
  }

  private markClosed(byShutdown: boolean): void {
    if (this.closed) return;
    this.closed = new HostClosedError(byShutdown);
    this.rejectClosed(this.closed);
  }

  // 'error' with no listener would throw; after shutdown() the listeners are gone on purpose
  private emitError(err: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  async start(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows && this.agent.command === 'npx' ? 'npx.cmd' : this.agent.command;

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.agent.env,
    };
    if (this.agent.id === 'claude') {
      const normalized = normalizeClaudeModel(this.model);
      env.ANTHROPIC_MODEL = normalized;
      env.MODEL = normalized;
      const localClaude = path.join(os.homedir(), '.local/bin/claude');
      if (fs.existsSync(localClaude) && !env.CLAUDE_CODE_EXECUTABLE) {
        env.CLAUDE_CODE_EXECUTABLE = localClaude;
      }
    } else if (this.model) {
      env.OPENAI_MODEL = this.model;
      env.GEMINI_MODEL = this.model;
      env.MODEL = this.model;
    }
    if (this.effort) {
      env.REASONING_EFFORT = this.effort;
      env.THINKING_EFFORT = this.effort;
      if (this.effort === 'off') {
        env.MAX_THINKING_TOKENS = '0';
      } else if (this.effort === 'low') {
        env.MAX_THINKING_TOKENS = '2048';
      } else if (this.effort === 'medium') {
        env.MAX_THINKING_TOKENS = '8192';
      } else if (this.effort === 'high') {
        env.MAX_THINKING_TOKENS = '32768';
      }
    }

    this.child = spawn(cmd, this.agent.args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    if (!this.child.stdin || !this.child.stdout) {
      throw new Error(`Failed to spawn agent ${this.agent.name}: stdio streams not available`);
    }

    const input = Writable.toWeb(this.child.stdin);
    const output = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const clientApp = acp.client({
      name: 'acp-terminal',
    });

    // 1. Permission requests from agent
    clientApp.onRequest(acp.methods.client.session.requestPermission, async (ctx: any) => {
      const params = ctx.params;
      this.touch();

      // Check if auto-approve is active for this session
      if (this.isAutoApprove && this.isAutoApprove()) {
        const allowOpt = (params.options || []).find((o: any) => o.optionId === 'allow' || o.kind?.includes('allow') || o.optionId.includes('allow'));
        const optionId = allowOpt?.optionId || params.options?.[0]?.optionId || 'allow';
        return { outcome: { outcome: 'selected', optionId } };
      }

      const permId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const pending: PendingPermission = {
        requestId: permId,
        toolCallId: params.toolCall?.toolCallId || 'call',
        title: params.toolCall?.title || 'Permission requested',
        options: (params.options || []).map((o: any) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
        rawParams: params,
        requestedAt: Date.now(),
      };

      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        this.permissionQueue.push({ data: pending, resolve });
        // Surface it now if it is the only one waiting; otherwise it is shown once the earlier ones are answered
        if (this.permissionQueue.length === 1) {
          this.emit('permissionRequested', pending);
        }
      });
    });

    // 2. Terminal creation & control
    clientApp.onRequest(acp.methods.client.terminal.create, async (ctx: any) => {
      const params = ctx.params;
      this.touch();
      const term = ptyManager.createTerminal({
        sessionId: this.sessionRecordId,
        command: params.command,
        args: params.args,
        cwd: params.cwd || this.cwd,
        env: params.env,
        outputByteLimit: params.outputByteLimit ?? undefined,
      });
      this.terminalIds.add(term.id);
      ptyManager.logAgentActivityToSessionTerminal(
        this.sessionRecordId,
        `${params.command}${params.args && params.args.length > 0 ? ' ' + params.args.join(' ') : ''}`
      );
      this.emit('terminalCreated', term.id);
      return { terminalId: term.id };
    });

    clientApp.onRequest(acp.methods.client.terminal.output, async (ctx: any) => {
      const { terminalId } = ctx.params;
      const res = ptyManager.getOutput(terminalId);
      if (!res) throw new Error(`Terminal ${terminalId} not found`);
      return {
        output: res.output,
        truncated: res.truncated,
        exitStatus: res.exited ? { exitCode: res.exitCode, signal: res.signal } : null,
      };
    });

    clientApp.onRequest(acp.methods.client.terminal.waitForExit, async (ctx: any) => {
      const { terminalId } = ctx.params;
      const res = await this.untilClosed(ptyManager.waitForExit(terminalId));
      this.touch();
      return { exitCode: res.exitCode, signal: res.signal };
    });

    clientApp.onRequest(acp.methods.client.terminal.kill, async (ctx: any) => {
      const { terminalId } = ctx.params;
      // Kill stops the command but keeps the terminal so the agent can still read its output
      ptyManager.kill(terminalId);
      this.emit('terminalReleased', terminalId);
      return {};
    });

    clientApp.onRequest(acp.methods.client.terminal.release, async (ctx: any) => {
      const { terminalId } = ctx.params;
      ptyManager.release(terminalId);
      this.terminalIds.delete(terminalId);
      this.emit('terminalReleased', terminalId);
      return {};
    });

    // 3. Filesystem reading & writing
    clientApp.onRequest(acp.methods.client.fs.readTextFile, async (ctx: any) => {
      const filePath = path.isAbsolute(ctx.params.path)
        ? ctx.params.path
        : path.join(this.cwd, ctx.params.path);
      const content = fs.readFileSync(filePath, 'utf8');
      const { line, limit } = ctx.params;
      if (line == null && limit == null) return { content };
      // `line` is 1-based; `limit` caps the number of lines returned
      const start = Math.max(0, (line ?? 1) - 1);
      const lines = content.split('\n');
      const end = limit == null ? lines.length : start + Math.max(0, limit);
      return { content: lines.slice(start, end).join('\n') };
    });

    clientApp.onRequest(acp.methods.client.fs.writeTextFile, async (ctx: any) => {
      const filePath = path.isAbsolute(ctx.params.path)
        ? ctx.params.path
        : path.join(this.cwd, ctx.params.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, ctx.params.content, 'utf8');
      return {};
    });

    // 4. Inbound session updates from agent
    clientApp.onNotification(acp.methods.client.session.update, (ctx: any) => {
      const update = ctx.params?.update;
      if (!update) return;
      this.touch();

      switch (update.sessionUpdate) {
        case 'agent_thought_chunk': {
          const text = update.content?.text || '';
          if (text) this.emit('thought', text);
          break;
        }
        case 'agent_message_chunk': {
          const text = update.content?.text || '';
          if (text) this.emit('message', text);
          break;
        }
        case 'tool_call': {
          let title = update.title;
          const input = update.rawInput;
          if (!title || title === 'Tool Call') {
            if (input?.command) {
              title = `$ ${input.command}`;
            } else if (input?.path) {
              title = `${update.kind === 'write' ? 'Write' : 'Read'}: ${input.path}`;
            } else if (update.name) {
              title = update.name;
            } else if (update.kind) {
              title = `Tool: ${update.kind}`;
            } else {
              title = 'Tool Call';
            }
          }

          const record: ToolCallRecord = {
            id: update.toolCallId,
            title,
            kind: update.kind,
            status: update.status || 'pending',
            input,
            startedAt: Date.now(),
          };
          this.emit('toolCall', record);
          break;
        }
        case 'tool_call_update': {
          let outputStr: string | undefined;
          const raw = update.rawOutput;
          if (raw !== undefined && raw !== null) {
            if (typeof raw === 'string') {
              outputStr = raw;
            } else if (typeof raw.formatted_output === 'string') {
              outputStr = raw.formatted_output;
            } else if (typeof raw.output === 'string') {
              outputStr = raw.output;
            } else if (typeof raw.stdout === 'string') {
              outputStr = raw.stdout;
            } else if (Array.isArray(raw.content)) {
              outputStr = raw.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
            } else if (raw.result !== undefined) {
              outputStr = typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result, null, 2);
            } else {
              outputStr = JSON.stringify(raw, null, 2);
            }
          }

          let title = update.title;
          const input = update.rawInput;
          if (!title || title === 'Tool Call') {
            if (input?.command) {
              title = `$ ${input.command}`;
            } else if (input?.path) {
              title = `${update.kind === 'write' ? 'Write' : 'Read'}: ${input.path}`;
            }
          }

          // Every tool_call_update field is optional in ACP: send only what this
          // update carries, so the merge keeps the original title, input and status.
          const record = {
            id: update.toolCallId,
            title: title || undefined,
            kind: update.kind,
            status: update.status,
            input,
            output: outputStr,
            error: update.rawOutput?.error,
            completedAt: update.status === 'completed' || update.status === 'failed' ? Date.now() : undefined,
          } as ToolCallRecord;
          this.emit('toolCallUpdate', record);
          break;
        }
        case 'usage_update': {
          const used = typeof update.used === 'number' ? update.used : (update.usage?.contextTokens || 0);
          this.emit('usageUpdate', {
            contextTokens: used,
            inputTokens: used,
            outputTokens: 0,
            cachedTokens: 0,
          });
          const rateLimit = (update._meta as any)?.['_claude/rateLimit'] || (update as any).rate_limit_info;
          if (rateLimit) {
            this.emit('rateLimitUpdate', rateLimit);
          }
          break;
        }
        case 'session_info_update': {
          const suggestion = (update._meta as any)?.prompt_suggestion;
          if (suggestion && typeof suggestion === 'string') {
            this.emit('promptSuggestion', suggestion);
          }
          break;
        }
      }
    });

    this.connection = clientApp.connect(stream);

    const child = this.child;
    child.on('error', (err) => {
      // A spawn failure (e.g. ENOENT) may never emit 'exit'; close so pending requests reject
      if (child.pid === undefined) this.markClosed(false);
      this.emitError(err);
    });

    child.on('exit', () => {
      this.markClosed(false);
      this.cancelPendingPermissions();
      this.emit('closed');
    });

    const connection = this.connection;

    // Perform ACP initialize handshake
    const initRes = await this.untilClosed(connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    }));

    this.isInitialized = true;

    // Handle agent authentication if advertised
    if (initRes.authMethods && initRes.authMethods.length > 0) {
      for (const method of initRes.authMethods) {
        if (!('type' in method && method.type === 'terminal')) {
          try {
            await this.untilClosed(connection.agent.request(acp.methods.agent.authenticate, {
              methodId: method.id,
            }));
            break;
          } catch (err) {
            if (err instanceof HostClosedError) throw err;
            // If already authenticated via local environment or keychain, continue
          }
        }
      }
    }

    // Create session in agent
    const sessionRes = await this.untilClosed(connection.agent.request(acp.methods.agent.session.new, {
      cwd: this.cwd,
      mcpServers: [],
    }));
    this.sessionId = sessionRes.sessionId;

    // Apply model if specified
    if (this.model) {
      const modelToSend = this.agent.id === 'claude' ? normalizeClaudeModel(this.model) : this.model;
      try {
        await this.untilClosed(connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: 'model',
          value: modelToSend,
        }));
      } catch (err) {
        if (err instanceof HostClosedError) throw err;
        // Fallback gracefully if agent doesn't support session/setConfigOption
      }
    }

    // Apply effort if specified
    if (this.effort) {
      try {
        await this.untilClosed(connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: 'effort',
          value: this.effort,
        }));
      } catch (err) {
        if (err instanceof HostClosedError) throw err;
        // Fallback gracefully if agent doesn't support effort config
      }
    }
  }

  async sendPrompt(text: string, attachments?: FileAttachment[]): Promise<{ stopReason: string }> {
    if (this.closed) throw this.closed;
    if (!this.connection || !this.sessionId) {
      throw new Error('ACP Client not connected or initialized');
    }
    if (this.isTurnInFlight) throw new TurnInFlightError();

    const turn = ++this.turnSeq;
    this.isTurnInFlight = true;
    this.touch();
    const run = this.runPrompt(this.connection, this.sessionId, text, attachments);
    this.inflightPrompt = run.catch(() => {});
    try {
      const stopReason = await run;
      if (turn === this.turnSeq) this.emit('turnCompleted', stopReason);
      return { stopReason };
    } catch (err: any) {
      // A turn abandoned by cancel() or ended by shutdown() reports nothing: its owner already moved on
      if (turn === this.turnSeq && !this.isShutdown) {
        this.emitError(err);
        // Guarantee turnCompleted is fired even when an error occurs so UI state never freezes
        this.emit('turnCompleted', 'error');
      }
      throw err;
    } finally {
      if (turn === this.turnSeq) {
        this.isTurnInFlight = false;
        this.inflightPrompt = null;
      }
      this.touch();
    }
  }

  private async runPrompt(
    connection: acp.ClientConnection,
    sessionId: string,
    text: string,
    attachments?: FileAttachment[]
  ): Promise<string> {
    const promptBlocks: acp.ContentBlock[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.isImage && att.data) {
          const rawBase64 = att.data.replace(/^data:[^;]+;base64,/, '');
          promptBlocks.push({
            type: 'image',
            data: rawBase64,
            mimeType: att.mimeType || 'image/png',
          });
        }
      }
    }
    promptBlocks.push({ type: 'text', text });

    let res: acp.PromptResponse;
    try {
      res = await this.untilClosed(connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: promptBlocks,
      }));
    } catch (err: any) {
      // If image block was rejected by the agent, fall back to pure text prompt with file path references
      if (!(err instanceof HostClosedError) && promptBlocks.length > 1 && (err.message?.includes('image') || err.message?.includes('modality') || err.message?.includes('capability'))) {
        console.warn(`[client-host] Image prompt rejected by agent, retrying with text fallback: ${err.message}`);
        res = await this.untilClosed(connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text }],
        }));
      } else {
        throw err;
      }
    }
    return res?.stopReason || 'end_turn';
  }

  /**
   * Cancel the running turn. Pending permission requests are answered `cancelled` (as ACP
   * requires), then the agent gets a grace period to end the turn with stopReason
   * `cancelled`. An agent that ignores the cancel has its turn abandoned so the session is
   * usable again.
   */
  async cancel(): Promise<void> {
    this.touch();
    this.cancelPendingPermissions();
    if (this.connection && this.sessionId) {
      try {
        await this.connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: this.sessionId,
        });
      } catch {
        // ignore
      }
    }
    const inflight = this.inflightPrompt;
    if (!inflight) return;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      inflight.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CANCEL_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!settled && this.inflightPrompt === inflight) {
      this.turnSeq++;
      this.isTurnInFlight = false;
      this.inflightPrompt = null;
      this.emit('turnCompleted', 'cancelled');
    }
  }

  get pendingPermission(): PendingPermission | null {
    return this.permissionQueue[0]?.data ?? null;
  }

  resolvePermission(optionId: string): boolean {
    const entry = this.permissionQueue.shift();
    if (!entry) return false;
    const { data, resolve } = entry;
    this.touch();

    // ACP only allows selecting one of the offered options, or `cancelled`. Generic
    // allow/deny ids from the UI are mapped onto the matching option kind.
    const options = data.options || [];
    let selected = options.find((o) => o.optionId === optionId);
    if (!selected && (optionId === 'reject' || optionId === 'deny')) {
      selected = options.find((o) => o.kind?.startsWith('reject'));
    } else if (!selected && optionId === 'allow') {
      selected = options.find((o) => o.kind?.startsWith('allow'));
    }
    if (selected) {
      resolve({ outcome: { outcome: 'selected', optionId: selected.optionId } });
    } else if (optionId === 'reject' || optionId === 'deny' || optionId === 'cancel') {
      resolve({ outcome: { outcome: 'cancelled' } });
    } else {
      // Unknown id and no matching kind: pass through for agents that accept free-form ids
      resolve({ outcome: { outcome: 'selected', optionId } });
    }

    this.emit('permissionResolved', data.requestId, { cancelled: false });
    const next = this.permissionQueue[0];
    if (next) this.emit('permissionRequested', next.data);
    return true;
  }

  private cancelPendingPermissions(): void {
    const pending = this.permissionQueue;
    this.permissionQueue = [];
    for (const { data, resolve } of pending) {
      try {
        resolve({ outcome: { outcome: 'cancelled' } });
      } catch {
        // ignore
      }
      this.emit('permissionResolved', data.requestId, { cancelled: true });
    }
  }

  shutdown(): void {
    // Detach first: the owner has moved on, so late events from this host must not touch the session
    this.removeAllListeners();
    this.markClosed(true);
    this.turnSeq++;
    this.isTurnInFlight = false;
    this.inflightPrompt = null;
    this.cancelPendingPermissions();
    for (const termId of this.terminalIds) {
      ptyManager.release(termId);
    }
    this.terminalIds.clear();
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
        const pid = this.child.pid;
        if (pid) {
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // ignore
            }
          }, 2000).unref();
        }
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.connection = null;
  }
}
