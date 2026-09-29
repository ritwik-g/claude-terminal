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
  startedAt: number;
  exitedAt: number | null;
}

export class PtyManager extends EventEmitter {
  private terminals = new Map<string, TerminalInstance>();

  createTerminal(opts: {
    id?: string;
    sessionId: string;
    command: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
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
      ...opts.env,
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
      startedAt: Date.now(),
      exitedAt: null,
    };

    proc.onData((data: string) => {
      instance.outputBuffer += data;
      // Cap buffer at 2MB to prevent memory bloat
      if (instance.outputBuffer.length > 2 * 1024 * 1024) {
        instance.outputBuffer = instance.outputBuffer.slice(-1024 * 1024);
      }
      this.emit('data', { id, sessionId: opts.sessionId, data });
    });

    proc.onExit(({ exitCode }) => {
      instance.exited = true;
      instance.exitCode = exitCode;
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
      startedAt: Date.now(),
      exitedAt: null,
    };

    proc.onData((data: string) => {
      instance.outputBuffer += data;
      if (instance.outputBuffer.length > 2 * 1024 * 1024) {
        instance.outputBuffer = instance.outputBuffer.slice(-1024 * 1024);
      }
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

  getOutput(id: string): { output: string; exitCode: number | null; exited: boolean } | null {
    const term = this.terminals.get(id);
    if (!term) return null;
    return {
      output: term.outputBuffer,
      exitCode: term.exitCode,
      exited: term.exited,
    };
  }

  async waitForExit(id: string, timeoutMs = 60_000): Promise<{ exitCode: number | null; output: string }> {
    const term = this.terminals.get(id);
    if (!term) throw new Error(`Terminal ${id} not found`);
    if (term.exited) {
      return { exitCode: term.exitCode, output: term.outputBuffer };
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ exitCode: term.exitCode, output: term.outputBuffer });
      }, timeoutMs);

      const onExit = (evt: { id: string; exitCode: number | null }) => {
        if (evt.id === id) {
          cleanup();
          resolve({ exitCode: evt.exitCode, output: term.outputBuffer });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('exit', onExit);
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
    if (!term.exited) {
      try {
        term.proc.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.delete(id);
  }
}

export const ptyManager = new PtyManager();
