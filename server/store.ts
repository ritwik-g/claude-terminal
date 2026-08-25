import fs from 'node:fs';
import { APP_DIR, STATE_FILE } from './paths.js';
import { EMPTY_USER_STATE, type UserState } from './types.js';

interface StoreShape {
  version: number;
  sessions: Record<string, Partial<UserState>>;
}

/**
 * Null-prototype, because session ids are attacker-shaped keys as far as this
 * map is concerned. With a normal object, `data.sessions['__proto__'] = next`
 * REPLACES the map's prototype: subsequent reads for ids named `tags`, `note`
 * etc. inherit from it and return a corrupted UserState, and the row can never
 * be deleted or persisted (JSON.stringify skips __proto__).
 */
const emptySessions = (): Record<string, Partial<UserState>> => Object.create(null);

let data: StoreShape = { version: 1, sessions: emptySessions() };
let dirty = false;
/**
 * Set when state.json exists but could not be read or parsed. Every flush is a
 * whole-file write-then-rename, so flushing over a file we failed to load would
 * replace all of the user's tags, pins, priorities and snoozes with an empty
 * object — the one silent total-data-loss path in the tool. A missing file
 * (first run) is not this case.
 */
let loadFailed = false;

export function loadStore(): void {
  loadFailed = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const sessions = emptySessions();
    if (parsed && typeof parsed === 'object' && parsed.sessions) {
      // Copy onto a null-prototype object; a hostile key in the file on disk
      // must not become this map's prototype either.
      for (const [k, v] of Object.entries(parsed.sessions)) {
        if (!isSafeKey(k)) continue;
        if (!v || typeof v !== 'object') continue;
        const row = v as Partial<UserState>;
        // A non-array `tags` on disk made allTags() throw, which rejected the
        // whole sessions build. Normalise rather than trust the file.
        if (row.tags !== undefined && !Array.isArray(row.tags)) row.tags = [];
        else if (Array.isArray(row.tags)) row.tags = row.tags.filter((t) => typeof t === 'string');
        sessions[k] = row;
      }
    }
    data = { version: 1, sessions };
  } catch (err: any) {
    data = { version: 1, sessions: emptySessions() };
    if (err?.code !== 'ENOENT') {
      loadFailed = true;
      console.error(
        `[claude-terminal] could not read ${STATE_FILE} — refusing to overwrite it. ` +
        `Tags and priorities are read-only this session. Cause:`, err,
      );
    }
  }
}

/** Keys that would poison an object map even with a null prototype elsewhere. */
export function isSafeKey(id: string): boolean {
  return id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
}

/**
 * True when state.json exists but could not be read, so nothing can be saved.
 * Callers must surface this: silently accepting writes that will never be
 * persisted is worse than refusing them.
 */
export function isReadOnly(): boolean {
  return loadFailed;
}

export function getUserState(id: string): UserState {
  const stored = data.sessions[id];
  if (!stored) return { ...EMPTY_USER_STATE };
  return {
    ...EMPTY_USER_STATE,
    ...stored,
    tags: Array.isArray(stored.tags) ? stored.tags : [],
  };
}

export function setUserState(id: string, patch: Partial<UserState>): UserState {
  if (!isSafeKey(id)) return { ...EMPTY_USER_STATE };
  const next = { ...getUserState(id), ...patch };
  // Never persist a row that carries no information.
  const isEmpty =
    next.tags.length === 0 &&
    next.priority === null &&
    !next.pinned &&
    (next.snoozedUntil === null || next.snoozedUntil <= 0) &&
    !next.note &&
    !next.archived;
  if (isEmpty) delete data.sessions[id];
  else data.sessions[id] = next;
  dirty = true;
  scheduleFlush();
  return next;
}

/**
 * Tags of sessions that actually exist.
 *
 * A state row outlives its transcript (Claude Code's retention sweep, a manual
 * delete, a truncated file), and its tags kept appearing as filter chips with
 * nothing behind them. Filtering by ownership fixes that WITHOUT deleting
 * anything: `scanOne` swallows read errors and returns null, so a transient
 * failure (EMFILE, a locked file) would otherwise silently destroy the user's
 * tags for every session that momentarily failed to parse.
 */
export function allTags(known?: Set<string>): string[] {
  const set = new Set<string>();
  for (const [id, s] of Object.entries(data.sessions)) {
    if (known && !known.has(id)) continue;
    if (!Array.isArray(s?.tags)) continue;
    for (const t of s.tags) if (typeof t === 'string') set.add(t);
  }
  return [...set].sort();
}

/** True when we hold any state for this id, present in the index or not. */
export function hasUserState(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(data.sessions, id);
}

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushStore();
  }, 400);
}

export function flushStore(): void {
  if (!dirty) return;
  if (loadFailed) return;
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate your tags.
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    dirty = false;
  } catch (err) {
    // Keep dirty so the next flush retries — but say so, because on the
    // shutdown path there is no next flush and the edits are simply lost.
    console.error('[claude-terminal] failed to persist state:', err);
  }
}
