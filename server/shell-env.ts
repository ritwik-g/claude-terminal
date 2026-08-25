import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Recover the user's real shell environment.
 *
 * An app launched from Finder, Spotlight or the Dock inherits launchd's
 * environment, not a shell's — on this machine that means PATH is just
 * /usr/bin:/bin:/usr/sbin:/sbin. Anything installed by a version manager or
 * into ~/.local/bin is invisible, so `claude` is simply not found and the
 * terminal dies with exit code 127.
 *
 * Spawning a LOGIN shell is not enough on its own: zsh sources .zshrc only for
 * INTERACTIVE shells, and .zshrc is exactly where PATH additions usually live.
 * So we ask an interactive login shell what its environment is, once, and use
 * that for every terminal we spawn. This is the same approach VS Code takes,
 * and it fixes not just `claude` but every tool a session might invoke — git,
 * gh, node, docker — which matters because sessions run arbitrary commands.
 */

const MARKER = '__CT_ENV_a7f3__';
const TIMEOUT_MS = 8000;

let cached: Record<string, string> | null = null;
let attempted = false;

export function resolveShellEnv(): Record<string, string> | null {
  if (attempted) return cached;
  attempted = true;

  const shell = process.env.SHELL;
  // Windows is out of scope, and without a shell there is nothing to ask.
  if (!shell || process.platform === 'win32') return null;

  try {
    // -i so rc files (.zshrc/.bashrc) are read; -l so profile files are too.
    // Markers fence off anything the rc files print, which is common enough
    // (version-manager banners, motd) that parsing raw output is unreliable.
    const out = execFileSync(shell, ['-l', '-i', '-c', `echo ${MARKER}; env; echo ${MARKER}`], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TERM: 'dumb' },
    });

    const start = out.indexOf(MARKER);
    const end = out.lastIndexOf(MARKER);
    if (start < 0 || end <= start) return null;

    const env: Record<string, string> = {};
    for (const line of out.slice(start + MARKER.length, end).split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!env.PATH) return null;

    cached = env;
    return cached;
  } catch (err: any) {
    // A shell that hangs on an interactive prompt, or has no rc files, is not
    // an error worth failing over — we just fall back to the inherited env.
    console.error(
      '[claude-terminal] could not resolve the login shell environment ' +
      `(${err?.code ?? err?.message ?? err}); falling back to the inherited PATH.`,
    );
    return null;
  }
}

/** Directories worth trying even if the shell told us nothing. */
export function fallbackPathEntries(): string[] {
  const home = os.homedir();
  return [
    `${home}/.local/bin`,
    `${home}/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}
