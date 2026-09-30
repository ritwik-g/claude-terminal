import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '__CT_PATH__';

/** Where CLIs usually live when the shell cannot be asked. */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];

function askLoginShell(timeoutMs: number): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    // Interactive login, because that is where nvm, Homebrew and friends extend PATH.
    // The markers skip whatever the rc files print; stdin is closed so a prompt can't hang it.
    const child = spawn(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = out.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
      resolve(match ? match[1].trim() : null);
    });
  });
}

/**
 * An app opened from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:...),
 * so agents could not find claude, codex, agy, git or node. Adopt the PATH the
 * user's login shell builds, ahead of what we were given. Runs once at startup.
 */
export async function adoptLoginShellPath(timeoutMs = 5000): Promise<void> {
  if (process.platform === 'win32') return;
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const fromShell = await askLoginShell(timeoutMs);
  const preferred = fromShell
    ? fromShell.split(path.delimiter).filter(Boolean)
    : FALLBACK_DIRS.filter((d) => fs.existsSync(d));
  if (!fromShell) console.warn('[codepit] could not read PATH from the login shell; using common locations instead');
  process.env.PATH = [...new Set([...preferred, ...current])].join(path.delimiter);
}
