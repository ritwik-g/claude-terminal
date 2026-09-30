import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = os.homedir();

export function getAppDir(): string {
  if (process.env.NODE_ENV === 'test' && !process.env.ACP_APP_DIR) {
    process.env.ACP_APP_DIR = path.join(os.tmpdir(), `acp-terminal-test-${process.pid}`);
  }
  return process.env.ACP_APP_DIR || path.join(HOME, '.acp-terminal');
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
