import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, INDEX_CACHE, APP_DIR, FILE_MODE, ensurePrivateDir, decodeProjectKey } from './paths.js';
import type { PrLink, ReviewInfo, TailInfo } from './types.js';

const HEAD_BYTES = 256 * 1024;
/**
 * Per-session caps on indexed message text, split by who said it.
 *
 * Split rather than one shared budget because assistant turns are an order of
 * magnitude longer than yours: a single shared cap is spent on the first few
 * replies and never reaches a word you typed twenty turns in. Measured on this
 * corpus, a 2000-char shared budget failed to find terms that were plainly in
 * the conversation. Your own words get the larger share — they are what you
 * actually remember and search for.
 */
const SEARCH_USER_MAX = 12_000;
const SEARCH_ASSISTANT_MAX = 8_000;
const TAIL_BYTES = 1024 * 1024;

/**
 * Bump whenever the shape of a ScannedSession or the extraction logic changes,
 * otherwise a stale cache silently serves results from the old parser and the
 * fix you just made appears not to work.
 */
const CACHE_VERSION = 6;

export interface ScannedSession {
  id: string;
  file: string;
  projectKey: string;
  cwd: string;
  branch: string;
  title: string;
  titleSource: string;
  lastPrompt: string;
  recap: string;
  pr: PrLink | null;
  review: ReviewInfo | null;
  startedAt: number;
  lastActivity: number;
  sizeBytes: number;
  messages: number;
  version: string;
  tail: TailInfo;
  /**
   * Lowercased message text, for searching what was actually said rather than
   * only the metadata around it. Held server-side and stripped before the
   * session payload is sent: at ~2KB a session this would add megabytes to
   * every poll, for a field the client only ever needs to ask questions of.
   * Searching happens in searchIds() instead.
   */
  searchText: string;
}

interface CacheEntry extends ScannedSession {
  _mtimeMs: number;
  _size: number;
}

let cache = new Map<string, CacheEntry>();
let cacheDirty = false;

export function loadCache(): void {
  try {
    const raw = fs.readFileSync(INDEX_CACHE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      cache = new Map();
      return;
    }
    cache = new Map((parsed.entries as CacheEntry[]).map((e) => [e.file, e]));
  } catch {
    cache = new Map();
  }
}

const CACHE_WRITE_INTERVAL_MS = 60_000;
let lastCacheWrite = 0;

/**
 * The cache is purely a cold-boot optimisation, so it does not need to be
 * current — but it DOES change constantly: every live session appends to its
 * transcript, so a dirty check alone still rewrites ~128KB on every 2.5s poll.
 * Throttle it, and flush unconditionally on shutdown.
 */
export function saveCache(opts: { force?: boolean } = {}): void {
  if (!cacheDirty) return;
  if (!opts.force && Date.now() - lastCacheWrite < CACHE_WRITE_INTERVAL_MS) return;
  lastCacheWrite = Date.now();
  try {
    ensurePrivateDir(APP_DIR);
    fs.writeFileSync(
      INDEX_CACHE,
      JSON.stringify({ version: CACHE_VERSION, entries: [...cache.values()] }),
      { mode: FILE_MODE },
    );
    // Cleared only on success, so a failed write is retried rather than lost.
    cacheDirty = false;
  } catch {
    // a cache we cannot persist just means a slower next boot
  }
}

/**
 * Read the first HEAD_BYTES and last TAIL_BYTES of each transcript rather than
 * parsing it whole. Across ~1200 files / 600MB a full parse costs tens of
 * seconds; sampling costs well under a second and loses nothing we rank on,
 * because Claude Code re-emits titles, last-prompt and pr-link entries
 * throughout the file (latest wins, and the tail holds the latest).
 */
/**
 * Ids whose message text matches every term in `q`.
 *
 * Server-side because searchText is server-side: see ScannedSession. The
 * client still does its own matching over titles, tags, branches and the rest
 * — this only answers the question it cannot, "was this said anywhere in the
 * conversation", and the two results are unioned.
 */
export function searchIds(q: string): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: string[] = [];
  for (const e of cache.values()) {
    if (!e.searchText) continue;
    if (terms.every((t) => e.searchText.includes(t))) out.push(e.id);
  }
  return out;
}

export async function scanAll(): Promise<ScannedSession[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const jobs: (() => Promise<ScannedSession | null>)[] = [];
  for (const projectKey of projectDirs) {
    const dir = path.join(PROJECTS_DIR, projectKey);
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      jobs.push(() => scanOne(full, projectKey));
    }
  }

  const results = await runLimited(jobs, SCAN_CONCURRENCY);
  const sessions = results.filter((s): s is ScannedSession => s !== null);

  // Drop cache entries for transcripts that no longer exist.
  const alive = new Set(sessions.map((s) => s.file));
  for (const key of [...cache.keys()]) if (!alive.has(key)) { cache.delete(key); cacheDirty = true; }

  return sessions;
}

/**
 * Bound how many transcripts are open at once. An unbounded Promise.all held
 * ~135 file handles and 130MB of live buffers for this corpus — fine here, but
 * on the macOS default `ulimit -n` of 256 a larger corpus hits EMFILE, and
 * scanOne's catch would make those sessions silently vanish from the UI.
 */
const SCAN_CONCURRENCY = 24;

async function runLimited<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function scanOne(file: string, projectKey: string): Promise<ScannedSession | null> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  if (st.size === 0) return null;

  const hit = cache.get(file);
  if (hit && hit._mtimeMs === st.mtimeMs && hit._size === st.size) return hit;

  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');

    let headStr = '';
    let tailStr = '';
    let exact = false;

    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      // Small enough to read whole. Previously head and tail OVERLAPPED for
      // any file in this range — the 'tail' read started at offset 0 — so every
      // record was absorbed twice and the message estimate ran up to 2x high.
      // Reading once is the same I/O and gives an exact count.
      const buf = Buffer.alloc(st.size);
      await fh.read(buf, 0, st.size, 0);
      headStr = buf.toString('utf8');
      exact = true;
    } else {
      const head = Buffer.alloc(HEAD_BYTES);
      await fh.read(head, 0, HEAD_BYTES, 0);
      headStr = head.toString('utf8');

      const tailStart = st.size - TAIL_BYTES;
      const tail = Buffer.alloc(TAIL_BYTES);
      await fh.read(tail, 0, TAIL_BYTES, tailStart);
      tailStr = tail.toString('utf8');
      // A mid-file read almost always starts mid-line; drop that fragment.
      const nl = tailStr.indexOf('\n');
      if (nl >= 0) tailStr = tailStr.slice(nl + 1);
    }

    const parsed = extract(headStr, tailStr, file, projectKey, st, exact);
    const entry: CacheEntry = { ...parsed, _mtimeMs: st.mtimeMs, _size: st.size };
    cache.set(file, entry);
    cacheDirty = true;
    return entry;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

function safeParse(line: string): any | null {
  if (!line || line[0] !== '{') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extract(
  headStr: string,
  tailStr: string,
  file: string,
  projectKey: string,
  st: fs.Stats,
  exact: boolean,
): ScannedSession {
  const s: ScannedSession = {
    id: path.basename(file, '.jsonl'),
    file,
    projectKey,
    cwd: '',
    branch: '',
    title: '',
    titleSource: '',
    lastPrompt: '',
    recap: '',
    pr: null,
    review: null,
    searchText: '',
    startedAt: 0,
    lastActivity: 0,
    sizeBytes: st.size,
    messages: 0,
    version: '',
    tail: {
      lastStopReason: null,
      lastRole: null,
      lastUserWasToolResult: false,
      endedMidTool: false,
    },
  };

  let customTitle = '';
  let aiTitle = '';
  let agentName = '';
  let firstUserText = '';
  /**
   * The first PR the PERSON typed anywhere in the session. Used only to fill
   * in a review that named no PR of its own — `/pr-review` with bare arguments
   * after the URL was given in an earlier message, which is a normal way to
   * work and otherwise showed no link at all.
   */
  const typedPrs: PrLink[] = [];

  /**
   * Message text for search, user messages first. Bounded because this is
   * cached to disk for every session: the cap is what keeps index-cache.json
   * a few megabytes rather than a few hundred.
   */
  let userParts: string[] = [];
  let userLen = 0;
  let asstParts: string[] = [];
  let asstLen = 0;
  const addSearchText = (content: any, mine: boolean) => {
    const cap = mine ? SEARCH_USER_MAX : SEARCH_ASSISTANT_MAX;
    const len = mine ? userLen : asstLen;
    if (len >= cap) return;
    const t = textOf(content).trim();
    if (!t) return;
    const slice = t.length > cap - len ? t.slice(0, cap - len) : t;
    if (mine) { userParts.push(slice); userLen += slice.length; }
    else { asstParts.push(slice); asstLen += slice.length; }
  };

  const absorb = (rec: any) => {
    if (!rec) return;
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (rec.gitBranch) s.branch = rec.gitBranch;
    if (rec.version) s.version = rec.version;

    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
      if (ts > s.lastActivity) s.lastActivity = ts;
    }

    switch (rec.type) {
      case 'custom-title':
        if (rec.customTitle) customTitle = rec.customTitle;
        break;
      case 'ai-title':
        if (rec.aiTitle) aiTitle = rec.aiTitle;
        break;
      case 'agent-name':
        if (rec.agentName) agentName = rec.agentName;
        break;
      case 'last-prompt':
        if (rec.lastPrompt) s.lastPrompt = rec.lastPrompt;
        break;
      case 'pr-link':
        if (rec.prNumber) {
          s.pr = {
            number: rec.prNumber,
            url: rec.prUrl ?? '',
            repository: rec.prRepository ?? '',
          };
        }
        break;
      case 'system':
        if (rec.subtype === 'away_summary' && typeof rec.content === 'string') {
          s.recap = stripRecapHint(rec.content);
        }
        break;
      case 'user': {
        if (!firstUserText && !rec.isMeta) firstUserText = textOf(rec.message?.content);
        addSearchText(rec.message?.content, true);
        // Detect a review invocation from the RAW text: textOf() strips the
        // very slash-command envelope this reads, and cleanPromptText throws
        // the args away, so this has to run before either of them.
        const raw = rawTextOf(rec.message?.content);
        // ...but only from what THIS session did. `/branch` copies the parent's
        // conversation into the new transcript, tagging every inherited record
        // with `forkedFrom`, so the parent's '/pr-review' sits at line 0 of a
        // branch that is not reviewing anything. Verified across every branched
        // transcript on this machine: the review command is always an inherited
        // record. Skipping those is what stops a branch claiming its parent's
        // label.
        if (!isInherited(rec)) {
          if (!s.review) s.review = detectReview(raw);
          // Typed by a person, not echoed back by a tool. Transcripts are full
          // of PR URLs in command output and Claude's own prose — attaching one
          // of those would put a confident, wrong link on sessions that merely
          // mentioned a PR in passing.
          if (!rec.isMeta && !hasToolResult(rec.message?.content)) {
            for (const pr of parsePrUrls(raw)) pushPr(typedPrs, pr);
          }
        }
        break;
      }
      case 'assistant':
        addSearchText(rec.message?.content, false);
        break;
    }
  };

  for (const line of headStr.split('\n')) absorb(safeParse(line));
  const tailLines = tailStr ? tailStr.split('\n') : [];
  for (const line of tailLines) absorb(safeParse(line));

  const headLines = headStr.split('\n');
  if (exact) {
    // Whole file was read: count the real records.
    s.messages = headLines.filter((l) => l.length > 1).length;
  } else {
    // Extrapolate from average line length across the two sampled windows.
    const sampled = headStr.length + tailStr.length;
    const sampledLines = headLines.length + tailLines.length;
    if (sampled > 0 && sampledLines > 0) {
      const avg = sampled / sampledLines;
      s.messages = Math.max(sampledLines, Math.round(st.size / Math.max(avg, 1)));
    }
  }

  // A review that named no PR still usually has one — said earlier, in prose.
  // Command arguments come first because they are the explicit statement of
  // what is under review; anything else the person typed is a fallback and an
  // addition, deduped against them.
  if (s.review) {
    const prs = [...s.review.prs];
    for (const pr of typedPrs) pushPr(prs, pr);
    s.review = { ...s.review, prs, pr: prs[0] ?? null };
  }

  s.searchText = [...userParts, ...asstParts].join(' \n').toLowerCase();
  userParts = [];
  asstParts = [];

  s.tail = readTail(tailLines.length ? tailLines : headLines);

  if (customTitle) {
    s.title = customTitle;
    s.titleSource = 'custom';
  } else if (aiTitle) {
    s.title = aiTitle;
    s.titleSource = 'ai';
  } else if (agentName) {
    s.title = agentName;
    s.titleSource = 'agent';
  } else if (firstUserText) {
    s.title = firstUserText.slice(0, 80);
    s.titleSource = 'prompt';
  } else {
    s.title = s.id.slice(0, 8);
    s.titleSource = 'id';
  }

  if (!s.cwd) s.cwd = decodeProjectKey(projectKey);
  if (!s.lastActivity) s.lastActivity = st.mtimeMs;

  return s;
}

/** Claude appends a config hint to recaps; it is noise in a list view. */
function stripRecapHint(text: string): string {
  return text.replace(/\s*\(disable recaps in \/config\)\s*$/i, '').trim();
}

function textOf(content: any): string {
  if (typeof content === 'string') return cleanPromptText(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        const t = cleanPromptText(part.text);
        if (t) return t;
      }
    }
  }
  return '';
}

/**
 * A first user message is often wrapped in Claude Code's own markup — slash
 * command envelopes, injected reminders, task notifications. Left in, these
 * become titles like '<command-message>team:standard-rev', so strip the
 * machinery and keep whatever prose is left.
 */
function cleanPromptText(raw: string): string {
  let t = raw;
  // Each pattern below is <opener> + lazy [\s\S]*? + a REQUIRED closer, which
  // rescans to end-of-string at every opener when the closer never arrives —
  // O(n^2) on hostile pasted text. A transcript line is unbounded up to the
  // 256KB head window and this runs synchronously, so bound the input first.
  // The result is truncated to a title anyway, so nothing useful is lost.
  if (t.length > 8192) t = t.slice(0, 8192);
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ');
  t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ');
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  t = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, ' ');
  // A bare <command-name>foo</command-name> IS the intent when nothing else is.
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_m, name: string) => {
    const n = String(name).trim().replace(/^\/+/, '');
    return n ? ` /${n} ` : ' ';
  });
  t = t.replace(/<[^>]{1,40}>/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Walk backwards to the last substantive turn. This is what tells us whether
 * Claude is waiting on the human (`end_turn` with nothing after it) or was
 * cut off with a tool call still outstanding (`tool_use`).
 */
function readTail(lines: string[]): TailInfo {
  const info: TailInfo = {
    lastStopReason: null,
    lastRole: null,
    lastUserWasToolResult: false,
    endedMidTool: false,
  };

  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = safeParse(lines[i]);
    if (!rec) continue;
    if (rec.type !== 'assistant' && rec.type !== 'user') continue;
    if (rec.isMeta) continue;

    if (rec.type === 'assistant') {
      info.lastRole = 'assistant';
      info.lastStopReason = rec.message?.stop_reason ?? null;
      info.endedMidTool = info.lastStopReason === 'tool_use';
      return info;
    }

    // A user entry that is really a tool result means Claude was mid-flight.
    const content = rec.message?.content;
    const isToolResult =
      Array.isArray(content) && content.some((p: any) => p?.type === 'tool_result');
    info.lastRole = 'user';
    info.lastUserWasToolResult = isToolResult;
    info.endedMidTool = isToolResult;
    return info;
  }
  return info;
}

/** A message carrying tool output is the machine talking, not the person. */
function hasToolResult(content: any): boolean {
  return Array.isArray(content) && content.some((p: any) => p?.type === 'tool_result');
}

/** Raw concatenated text of a message, with Claude Code's markup left intact. */
function rawTextOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('\n');
}

/**
 * Commands whose job is reviewing code, matched by stem so this does not need
 * a list of every tool by name. Nothing here is tool-specific: whichever
 * command matched, the PR is read out of its arguments the same way, so a new
 * review tool works without any change here as long as its name says what it
 * does.
 *
 * `remediation` earns its place because remediation skills ARE
 * review loops — they run the standard review repeatedly and fix what it
 * finds — and none of their names contain "review".
 *
 * Kept deliberately short. Broader stems like `audit` or `check` would drag in
 * commands that have nothing to do with code review (`/audit-logs`), and a
 * session wrongly labelled a review is worse than one left unlabelled.
 */
const REVIEW_STEMS = ['review', 'remediation', 'critique'];
const COMMAND_SEGMENT = /^(?:[a-z0-9_-]+:)*([a-z0-9-]+)$/i;

function isReviewCommand(name: string): boolean {
  const seg = COMMAND_SEGMENT.exec(name)?.[1]?.toLowerCase();
  if (!seg) return false;
  return REVIEW_STEMS.some((stem) => seg.includes(stem));
}
const COMMAND_NAME = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/gi;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/i;
/** Only a full PR URL is trusted: a bare "#12" names no repository. */
const PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;
const PR_URL_ALL = new RegExp(PR_URL.source, 'gi');
/**
 * A review can genuinely cover several PRs; a transcript that mentions dozens
 * is quoting output, not describing its subject. Cap rather than let one
 * session render an unbounded list.
 */
const MAX_REVIEW_PRS = 8;

function detectReview(raw: string): ReviewInfo | null {
  if (!raw) return null;
  COMMAND_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_NAME.exec(raw)) !== null) {
    const name = m[1].replace(/^\/+/, '');
    if (!isReviewCommand(name)) continue;
    // Args follow their command name, and a message can carry more than one
    // command, so search forward from this match rather than the whole string.
    const rest = raw.slice(m.index);
    const args = COMMAND_ARGS.exec(rest)?.[1] ?? '';
    const prs = parsePrUrls(args);
    return { command: name, pr: prs[0] ?? null, prs };
  }
  return null;
}

/**
 * A record `/branch` copied in from the session it forked from. Claude Code
 * tags every inherited record with `forkedFrom: { sessionId, messageUuid }`;
 * records this session produced itself have no such field.
 */
function isInherited(rec: any): boolean {
  return !!rec?.forkedFrom;
}

/** Append unless an equal PR is already there. Order is first-seen. */
function pushPr(list: PrLink[], pr: PrLink): void {
  if (list.length >= MAX_REVIEW_PRS) return;
  if (list.some((p) => p.url === pr.url)) return;
  list.push(pr);
}

function parsePrUrl(text: string): PrLink | null {
  const m = PR_URL.exec(text);
  return m ? prFrom(m) : null;
}

/** Every distinct PR named in `text`, in the order they appear. */
function parsePrUrls(text: string): PrLink[] {
  if (!text) return [];
  const out: PrLink[] = [];
  PR_URL_ALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_URL_ALL.exec(text)) !== null) {
    pushPr(out, prFrom(m));
    if (out.length >= MAX_REVIEW_PRS) break;
  }
  return out;
}

function prFrom(m: RegExpMatchArray): PrLink {
  return {
    number: Number(m[3]),
    url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
    repository: `${m[1]}/${m[2]}`,
  };
}
