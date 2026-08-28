import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
/** Claude Code's own live-process registry: <pid>.json per running session. */
export const LIVE_DIR = path.join(CLAUDE_DIR, 'sessions');

/** Our own state lives outside ~/.claude so we never risk corrupting Claude's data. */
export const APP_DIR = path.join(HOME, '.claude-terminal');
export const STATE_FILE = path.join(APP_DIR, 'state.json');
export const INDEX_CACHE = path.join(APP_DIR, 'index-cache.json');
export const LOG_DIR = path.join(APP_DIR, 'logs');
/** Per-run API token, so a second local account cannot drive the server. */
export const TOKEN_FILE = path.join(APP_DIR, 'token');

/**
 * Everything we persist is derived from Claude Code's transcripts, which it
 * writes 0600 — scrollback logs are the raw session stream, and the state and
 * cache files carry prompt text and cwds. Writing any of it at the default
 * umask (0644 in a 0755 dir) would republish 0600 data to every other account
 * on the machine, so all of it is created private.
 */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * mkdirSync's `mode` is ignored when the directory already exists, so an
 * install created by an earlier version keeps its 0755 forever unless the mode
 * is set explicitly afterwards. Both steps are needed; neither is redundant.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    /* not ours to chmod — the write below will fail loudly enough */
  }
}

/**
 * One-shot repair for installs written by a version that used the default
 * umask. Best-effort throughout: a file we cannot chmod is not a reason to
 * refuse to start.
 */
export function repairPrivateModes(): void {
  for (const dir of [APP_DIR, LOG_DIR]) {
    try {
      if (!fs.existsSync(dir)) continue;
      fs.chmodSync(dir, DIR_MODE);
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isFile()) fs.chmodSync(full, FILE_MODE);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
}

/**
 * Claude Code encodes a project's cwd by replacing every '/' and '_' with '-',
 * which is lossy: '-Users-ritwikg-personal-claude-sessions' could be
 * claude-sessions or claude_sessions. We recover the true cwd from the `cwd`
 * field inside the transcript instead, and only use this as a fallback.
 */
export function decodeProjectKey(key: string): string {
  return '/' + key.replace(/^-/, '').replace(/-/g, '/');
}
