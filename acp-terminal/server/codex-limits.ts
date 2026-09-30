import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { VendorRateLimits } from './subscriptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CODEX = path.resolve(__dirname, '../node_modules/.bin/codex');
const READ_TIMEOUT_MS = 15_000;
const STALE_MS = 3 * 60_000;

let cached: VendorRateLimits = { updatedAt: 0 };
let inflight: Promise<VendorRateLimits> | null = null;

/** "5-hour window", "Weekly window", "30-day window" from Codex's window length in minutes. */
export function codexWindowLabel(mins: number | null | undefined): string {
  if (!mins) return 'Usage window';
  if (mins === 10_080) return 'Weekly window';
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

interface CodexWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  planType?: string | null;
}

/** Map an `account/rateLimits/read` result onto the vendor limits the UI renders. */
export function parseCodexRateLimits(result: { rateLimits?: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot> }): VendorRateLimits {
  const byId = Object.values(result.rateLimitsByLimitId || {}).filter(Boolean);
  const snapshots = byId.length > 0 ? byId : result.rateLimits ? [result.rateLimits] : [];
  const windows: NonNullable<VendorRateLimits['windows']> = [];
  let credits: string | undefined;
  let planType: string | undefined;
  for (const snap of snapshots) {
    // Only name the limit when there are several, e.g. a separate one for a specific model
    const prefix = snapshots.length > 1 && snap.limitName ? `${snap.limitName}, ` : '';
    for (const w of [snap.primary, snap.secondary]) {
      if (!w) continue;
      windows.push({
        name: `${prefix}${codexWindowLabel(w.windowDurationMins)}`,
        utilization: w.usedPercent,
        resetsAtMs: w.resetsAt ? w.resetsAt * 1000 : undefined,
      });
    }
    const c = snap.credits;
    if (c && credits === undefined) credits = c.unlimited ? 'Unlimited' : c.hasCredits && c.balance ? c.balance : 'None';
    planType ??= snap.planType || undefined;
  }
  return { windows, credits, planType, updatedAt: Date.now() };
}

/**
 * Ask the Codex app-server for the account's rate limits. This is a read-only account call
 * (what `/status` shows), so it runs no turn and costs nothing against the limits it reports.
 */
function readFromAppServer(): Promise<VendorRateLimits> {
  return new Promise((resolve, reject) => {
    const bin = process.env.CODEX_BIN || (fs.existsSync(LOCAL_CODEX) ? LOCAL_CODEX : 'codex');
    const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const finish = (err: Error | null, value?: VendorRateLimits) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Codex did not report rate limits in time')), READ_TIMEOUT_MS);
    child.on('error', (err) => finish(err));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read' }) + '\n');
        } else if (msg.id === 2) {
          if (msg.error) finish(new Error(msg.error.message || 'Codex refused the rate limit read'));
          else finish(null, parseCodexRateLimits(msg.result || {}));
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codepit', version: '0.1.0' } } }) + '\n');
  });
}

export function refreshCodexRateLimitsAsync(): Promise<VendorRateLimits> {
  inflight ??= readFromAppServer()
    .then((limits) => (cached = limits))
    .catch((err) => {
      console.error(`[codex-limits] ${err.message}`);
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Cached limits, refreshed in the background once they are a few minutes old. */
export function getCodexRateLimits(): VendorRateLimits {
  if (Date.now() - (cached.updatedAt || 0) > STALE_MS) void refreshCodexRateLimitsAsync();
  return cached;
}
