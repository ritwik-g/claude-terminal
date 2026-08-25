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

/**
 * Claude Code encodes a project's cwd by replacing every '/' and '_' with '-',
 * which is lossy: '-Users-ritwikg-personal-claude-sessions' could be
 * claude-sessions or claude_sessions. We recover the true cwd from the `cwd`
 * field inside the transcript instead, and only use this as a fallback.
 */
export function decodeProjectKey(key: string): string {
  return '/' + key.replace(/^-/, '').replace(/-/g, '/');
}
