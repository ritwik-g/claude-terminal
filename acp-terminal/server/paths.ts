import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { appEnv } from './env.js';

export const HOME = os.homedir();
export const DEFAULT_APP_DIR = path.join(HOME, '.codepit');
/** Where the data lived before the rename to CodePit. */
export const LEGACY_APP_DIR = path.join(HOME, '.acp-terminal');

export function getAppDir(): string {
  if (process.env.NODE_ENV === 'test' && !appEnv('APP_DIR')) {
    process.env.CODEPIT_APP_DIR = path.join(os.tmpdir(), `codepit-test-${process.pid}`);
  }
  return appEnv('APP_DIR') || defaultAppDir();
}

let resolvedDefaultDir: string | null = null;

/** ~/.codepit, moving the data there from ~/.acp-terminal the first time it is needed. */
function defaultAppDir(): string {
  if (!resolvedDefaultDir) resolvedDefaultDir = migrateLegacyAppDir(LEGACY_APP_DIR, DEFAULT_APP_DIR);
  return resolvedDefaultDir;
}

/**
 * Move the data folder from its pre-rename location, once, and return the folder to use.
 * A link is left at the old path, so a CodePit (or CT) build from before the rename that is
 * still running, and absolute paths agents were given (uploaded files), keep resolving.
 * Paths saved in the app's own JSON files are rewritten to the new location.
 * If the move fails, the old folder stays in use and nothing is lost.
 */
export function migrateLegacyAppDir(legacyDir: string, targetDir: string): string {
  let legacy: fs.Stats;
  try {
    legacy = fs.lstatSync(legacyDir);
  } catch {
    return targetDir; // nothing to move
  }
  // Already moved (the old path is our link), or both exist: never merge, use the new one
  if (!legacy.isDirectory() || fs.existsSync(targetDir)) return targetDir;
  try {
    fs.renameSync(legacyDir, targetDir);
  } catch (err: any) {
    console.warn(`[codepit] Could not move ${legacyDir} to ${targetDir}; still using the old folder: ${err.message}`);
    return legacyDir;
  }
  try {
    fs.symlinkSync(targetDir, legacyDir, 'dir');
  } catch (err: any) {
    console.warn(`[codepit] Moved the data to ${targetDir}, but could not leave a link at ${legacyDir}: ${err.message}`);
  }
  rewriteSavedPaths(targetDir, legacyDir);
  console.log(`[codepit] Moved your data from ${legacyDir} to ${targetDir}`);
  return targetDir;
}

/** Point absolute paths saved in the app's JSON files (sessions, settings) at the moved folder. */
function rewriteSavedPaths(dir: string, legacyDir: string): void {
  const files: string[] = [];
  for (const sub of ['', 'sessions']) {
    try {
      for (const name of fs.readdirSync(path.join(dir, sub))) {
        if (name.endsWith('.json')) files.push(path.join(dir, sub, name));
      }
    } catch {
      // no such folder
    }
  }
  const from = legacyDir + path.sep;
  const to = dir + path.sep;
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes(from)) continue;
      const tmp = `${file}.migrating`;
      fs.writeFileSync(tmp, text.split(from).join(to), { mode: FILE_MODE });
      fs.renameSync(tmp, file);
    } catch (err: any) {
      // The link at the old path still resolves this file's paths
      console.warn(`[codepit] Could not update paths in ${file}: ${err.message}`);
    }
  }
}

export function getSessionsDir(): string {
  return path.join(getAppDir(), 'sessions');
}

export function getLogDir(): string {
  return path.join(getAppDir(), 'logs');
}

export function getStateFile(): string {
  return path.join(getAppDir(), 'state.json');
}

export function getTokenFile(): string {
  return path.join(getAppDir(), 'token');
}

export function getUploadsDir(): string {
  return path.join(getAppDir(), 'uploads');
}

export function getCredentialsFile(): string {
  return path.join(getAppDir(), 'credentials.json');
}

/** App-level preferences changed from the UI at runtime (e.g. LAN access). */
export function getSettingsFile(): string {
  return path.join(getAppDir(), 'settings.json');
}

// Dynamic backwards-compatibility getters (evaluated on property access, never frozen at module load)
export const paths = {
  get APP_DIR(): string { return getAppDir(); },
  get SESSIONS_DIR(): string { return getSessionsDir(); },
  get LOG_DIR(): string { return getLogDir(); },
  get STATE_FILE(): string { return getStateFile(); },
  get TOKEN_FILE(): string { return getTokenFile(); },
  get CREDENTIALS_FILE(): string { return getCredentialsFile(); },
  get UPLOADS_DIR(): string { return getUploadsDir(); },
  get SETTINGS_FILE(): string { return getSettingsFile(); },
};

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // best-effort chmod
  }
}

export function initStorage(): void {
  ensurePrivateDir(getAppDir());
  ensurePrivateDir(getSessionsDir());
  ensurePrivateDir(getLogDir());
}

let cachedTokenDir: string | null = null;
let activeToken: string | null = null;

export function getOrCreateToken(): string {
  const currentAppDir = getAppDir();
  if (activeToken && cachedTokenDir === currentAppDir) return activeToken;

  const tokenFile = getTokenFile();
  try {
    if (fs.existsSync(tokenFile)) {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing) {
        activeToken = existing;
        cachedTokenDir = currentAppDir;
        return activeToken;
      }
    }
  } catch {
    // regenerate if unreadable
  }

  ensurePrivateDir(currentAppDir);
  activeToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, activeToken, { mode: FILE_MODE, encoding: 'utf8' });
  cachedTokenDir = currentAppDir;
  return activeToken;
}
