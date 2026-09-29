import { EventEmitter } from 'node:events';
import * as nodePty from 'node-pty';
import os from 'node:os';
import fs from 'node:fs';

export interface TerminalInstance {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  proc: nodePty.IPty;
  outputBuffer: string;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  // Set once output has been dropped from the front of the buffer
  truncated: boolean;
  outputByteLimit?: number;
  startedAt: number;
  exitedAt: number | null;
}

const MAX_BUFFER_CHARS = 2 * 1024 * 1024;

/** Normalise ACP's `[{ name, value }]` env list (or a plain record) into a record. */
function envToRecord(env?: Array<{ name: string; value: string }> | Record<string, string>): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const entry of env) {
      if (entry && typeof entry.name === 'string') out[entry.name] = String(entry.value ?? '');
    }
    return out;
  }
  return env;
}

/** Append output, keeping the buffer within the terminal's byte limit (or the global cap). */
function appendOutput(instance: TerminalInstance, data: string): void {
  instance.outputBuffer += data;
  if (instance.outputByteLimit !== undefined) {
    const buf = Buffer.from(instance.outputBuffer, 'utf8');
    if (buf.length > instance.outputByteLimit) {
      // Drop whole characters from the front: skip UTF-8 continuation bytes at the cut point
      let start = buf.length - instance.outputByteLimit;
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
      instance.outputBuffer = buf.subarray(start).toString('utf8');
      instance.truncated = true;
    }
  } else if (instance.outputBuffer.length > MAX_BUFFER_CHARS) {
    // Cap buffer at 2MB to prevent memory bloat
    instance.outputBuffer = instance.outputBuffer.slice(-1024 * 1024);
    instance.truncated = true;
  }
}

export class PtyManager extends EventEmitter {
  private terminals = new Map<string, TerminalInstance>();

  createTerminal(opts: {
    id?: string;
    sessionId: string;
    command: string;
    args?: string[];
    cwd: string;
    env?: Array<{ name: string; value: string }> | Record<string, string>;
    outputByteLimit?: number;
    cols?: number;
    rows?: number;
  }): TerminalInstance {
    const id = opts.id || `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const cwd = fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();

    const shell = process.env.SHELL || '/bin/zsh';
    const fullCommand = opts.args && opts.args.length > 0 
      ? `${opts.command} ${opts.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}` 
      : opts.command;

    const mergedEnv = {
      ...process.env,
      ...envToRecord(opts.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ACP_TERMINAL: '1',
    };

    const proc = nodePty.spawn(shell, ['-l', '-c', fullCommand], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: mergedEnv as Record<string, string>,
    });

    const instance: TerminalInstance = {
      id,
      sessionId: opts.sessionId,
      command: fullCommand,
      cwd,
      proc,
      outputBuffer: '',
      exited: false,
      exitCode: null,
      signal: null,
      truncated: false,
      outputByteLimit: typeof opts.outputByteLimit === 'number' && opts.outputByteLimit >= 0 ? opts.outputByteLimit : undefined,
      startedAt: Date.now(),
      exitedAt: null,
    };

    proc.onData((data: string) => {
      appendOutput(instance, data);
      this.emit('data', { id, sessionId: opts.sessionId, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      instance.exited = true;
      instance.exitCode = exitCode;
      instance.signal = signal ? signalName(signal) : null;
      instance.exitedAt = Date.now();
      this.emit('exit', { id, sessionId: opts.sessionId, exitCode });
    });

    this.terminals.set(id, instance);
    return instance;
  }

  getOrCreateSessionTerminal(sessionId: string, cwd: string, cols = 100, rows = 30): TerminalInstance {
    const key = `session-term-${sessionId}`;
    const existing = this.terminals.get(key);
    if (existing && !existing.exited) {
      return existing;
    }

    const shell = process.env.SHELL || '/bin/zsh';
    const mergedEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ACP_TERMINAL: '1',
    };

    const targetCwd = fs.existsSync(cwd) ? cwd : os.homedir();
    const proc = nodePty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: targetCwd,
      env: mergedEnv as Record<string, string>,
    });

    const instance: TerminalInstance = {
      id: key,
      sessionId,
      command: `${shell} (interactive)`,
      cwd: targetCwd,
      proc,
      outputBuffer: '',
      exited: false,
      exitCode: null,
      signal: null,
      truncated: false,
      startedAt: Date.now(),
      exitedAt: null,
    };

    proc.onData((data: string) => {
      appendOutput(instance, data);
      this.emit('data', { id: key, sessionId, data });
    });

    proc.onExit(({ exitCode }) => {
      instance.exited = true;
      instance.exitCode = exitCode;
      instance.exitedAt = Date.now();
      this.emit('exit', { id: key, sessionId, exitCode });
    });

    this.terminals.set(key, instance);
    return instance;
  }

  logAgentActivityToSessionTerminal(sessionId: string, message: string): void {
    const key = `session-term-${sessionId}`;
    const term = this.terminals.get(key);
    if (term && !term.exited) {
      term.proc.write(`\r\n\x1b[36m⚡ [Agent]: ${message}\x1b[0m\r\n`);
    }
  }

  getTerminal(id: string): TerminalInstance | null {
    return this.terminals.get(id) ?? null;
  }

  getOutput(id: string): { output: string; truncated: boolean; exitCode: number | null; signal: string | null; exited: boolean } | null {
    const term = this.terminals.get(id);
    if (!term) return null;
    return {
      output: term.outputBuffer,
      truncated: term.truncated,
      exitCode: term.exitCode,
      signal: term.signal,
      exited: term.exited,
    };
  }

  /** Resolves when the command exits; no timeout, since the agent can end a long run with terminal/kill. */
  async waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null; output: string }> {
    const term = this.terminals.get(id);
    if (!term) throw new Error(`Terminal ${id} not found`);
    if (term.exited) {
      return { exitCode: term.exitCode, signal: term.signal, output: term.outputBuffer };
    }

    return new Promise((resolve) => {
      const onExit = (evt: { id: string; exitCode: number | null }) => {
        if (evt.id === id) {
          this.off('exit', onExit);
          resolve({ exitCode: evt.exitCode, signal: term.signal, output: term.outputBuffer });
        }
      };
      this.on('exit', onExit);
    });
  }

  write(id: string, data: string): boolean {
    const term = this.terminals.get(id);
    if (!term || term.exited) return false;
    term.proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(id);
    if (!term || term.exited) return false;
    try {
      term.proc.resize(cols, rows);
      return true;
    } catch {
      return false;
    }
  }

  kill(id: string): boolean {
    const term = this.terminals.get(id);
    if (!term || term.exited) return false;
    try {
      term.proc.kill();
      return true;
    } catch {
      return false;
    }
  }

  release(id: string): void {
    const term = this.terminals.get(id);
    if (!term) return;
    this.terminals.delete(id);
    if (!term.exited) {
      try {
        term.proc.kill();
      } catch {
        // ignore
      }
      // Wake any waitForExit() on a terminal released before its command finished
      this.emit('exit', { id, sessionId: term.sessionId, exitCode: null });
    }
  }

  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
  }
}

function signalName(signal: number): string {
  const entry = Object.entries(os.constants.signals).find(([, num]) => num === signal);
  return entry ? entry[0] : String(signal);
}

export const ptyManager = new PtyManager();
