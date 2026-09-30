import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where browser scripts write screenshots: $CODEPIT_SCREENSHOT_DIR, else a temp dir. Created on demand. */
export function screenshotDir(): string {
  const dir = process.env.CODEPIT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'codepit-screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fresh empty directory to use as a session's working directory. */
export function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-ws-'));
}
