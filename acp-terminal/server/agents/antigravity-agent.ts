#!/usr/bin/env node
/**
 * Google Antigravity over ACP, through Antigravity's own CLI (`agy`) in headless stream-json
 * mode: one `agy` process per session reads a user message per line and streams typed events
 * (`init`, `step_update`, `result`) back. The session id is Antigravity's conversation id, so
 * the session continues across restarts (`--conversation`).
 *
 * Headless `agy` cannot ask for approval: what a turn may do is set up front by the approval
 * mode, and anything else is refused and reported as `denied_actions`.
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FALLBACK_MODELS, groupModels, type ModelChoice } from './antigravity-models.js';

const execFileAsync = promisify(execFile);

const LOCAL_AGY = path.join(os.homedir(), '.local/bin/agy');
const AGY = process.env.AGY_PATH || (fs.existsSync(LOCAL_AGY) ? LOCAL_AGY : 'agy');
// agy prints its conversation id as soon as it starts; this long means it is stuck (e.g. signed out)
const START_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------------ Options

/** Approval modes. agy's own default has no flag; the others map to `--mode` or the skip flag. */
const MODES = [
  { value: 'default', name: 'Read only', description: 'Reads and searches. Edits and commands are refused, unless allowed in agy settings.' },
  { value: 'acceptEdits', name: 'Accept edits', description: 'Also edits files in the folder. Commands are refused.' },
  { value: 'plan', name: 'Plan', description: 'Plans the work without changing anything.', kind: 'plan' },
  { value: 'full-access', name: 'Full access', description: 'Edits files and runs commands without asking.', kind: 'full_access' },
] as const;
type Mode = (typeof MODES)[number]['value'];

const modeArgs = (mode: Mode): string[] =>
  mode === 'acceptEdits' ? ['--mode', 'accept-edits'] : mode === 'plan' ? ['--mode', 'plan'] : mode === 'full-access' ? ['--dangerously-skip-permissions'] : [];

let modelsCache: Promise<ModelChoice[]> | null = null;
function listModels(): Promise<ModelChoice[]> {
  modelsCache ??= execFileAsync(AGY, ['models'], { timeout: 30_000 })
    .then(({ stdout }) => {
      const models = groupModels(stdout);
      return models.length > 0 ? models : FALLBACK_MODELS;
    })
    .catch(() => FALLBACK_MODELS);
  return modelsCache;
}

// ------------------------------------------------------------------ Sessions

interface Turn {
  send: (update: Record<string, unknown>) => Promise<void>;
  resolve: (stopReason: 'end_turn' | 'cancelled') => void;
  reject: (err: Error) => void;
  cancelled: boolean;
  /** Tool steps already announced, by step index. */
  tools: Set<number>;
}

interface Session {
  id: string;
  cwd: string;
  model: string;
  effort?: string;
  mode: Mode;
  proc: ChildProcess | null;
  /** The flags the running process was started with; a change takes a restart. */
  procFlags?: string;
  turn: Turn | null;
  stderr: string;
}

class AntigravityAcpAgent {
  private sessions = new Map<string, Session>();

  async initialize(_params: unknown) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { resume: {} },
      },
      agentInfo: { name: 'google-antigravity-acp', version: '2.0.0' },
    };
  }

  async newSession(params: { cwd?: string }) {
    return this.open(params?.cwd || process.cwd());
  }

  /** Continue an Antigravity conversation: agy fails to start when it does not know the id. */
  async resumeSession(params: { sessionId: string; cwd?: string }) {
    return this.open(params?.cwd || process.cwd(), params.sessionId);
  }

  private async open(cwd: string, conversationId?: string) {
    const models = await listModels();
    const wanted = process.env.MODEL || '';
    const model = models.find((m) => m.value === wanted || `${m.value}-${m.efforts.at(-1)}` === wanted) ?? models[0];
    const session: Session = {
      id: conversationId ?? '',
      cwd,
      model: model.value,
      effort: defaultEffort(model),
      mode: 'default',
      proc: null,
      turn: null,
      stderr: '',
    };
    // Started now for its conversation id, which is the session id
    session.id = await this.start(session, conversationId);
    this.sessions.set(session.id, session);
    return { sessionId: session.id, configOptions: await this.configOptions(session) };
  }

  async setConfigOption(params: { sessionId: string; configId: string; value: unknown }) {
    const session = this.require(params.sessionId);
    const value = String(params.value);
    const models = await listModels();
    if (params.configId === 'model') {
      const model = models.find((m) => m.value === value);
      if (!model) throw new Error(`Unknown Antigravity model: ${value}`);
      session.model = model.value;
      // Keep the effort when the new model has it, else its default
      if (!session.effort || !model.efforts.includes(session.effort)) session.effort = defaultEffort(model);
    } else if (params.configId === 'effort') {
      const model = models.find((m) => m.value === session.model);
      if (!model?.efforts.includes(value)) throw new Error(`${model?.name ?? session.model} has no "${value}" effort`);
      session.effort = value;
    } else if (params.configId === 'mode') {
      const mode = MODES.find((m) => m.value === value);
      if (!mode) throw new Error(`Unknown approval mode: ${value}`);
      session.mode = mode.value;
    } else {
      throw new Error(`Unknown option: ${params.configId}`);
    }
    // agy takes these as flags: the next message starts it again with them, in the same conversation
    return { configOptions: await this.configOptions(session) };
  }

  async prompt(params: { sessionId: string; prompt: any[] }, cx: any) {
    const session = this.require(params.sessionId);
    if (session.turn) throw new Error('A turn is already running');
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    // Images come back as file paths in the text (CodePit retries without them)
    if (blocks.some((b) => b?.type === 'image')) throw new Error('Antigravity takes no image input here');
    const text = blocks
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'resource_link' ? b.uri : ''))
      .filter(Boolean)
      .join('\n');

    if (!session.proc || session.procFlags !== flagsOf(session)) {
      await this.stop(session);
      await this.start(session, session.id);
    }

    const send = (update: Record<string, unknown>) => cx.notify(acp.methods.client.session.update, { sessionId: session.id, update });
    return new Promise<{ stopReason: 'end_turn' | 'cancelled' }>((resolve, reject) => {
      session.turn = {
        send,
        resolve: (stopReason) => {
          session.turn = null;
          resolve({ stopReason });
        },
        reject: (err) => {
          session.turn = null;
          reject(err);
        },
        cancelled: false,
        tools: new Set(),
      };
      session.proc!.stdin!.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
    });
  }

  /** agy takes no cancel message mid-turn; an interrupt ends the turn at once and the process with it. */
  async cancel(params: { sessionId: string }) {
    const session = this.sessions.get(params.sessionId);
    if (!session?.turn || !session.proc) return;
    session.turn.cancelled = true;
    session.proc.kill('SIGINT');
  }

  // ---------------------------------------------------------------- agy process

  /** Start agy for the session (continuing `conversationId` when given); resolves with its conversation id. */
  private start(session: Session, conversationId?: string): Promise<string> {
    const model = session.effort ? `${session.model}-${session.effort}` : session.model;
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', model,
      ...modeArgs(session.mode),
      ...(conversationId ? ['--conversation', conversationId] : []),
      '-p=',
    ];
    const proc = spawn(AGY, args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    session.proc = proc;
    session.procFlags = flagsOf(session);
    session.stderr = '';

    return new Promise<string>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (started) return;
        proc.kill();
        reject(new Error('Antigravity (agy) did not start. Run `agy` in a terminal once to sign in, then try again.'));
      }, START_TIMEOUT_MS);

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const message = err.code === 'ENOENT' ? `The Antigravity CLI (agy) was not found at ${AGY}. Install it from Antigravity, or set AGY_PATH.` : err.message;
        if (!started) reject(new Error(message));
        else session.turn?.reject(new Error(message));
      });
      proc.stderr!.on('data', (d) => {
        session.stderr = (session.stderr + d).slice(-4000);
      });
      readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.event === 'init' && !started) {
          started = true;
          clearTimeout(timer);
          resolve(String(event.conversation_id || conversationId || ''));
          return;
        }
        void this.onEvent(session, event).catch(() => {});
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (session.proc === proc) session.proc = null;
        if (!started) {
          reject(new Error(lastError(session.stderr) || `Antigravity (agy) exited (code ${code}) before starting`));
          return;
        }
        // A turn still open when agy goes: stopped by the user, or agy failed
        const turn = session.turn;
        if (!turn) return;
        if (turn.cancelled) turn.resolve('cancelled');
        else turn.reject(new Error(lastError(session.stderr) || `Antigravity (agy) exited (code ${code})`));
      });
    });
  }

  private async stop(session: Session): Promise<void> {
    const proc = session.proc;
    if (!proc) return;
    session.proc = null;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.stdin?.end();
    const timer = setTimeout(() => proc.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }

  private async onEvent(session: Session, event: any): Promise<void> {
    const turn = session.turn;
    if (!turn) return;
    if (event.event === 'step_update') return this.onStep(session, turn, event.step_update ?? {});
    if (event.event !== 'result') return;

    const result = event.result ?? {};
    if (turn.cancelled) {
      turn.resolve('cancelled');
      return;
    }
    const usage = result.usage;
    if (typeof usage?.input_tokens === 'number') {
      await turn.send({ sessionUpdate: 'usage_update', used: usage.input_tokens + (usage.output_tokens || 0) });
    }
    const notes: string[] = [];
    if (result.status === 'ERROR' && result.error) notes.push(`⚠️ Antigravity stopped: ${result.error}`);
    const denied: string[] = (Array.isArray(result.denied_actions) ? result.denied_actions : [])
      .map((d: any) => DENIED_ACTIONS[d?.action] ?? d?.display_name ?? d?.action)
      .filter((d: unknown): d is string => typeof d === 'string');
    if (denied.length > 0) {
      const unique = [...new Set(denied)];
      notes.push(
        `Antigravity was not allowed to ${unique.join(' or ')}. It cannot ask for approval here, so change the approval mode ` +
          `(Accept edits for file changes, Full access for commands too) and ask again.`
      );
    }
    if (notes.length > 0) {
      await turn.send({
        sessionUpdate: 'agent_message_chunk',
        messageId: `${session.id}-notes-${Date.now()}`,
        content: { type: 'text', text: notes.join('\n\n') },
      });
    }
    turn.resolve('end_turn');
  }

  private async onStep(session: Session, turn: Turn, step: any): Promise<void> {
    const index = Number(step.step_index);
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
      // One message per step, so replies either side of a tool call stay apart
      await turn.send({
        sessionUpdate: 'agent_message_chunk',
        messageId: `${session.id}-${index}`,
        content: { type: 'text', text: step.text_delta },
      });
      return;
    }
    if (step.step_type !== 'tool') return;
    const info = step.tool_info ?? {};
    const name: string = step.tool_name || info.name || 'tool';
    const toolCallId = `${session.id}-${index}`;
    const input = toolInput(name, info.parameters ?? {});
    if (!turn.tools.has(index)) {
      turn.tools.add(index);
      await turn.send({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolTitle(name, input),
        kind: toolKind(name),
        status: 'in_progress',
        rawInput: input,
      });
    }
    if (step.state === 'DONE') {
      await turn.send({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        ...(info.output !== undefined ? { rawOutput: { output: typeof info.output === 'string' ? info.output : JSON.stringify(info.output) } } : {}),
      });
    } else if (step.state === 'ERROR') {
      const message = typeof info.error?.message === 'string' ? info.error.message.split('\n')[0] : 'The tool failed';
      await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { error: message } });
    }
  }

  // ---------------------------------------------------------------- helpers

  private require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private async configOptions(session: Session): Promise<acp.SessionConfigOption[]> {
    const models = await listModels();
    const model = models.find((m) => m.value === session.model);
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: session.model,
        options: models.map((m) => ({ value: m.value, name: m.name })),
      },
      // Only for models that come in more than one level
      ...(model && model.efforts.length > 1 && session.effort
        ? [
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select' as const,
              currentValue: session.effort,
              options: model.efforts.map((e) => ({ value: e, name: e.charAt(0).toUpperCase() + e.slice(1) })),
            },
          ]
        : []),
      {
        id: 'mode',
        name: 'Approval mode',
        category: 'mode',
        type: 'select' as const,
        currentValue: session.mode,
        options: MODES.map((m) => ({
          value: m.value,
          name: m.name,
          description: m.description,
          ...('kind' in m ? { _meta: { kind: m.kind } } : {}),
        })),
      },
    ];
  }
}

function defaultEffort(model: ModelChoice): string | undefined {
  if (model.efforts.length === 0) return undefined;
  return model.efforts.includes('high') ? 'high' : model.efforts.at(-1);
}

// agy's permission names for what it was refused, in plain words
const DENIED_ACTIONS: Record<string, string> = {
  write_file: 'change files',
  command: 'run commands',
  read_url: 'open web pages',
  read_file: 'read files outside the folder',
};

const flagsOf = (s: Session) => `${s.model}|${s.effort ?? ''}|${s.mode}`;

/** agy's last `error:` line, which says why it stopped. */
function lastError(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const error = [...lines].reverse().find((l) => /^error:/i.test(l));
  return (error ?? lines.at(-1))?.replace(/^error:\s*/i, '');
}

/** agy's tool parameters, with the names CodePit shows commands and files by. */
function toolInput(name: string, params: Record<string, any>): Record<string, any> {
  const input: Record<string, any> = { ...params };
  if (typeof params.CommandLine === 'string') input.command = params.CommandLine;
  const file = params.AbsolutePath ?? params.TargetFile ?? params.FilePath ?? params.DirectoryPath;
  if (typeof file === 'string') input.path = file;
  if (typeof params.Query === 'string') input.query = params.Query;
  if (typeof params.Url === 'string') input.url = params.Url;
  if (name === 'run_command' && typeof params.Cwd === 'string') input.cwd = params.Cwd;
  return input;
}

function toolKind(name: string): string {
  if (name === 'run_command' || name.startsWith('command_')) return 'execute';
  if (/write|replace|edit|create_file|multi_replace/.test(name)) return 'edit';
  if (/delete/.test(name)) return 'delete';
  if (/^(view|read)_/.test(name)) return 'read';
  if (/search|grep|find|list_dir/.test(name)) return 'search';
  if (/url|web|fetch|browser/.test(name)) return 'fetch';
  return 'other';
}

function toolTitle(name: string, input: Record<string, any>): string {
  if (input.command) return String(input.command);
  const kind = toolKind(name);
  if (input.path && (kind === 'edit' || kind === 'read' || kind === 'delete')) return `${kind === 'read' ? 'Read' : kind === 'delete' ? 'Delete' : 'Edit'}: ${input.path}`;
  if (input.query) return `${name}: ${input.query}`;
  if (input.url) return `${name}: ${input.url}`;
  if (input.path) return `${name}: ${input.path}`;
  return name;
}

async function main() {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const agent = new AntigravityAcpAgent();

  acp
    .agent({ name: 'antigravity-acp' })
    .onRequest('initialize', (ctx: any) => agent.initialize(ctx.params))
    .onRequest('session/new', (ctx: any) => agent.newSession(ctx.params))
    .onRequest('session/resume', (ctx: any) => agent.resumeSession(ctx.params))
    .onRequest('session/set_config_option', (ctx: any) => agent.setConfigOption(ctx.params))
    .onRequest('session/prompt', (ctx: any) => agent.prompt(ctx.params, ctx.client))
    .onNotification('session/cancel', (ctx: any) => agent.cancel(ctx.params))
    .connect(stream);
}

main().catch((err) => {
  console.error('[antigravity-agent] Fatal error:', err);
  process.exit(1);
});
