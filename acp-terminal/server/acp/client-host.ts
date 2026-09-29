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

export interface ClientHostEvents {
  thought: (text: string) => void;
  message: (text: string) => void;
  toolCall: (record: ToolCallRecord) => void;
  toolCallUpdate: (record: ToolCallRecord) => void;
  usageUpdate: (usage: TokenUsage) => void;
  permissionRequested: (perm: PendingPermission) => void;
  permissionResolved: (permId: string) => void;
  turnCompleted: (stopReason: string) => void;
  promptSuggestion: (suggestion: string) => void;
  error: (err: Error) => void;
  closed: () => void;
}

export class AcpClientHost extends EventEmitter {
  private child: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private activePendingPermission: {
    data: PendingPermission;
    resolve: (res: any) => void;
  } | null = null;
  private isInitialized = false;
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
  }

  async start(): Promise<void> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows && this.agent.command === 'npx' ? 'npx.cmd' : this.agent.command;

    const env: Record<string, string> = {
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
    const output = Readable.toWeb(this.child.stdout);
    const stream = acp.ndJsonStream(input, output);

    const clientApp = acp.client({
      name: 'acp-terminal',
      version: '0.1.0',
    });

    // 1. Permission requests from agent
    clientApp.onRequest(acp.methods.client.session.requestPermission, async (ctx: any) => {
      const params = ctx.params;

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

      this.emit('permissionRequested', pending);

      return new Promise((resolve) => {
        this.activePendingPermission = { data: pending, resolve };
      });
    });

    // 2. Terminal creation & control
    clientApp.onRequest(acp.methods.client.terminal.create, async (ctx: any) => {
      const params = ctx.params;
      const term = ptyManager.createTerminal({
        sessionId: this.sessionRecordId,
        command: params.command,
        args: params.args,
        cwd: params.cwd || this.cwd,
        env: params.env,
      });
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
      return { output: res.output, exitCode: res.exitCode, exited: res.exited };
    });

    clientApp.onRequest(acp.methods.client.terminal.waitForExit, async (ctx: any) => {
      const { terminalId } = ctx.params;
      const res = await ptyManager.waitForExit(terminalId);
      return { exitCode: res.exitCode, output: res.output };
    });

    clientApp.onRequest(acp.methods.client.terminal.kill, async (ctx: any) => {
      const { terminalId } = ctx.params;
      ptyManager.kill(terminalId);
      this.emit('terminalReleased', terminalId);
      return {};
    });

    clientApp.onRequest(acp.methods.client.terminal.release, async (ctx: any) => {
      const { terminalId } = ctx.params;
      ptyManager.release(terminalId);
      this.emit('terminalReleased', terminalId);
      return {};
    });

    // 3. Filesystem reading & writing
    clientApp.onRequest(acp.methods.client.fs.readTextFile, async (ctx: any) => {
      const filePath = path.isAbsolute(ctx.params.path)
        ? ctx.params.path
        : path.join(this.cwd, ctx.params.path);
      const content = fs.readFileSync(filePath, 'utf8');
      return { content };
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

          const record: ToolCallRecord = {
            id: update.toolCallId,
            title: title || 'Tool Call',
            kind: update.kind,
            status: update.status || 'completed',
            input,
            output: outputStr,
            error: update.rawOutput?.error,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
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

    this.child.on('error', (err) => {
      this.emit('error', err);
    });

    this.child.on('exit', () => {
      this.emit('closed');
    });

    // Perform ACP initialize handshake
    const initRes = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    this.isInitialized = true;

    // Handle agent authentication if advertised
    if (initRes.authMethods && initRes.authMethods.length > 0) {
      for (const method of initRes.authMethods) {
        if (method.type !== 'terminal') {
          try {
            await this.connection.agent.request(acp.methods.agent.authenticate, {
              methodId: method.id,
            });
            break;
          } catch {
            // If already authenticated via local environment or keychain, continue
          }
        }
      }
    }

    // Create session in agent
    const sessionRes = await this.connection.agent.request(acp.methods.agent.session.new, {
      cwd: this.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionRes.sessionId;

    // Apply model if specified
    if (this.model) {
      const modelToSend = this.agent.id === 'claude' ? normalizeClaudeModel(this.model) : this.model;
      try {
        await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: 'model',
          value: modelToSend,
        });
      } catch {
        // Fallback gracefully if agent doesn't support session/setConfigOption
      }
    }

    // Apply effort if specified
    if (this.effort) {
      try {
        await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.sessionId,
          configId: 'effort',
          value: this.effort,
        });
      } catch {
        // Fallback gracefully if agent doesn't support effort config
      }
    }
  }

  async sendPrompt(text: string, attachments?: FileAttachment[]): Promise<{ stopReason: string }> {
    if (!this.connection || !this.sessionId) {
      throw new Error('ACP Client not connected or initialized');
    }

    this.isTurnInFlight = true;
    this.lastActivityAt = Date.now();
    try {
      const promptBlocks: any[] = [];
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

      let res: any;
      try {
        res = await this.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: this.sessionId,
          prompt: promptBlocks,
        });
      } catch (err: any) {
        // If image block was rejected by the agent, fall back to pure text prompt with file path references
        if (promptBlocks.length > 1 && (err.message?.includes('image') || err.message?.includes('modality') || err.message?.includes('capability'))) {
          console.warn(`[client-host] Image prompt rejected by agent, retrying with text fallback: ${err.message}`);
          res = await this.connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text }],
          });
        } else {
          throw err;
        }
      }

      const stopReason = res?.stopReason || 'end_turn';
      this.emit('turnCompleted', stopReason);
      return { stopReason };
    } catch (err: any) {
      this.emit('error', err);
      // Guarantee turnCompleted is fired even when an error occurs so UI state never freezes
      this.emit('turnCompleted', 'error');
      throw err;
    } finally {
      this.isTurnInFlight = false;
      this.lastActivityAt = Date.now();
    }
  }

  async cancel(): Promise<void> {
    this.isTurnInFlight = false;
    this.lastActivityAt = Date.now();
    if (this.activePendingPermission) {
      try {
        this.activePendingPermission.resolve({ outcome: { outcome: 'rejected' } });
      } catch {
        // ignore
      }
      this.activePendingPermission = null;
    }
    if (!this.connection || !this.sessionId) return;
    try {
      await this.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.sessionId,
      });
    } catch {
      // ignore
    }
  }

  resolvePermission(optionId: string): boolean {
    if (!this.activePendingPermission) return false;
    const { data, resolve } = this.activePendingPermission;
    this.activePendingPermission = null;

    if (optionId === 'reject' || optionId === 'deny') {
      resolve({ outcome: { outcome: 'rejected' } });
    } else {
      resolve({ outcome: { outcome: 'selected', optionId } });
    }

    this.emit('permissionResolved', data.requestId);
    return true;
  }

  shutdown(): void {
    if (this.activePendingPermission) {
      try {
        this.activePendingPermission.resolve({ outcome: { outcome: 'rejected' } });
      } catch {
        // ignore
      }
      this.activePendingPermission = null;
    }
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
          }, 2000);
        }
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.connection = null;
  }
}
