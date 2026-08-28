import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, Session, Priority, SessionShape, UserState } from '../../server/types';
import { api, type SessionsPayload } from './api';
import {
  BUCKET_COLOR, BUCKET_HELP, BUCKET_LABEL, BUCKET_ORDER, STATE_COLOR, STATE_LABEL,
  SHAPE_GLYPH, SHAPE_HINT, SHAPE_LABEL, SHAPE_ORDER,
  bucketOf, matches, relTime, shortPath, type Bucket,
} from './util';
import { SessionRow } from './components/SessionRow';
import { TerminalPane } from './components/TerminalPane';

const POLL_MS = 2500;
/**
 * Artifacts are re-read on their own, much slower clock. The server caches on
 * the transcript's mtime, so asking again costs nothing while a session is
 * idle — but a LIVE session's transcript grows on every poll, and at POLL_MS
 * that would mean re-reading a 14MB file every 2.5 seconds to look for a
 * record that appears a handful of times a day.
 */
const ARTIFACT_POLL_MS = 15_000;
/**
 * One list, rendered both in the help dialog and in the empty state. They used
 * to be separate and would have drifted the moment a key changed.
 */
const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'j / \u2193', what: 'move down the list' },
  { keys: 'k / \u2191', what: 'move up the list' },
  { keys: 'Enter', what: 'open the session under the cursor in a terminal' },
  { keys: '/', what: 'search titles, ids, tags, branches, PRs \u2014 and the messages themselves' },
  { keys: 'Esc', what: 'clear the search, then leave it \u2014 or close a dialog' },
  { keys: 'p', what: 'cycle priority \u2014 p0, p1, p2, none' },
  { keys: 'x', what: 'pin or unpin' },
  { keys: 't', what: 'add a tag' },
  { keys: 's', what: 'snooze for 4 hours' },
  { keys: 'r', what: 'refresh now' },
  { keys: '[', what: 'hide or show the session list' },
  { keys: '?', what: 'this help' },
  { keys: '\u2318F', what: 'find inside the terminal (Ctrl+F on Linux)' },
];

/**
 * What "active" means: a Claude Code process is running for this session right
 * now — either registered in ~/.claude/sessions, or attached to a terminal in
 * this app.
 *
 * `attached` is not redundant. A session you have just opened here spawns its
 * PTY immediately but takes a second or two to register itself as live, and
 * without this the row would vanish from under you at the exact moment you
 * opened it.
 */
const isActive = (s: Session): boolean => !!s.live || s.attached;

const SIDEBAR_DEFAULT = 380;
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 640;

function clampSidebar(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

const SNOOZE_OPTIONS: [string, number][] = [
  ['1h', 3600_000],
  ['4h', 4 * 3600_000],
  ['tomorrow', 24 * 3600_000],
  ['1w', 7 * 24 * 3600_000],
];

export function App() {
  const [payload, setPayload] = useState<SessionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => { try { return localStorage.getItem('ct.selected'); } catch { return null; } },
  );
  // The cursor is an ID, not an index: any reorder would silently retarget an
  // index, so pressing snooze twice would snooze two different sessions.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<Bucket>>(new Set(['quiet', 'snoozed']));
  const [bucketFilter, setBucketFilter] = useState<Bucket | null>(null);
  const [shapeFilter, setShapeFilter] = useState<SessionShape | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activeOnly, setActiveOnly] = useState(
    () => { try { return localStorage.getItem('ct.activeOnly') !== '0'; } catch { return true; } },
  );
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [newTermId, setNewTermId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newCwd, setNewCwd] = useState('');
  const [aiming, setAiming] = useState(false);
  // A terminal that exits vanishes from the server's `attached` set instantly,
  // which used to unmount the pane ~10ms later — so the exit banner and the
  // final screen output were never readable, and Restart disappeared with it.
  const [exitedFor, setExitedFor] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const orderRef = useRef<string[]>([]);
  // Read inside the keydown handler, which must not re-subscribe on every
  // selection change just to know whether a terminal is mounted.
  const terminalMountedRef = useRef(false);
  // Bumped on Restart so TerminalPane remounts: for a resumed session the
  // termId is unchanged, so without this the new PTY's output appended below
  // the dead run's in the same xterm buffer.
  const [restartNonce, setRestartNonce] = useState(0);
  // A new session registers its pid before its transcript exists on disk.
  // Handing over on the pid alone dropped the pane into "Pick a session" with
  // a live PTY behind it, so we wait until the scan actually sees the session.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  // Which copy button was last pressed, so a click that puts something on the
  // clipboard says so. Without it both copy controls are silent and you press
  // them twice to be sure.
  // Dismissed locally the instant you act, so the banner cannot flash back
  // between the click and the next poll clearing it server-side.
  const [restoreDone, setRestoreDone] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  // Artifacts are fetched per selected session rather than arriving with the
  // poll payload, because finding them means reading a transcript whole.
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const artifactSeq = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => { try { return localStorage.getItem('ct.sidebarOpen') !== '0'; } catch { return true; } },
  );
  const [sidebarW, setSidebarW] = useState(() => {
    try { return clampSidebar(Number(localStorage.getItem('ct.sidebarW')) || SIDEBAR_DEFAULT); }
    catch { return SIDEBAR_DEFAULT; }
  });
  const dragRef = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const copy = useCallback((what: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(what);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1200);
  }, []);

  // ------------------------------------------------------------------ data
  const refresh = useCallback(async (force = false) => {
    const seq = ++seqRef.current;
    try {
      const p = await api.sessions(force);
      // Drop a response that a newer request has already superseded, or a
      // slow in-flight poll will clobber the state an optimistic write just set
      // (which showed up as the terminal flashing away right after opening it).
      if (seq !== seqRef.current) return;
      setPayload(p);
      setError(null);
    } catch (e: any) {
      if (seq !== seqRef.current) return;
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // --------------------------------------------------------------- artifacts
  useEffect(() => {
    if (!selectedId) { setArtifacts([]); return; }
    let stop = false;
    const load = async () => {
      const seq = ++artifactSeq.current;
      try {
        const { artifacts: got } = await api.artifacts(selectedId);
        // A slow response for the session you just navigated away from must
        // not paint its artifacts over the one you are now looking at.
        if (stop || seq !== artifactSeq.current) return;
        setArtifacts(got);
      } catch {
        if (stop || seq !== artifactSeq.current) return;
        // A session with no transcript yet (a brand-new one) 404s here. That
        // is not an error worth a banner — it just has nothing to show.
        setArtifacts([]);
      }
    };
    void load();
    const t = setInterval(() => void load(), ARTIFACT_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [selectedId]);

  // ----------------------------------------------------------------- sidebar
  useEffect(() => {
    try { localStorage.setItem('ct.sidebarW', String(sidebarW)); } catch { /* private mode */ }
  }, [sidebarW]);
  useEffect(() => {
    try { localStorage.setItem('ct.sidebarOpen', sidebarOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [sidebarOpen]);
  useEffect(() => {
    try { localStorage.setItem('ct.activeOnly', activeOnly ? '1' : '0'); } catch { /* private mode */ }
  }, [activeOnly]);

  /**
   * Drag on the window rather than the handle, so a pointer that outruns the
   * element mid-drag keeps resizing instead of dropping it. `dragRef` also
   * disables the terminal's pointer events for the duration — without it the
   * drag ends inside the xterm canvas and starts a text selection there.
   */
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = true;
    document.body.classList.add('resizing');
    const onMove = (ev: PointerEvent) => setSidebarW(clampSidebar(ev.clientX));
    const onUp = () => {
      dragRef.current = false;
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  /**
   * pointerleave only fires on pointer MOVEMENT out of the sidebar. Clicking a
   * row and then working in the terminal, or Cmd-Tabbing away, leaves the
   * pointer parked over the list — and the ranking silently frozen, which in a
   * tool whose whole premise is "ranked by what needs you" is a correctness
   * bug, not a cosmetic one. Release it on anything that means "not aiming".
   */
  useEffect(() => {
    const release = () => setAiming(false);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    window.addEventListener('keydown', release);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
      window.removeEventListener('keydown', release);
    };
  }, []);

  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem('ct.selected', selectedId);
      else localStorage.removeItem('ct.selected');
    } catch { /* blocked storage: selection just does not persist */ }
  }, [selectedId]);

  const sessions = payload?.sessions ?? [];

  /**
   * Ids whose MESSAGE text matches the query. The payload deliberately does
   * not carry message text — it would add megabytes to every poll — so this is
   * the one part of search the server answers, and it is unioned with the
   * local metadata match rather than replacing it.
   *
   * Debounced because it runs on every keystroke, and stale responses are
   * dropped by sequence number: without that, a slow reply for "rev" can land
   * after a fast one for "review" and show the wrong set.
   */
  const [msgIds, setMsgIds] = useState<Set<string>>(new Set());
  const searchSeq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setMsgIds(new Set()); return; }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      api.search(q)
        .then((r) => { if (seq === searchSeq.current) setMsgIds(new Set(r.ids)); })
        .catch(() => { if (seq === searchSeq.current) setMsgIds(new Set()); });
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  /** Metadata match OR a hit in the conversation itself. */
  const hits = useCallback(
    (s: Session) => matches(s, query) || msgIds.has(s.id),
    [query, msgIds],
  );

  /** Everything the explicit filters allow, before "active only" narrows it. */
  const baseVisible = useMemo(
    () =>
      sessions.filter(
        (s) =>
          (showArchived ? s.user.archived : !s.user.archived) &&
          (!shapeFilter || s.shape === shapeFilter) &&
          (!tagFilter || s.user.tags.includes(tagFilter)) &&
          hits(s),
      ),
    [sessions, hits, shapeFilter, tagFilter, showArchived],
  );

  /**
   * "Active only" is a default view, not a constraint — so anything you ask
   * for explicitly outranks it. Searching would otherwise be unable to reach
   * the quiet sessions, which is most of what you search FOR; and clicking the
   * Quiet chip would filter to a bucket this hides and show an empty list.
   */
  const activeApplies = activeOnly && !query.trim() && !bucketFilter;

  const visible = useMemo(
    () => (activeApplies ? baseVisible.filter(isActive) : baseVisible),
    [baseVisible, activeApplies],
  );

  /**
   * Bucket counts for the top bar, taken from BEFORE the active filter. With
   * it on, counting after would show "Quiet 0" and leave no way to discover
   * the 78 sessions sitting there, or any reason to click through to them.
   */
  const bucketCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of BUCKET_ORDER) c[b] = 0;
    for (const s of baseVisible) c[bucketOf(s, now)]++;
    return c;
  }, [baseVisible, now]);
  const activeCount = baseVisible.filter(isActive).length;

  /**
   * Freeze the DISPLAY order while the pointer is over the list.
   *
   * The server order is genuinely unstable by design: the attention score
   * decays continuously, live sessions flip busy/idle, and git state changes
   * on every file save. Any of those can swap two adjacent rows between polls,
   * so a click lands on whatever moved into place. Contents still update live;
   * only positions hold still, and only while you are aiming at them.
   */
  const ordered = useMemo(() => {
    if (!aiming) {
      orderRef.current = visible.map((s) => s.id);
      return visible;
    }
    const byId = new Map(visible.map((s) => [s.id, s]));
    const kept: Session[] = [];
    for (const id of orderRef.current) {
      const s = byId.get(id);
      if (s) kept.push(s);
    }
    const seen = new Set(kept.map((s) => s.id));
    return [...kept, ...visible.filter((s) => !seen.has(s.id))];
  }, [visible, aiming]);

  const groups = useMemo(() => {
    const m = new Map<Bucket, Session[]>();
    for (const b of BUCKET_ORDER) m.set(b, []);
    for (const s of ordered) m.get(bucketOf(s, now))!.push(s);
    return m;
  }, [ordered, now]);

  /**
   * Collapsing is ignored while "active only" is narrowing the list. Quiet and
   * Snoozed start collapsed, so a running session in either of them was
   * counted and then hidden behind a group header — the toggle said 8 with
   * five rows on screen. Having asked for just the handful that are running,
   * there is nothing left to collapse away.
   */
  const showCollapsed = activeApplies;
  const flat = useMemo(() => {
    const out: Session[] = [];
    for (const b of BUCKET_ORDER) {
      if (bucketFilter && b !== bucketFilter) continue;
      if (!showCollapsed && collapsed.has(b)) continue;
      out.push(...(groups.get(b) ?? []));
    }
    return out;
  }, [groups, collapsed, bucketFilter, showCollapsed]);

  const cursor = useMemo(() => {
    const i = flat.findIndex((s) => s.id === cursorId);
    return i >= 0 ? i : 0;
  }, [flat, cursorId]);

  // Re-anchor the cursor to the top of the list whenever the filters change,
  // so '/' then Enter opens the FIRST match rather than a stale position.
  useEffect(() => {
    setCursorId(flat[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, shapeFilter, tagFilter, bucketFilter, showArchived, activeOnly]);

  // If the last use of a tag is removed, its chip disappears — leaving the
  // filter stuck on with no control to clear it and a permanently empty list.
  useEffect(() => {
    if (tagFilter && payload && !payload.tags.includes(tagFilter)) setTagFilter(null);
  }, [payload, tagFilter]);

  const shapeCounts = useMemo(() => {
    // Derived from SHAPE_ORDER, not hand-listed: a literal typed as
    // Record<string, number> silently missed 'review' when it was added, and
    // the chip rendered "Reviews NaN" because nothing type-checked the keys.
    const c = Object.fromEntries(SHAPE_ORDER.map((sh) => [sh, 0])) as Record<SessionShape, number>;
    for (const s of sessions) {
      // Same base as the list itself, minus the shape filter these chips set —
      // otherwise the chips describe the active list while the bucket chips
      // describe the archived one.
      if (showArchived ? !s.user.archived : s.user.archived) continue;
      if (tagFilter && !s.user.tags.includes(tagFilter)) continue;
      if (bucketFilter && bucketOf(s, now) !== bucketFilter) continue;
      if (activeApplies && !isActive(s)) continue;
      if (!hits(s)) continue;
      c[s.shape]++;
    }
    return c;
  }, [sessions, hits, tagFilter, showArchived, bucketFilter, now, activeApplies]);

  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  useEffect(() => {
    if (!pendingSessionId) return;
    if (!sessions.some((s) => s.id === pendingSessionId)) return;
    setSelectedId(pendingSessionId);
    setNewTermId(null);
    setPendingSessionId(null);
  }, [sessions, pendingSessionId]);

  const knownCwds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of sessions) {
      if (s.lastActivity > (seen.get(s.cwd) ?? 0)) seen.set(s.cwd, s.lastActivity);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [sessions]);

  // --------------------------------------------------------------- actions
  const patch = useCallback(
    async (id: string, p: Partial<UserState>) => {
      setPayload((prev) =>
        prev
          ? { ...prev, sessions: prev.sessions.map((s) => (s.id === id ? { ...s, user: { ...s.user, ...p } } : s)) }
          : prev,
      );
      try {
        await api.patchState(id, p);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
      await refresh(true);
    },
    [refresh],
  );

  const attach = useCallback(
    async (s: Session) => {
      if (s.attached) return;
      // The detail button is disabled for this case; the keyboard paths
      // (Enter on the cursor, Enter in search) must not route around it.
      if (s.live) {
        setError(
          `"${s.title}" is already running in another terminal (pid ${s.live.pid}). ` +
          `Close it there first, or use Copy resume.`,
        );
        return;
      }
      setExitedFor(null);
      // Same reason restart() bumps it: re-opening an exited session reuses the
      // same termId, so without a new key React keeps the old pane — leaving a
      // false "Session exited" banner over a live terminal and splicing the new
      // PTY's output under the dead run's.
      setRestartNonce((n) => n + 1);
      setBusy(true);
      try {
        await api.startTerm({ id: s.id, sessionId: s.id, cwd: s.cwd, cols: 120, rows: 32 });
        setError(null);
        await refresh(true);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const restorable = restoreDone ? [] : (payload?.restore ?? []);

  const dismissRestore = useCallback(async () => {
    setRestoreDone(true);
    try {
      await api.clearRestore();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, []);

  const restoreAll = useCallback(async () => {
    const list = payload?.restore ?? [];
    if (!list.length) return;
    setRestoreDone(true);
    setRestoring(true);
    const opened: string[] = [];
    const failed: string[] = [];
    for (const r of list) {
      try {
        await api.startTerm({ id: r.sessionId, sessionId: r.sessionId, cwd: r.cwd, cols: 120, rows: 32 });
        opened.push(r.sessionId);
      } catch (e: any) {
        // One dead worktree must not cost you the other five terminals.
        failed.push(`${r.title} (${String(e?.message ?? e)})`);
      }
    }
    try {
      await api.clearRestore();
    } catch { /* already dismissed locally; it will not be offered again */ }
    setRestoring(false);
    setError(failed.length ? `Could not reopen ${failed.length} of ${list.length}: ${failed.join('; ')}` : null);
    if (opened[0]) {
      setSelectedId(opened[0]);
      setCursorId(opened[0]);
      setExitedFor(null);
      setRestartNonce((n) => n + 1);
    }
    await refresh(true);
  }, [payload, refresh]);

  const restart = useCallback(
    async (s: Session) => {
      setBusy(true);
      try {
        await api.killTerm(s.termId ?? s.id, true);
        await new Promise((r) => setTimeout(r, 250));
        await api.startTerm({ id: s.id, sessionId: s.id, cwd: s.cwd, cols: 120, rows: 32 });
        setRestartNonce((n) => n + 1);
        setExitedFor(null);
        await refresh(true);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const closeTerm = useCallback(
    async (s: Session) => {
      setBusy(true);
      try {
        await api.killTerm(s.termId ?? s.id, true);
        setExitedFor(null);
        await refresh(true);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const startNew = useCallback(async () => {
    const cwd = newCwd.trim();
    if (!cwd) return;
    const id = `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setBusy(true);
    try {
      await api.startTerm({ id, sessionId: null, cwd, cols: 120, rows: 32 });
      setNewTermId(id);
      setSelectedId(null);
      setNewOpen(false);
      setError(null);
      await refresh(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [newCwd, refresh]);

  const select = useCallback((s: Session) => {
    setSelectedId(s.id);
    setCursorId(s.id);
    setExitedFor((prev) => (prev === s.id ? prev : null));
  }, []);

  /**
   * Move the cursor off a row BEFORE an action removes it from the list.
   * Otherwise `cursor` falls back to 0 and the next keypress lands on the
   * top-ranked session — the exact "two presses hit two different sessions"
   * hazard the id-based cursor was meant to end, reached another way.
   */
  const advanceCursorPast = useCallback((id: string) => {
    const i = flat.findIndex((s) => s.id === id);
    if (i < 0) return;
    const next = flat[i + 1] ?? flat[i - 1] ?? null;
    setCursorId(next?.id ?? null);
  }, [flat]);

  const cyclePriority = useCallback((s: Session) => {
    const order: (Priority | null)[] = [null, 'p0', 'p1', 'p2'];
    void patch(s.id, { priority: order[(order.indexOf(s.user.priority) + 1) % order.length] });
  }, [patch]);

  const expandBucket = useCallback((b: Bucket) => {
    setCollapsed((prev) => { const n = new Set(prev); n.delete(b); return n; });
  }, []);

  // -------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // xterm receives input through a hidden <textarea>, so this MUST be
      // tested before any "is the user typing" branch — otherwise Escape (the
      // most-pressed key in Claude Code) blurred the terminal and every
      // keystroke after it fired an app shortcut, silently snoozing sessions.
      const inTerminal = !!el?.closest?.('.term-host');
      if (inTerminal) return;

      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
      // Making the group heads, chips and filters real <button>s (for keyboard
      // access) meant a focused button was not "typing" — so Enter fell through
      // to the shortcut block, preventDefault() cancelled the button's click,
      // and instead a terminal was spawned on whatever row the cursor was on.
      const onControl =
        !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'SELECT');

      if (e.key === 'Escape') {
        if (helpOpen) { setHelpOpen(false); e.preventDefault(); return; }
        if (renameOpen) { setRenameOpen(false); e.preventDefault(); return; }
        if (newOpen) { setNewOpen(false); e.preventDefault(); return; }
        if (typing) { (el as HTMLInputElement).blur(); e.preventDefault(); }
        return;
      }
      if (typing) return;
      if (onControl && (e.key === 'Enter' || e.key === ' ')) return;

      // Never shadow a browser or OS shortcut: Cmd+S used to snooze the
      // session under the cursor for four hours with no undo.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }

      // '?' is Shift+/ on most layouts, so it has to be tested before the
      // row shortcuts and by character rather than by physical key.
      if (e.key === '?') { e.preventDefault(); setHelpOpen((v) => !v); return; }
      if (e.key === '[') { e.preventDefault(); setSidebarOpen((v) => !v); return; }
      // Refresh belongs here, above the guard: it acts on the whole list, not
      // on the cursor, so it stays useful with the list hidden.
      if (e.key === 'r') { e.preventDefault(); void refresh(true); return; }

      // Everything below acts on the row under the cursor, which is in the
      // sidebar. With it hidden there is no cursor to see moving, so a
      // keystroke would silently snooze or pin something off-screen.
      if (!sidebarOpen) return;

      const move = (delta: number) => {
        e.preventDefault();
        if (!flat.length) return;
        const next = Math.min(flat.length - 1, Math.max(0, cursor + delta));
        setCursorId(flat[next].id);
        // Selection drives which terminal is mounted, so following the cursor
        // while a terminal is open would close its WebSocket and re-replay the
        // whole scrollback on every keypress. Browse freely; Enter commits.
        if (!terminalMountedRef.current) setSelectedId(flat[next].id);
        document
          .querySelector(`[data-session-row="${flat[next].id}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      };

      if (e.key === 'j' || e.key === 'ArrowDown') return move(1);
      if (e.key === 'k' || e.key === 'ArrowUp') return move(-1);

      const s = flat[cursor];
      if (!s) return;
      if (e.key === 'Enter') { e.preventDefault(); setSelectedId(s.id); void attach(s); }
      else if (e.key === 'x') { e.preventDefault(); void patch(s.id, { pinned: !s.user.pinned }); }
      else if (e.key === 'p') { e.preventDefault(); cyclePriority(s); }
      else if (e.key === 't') { e.preventDefault(); setSelectedId(s.id); setTimeout(() => tagRef.current?.focus(), 30); }
      else if (e.key === 's') {
        e.preventDefault();
        advanceCursorPast(s.id);
        void patch(s.id, { snoozedUntil: Date.now() + 4 * 3600_000 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, cursor, attach, patch, cyclePriority, refresh, newOpen, helpOpen, renameOpen, sidebarOpen]);

  /**
   * Drive one of Claude Code's own slash commands in the attached terminal.
   * The app does not reimplement branching or renaming — it types the command
   * you would have typed, so the session stays the single source of truth for
   * its own title and lineage.
   */
  const termCommand = useCallback(
    async (s: Session, command: 'branch' | 'rename', arg?: string) => {
      if (!s.termId) return;
      setBusy(true);
      try {
        await api.termCommand(s.termId, command, arg);
        // A branch gives the terminal a NEW session id. The server notices on
        // its next tick and the client follows via `identified`; refreshing
        // shortly after just makes that feel immediate rather than delayed.
        setTimeout(() => void refresh(true), 1200);
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // ------------------------------------------------------------------ view
  const termId = selected?.termId ?? selected?.id ?? null;
  // An exited terminal drops out of the server's attached set immediately, so
  // deriving purely from `attached` unmounted the pane ~10ms after exit — the
  // banner, the final screen output and the Restart button all vanished before
  // they could be read.
  const termOpen = !!selected && (selected.attached || exitedFor === selected.id);
  const liveElsewhere = !!selected?.live && !selected.attached;
  terminalMountedRef.current = termOpen;
  const hiddenCount = sessions.length - visible.length;

  return (
    <div
      className={`app${sidebarOpen ? '' : ' sidebar-hidden'}`}
      style={{ ['--sidebar-w' as string]: `${sidebarW}px` } as React.CSSProperties}
    >
      <div className="topbar">
        <button
          className="btn sm icon"
          onClick={() => setSidebarOpen((v) => !v)}
          title={`${sidebarOpen ? 'Hide' : 'Show'} the session list  [`}
          aria-label={`${sidebarOpen ? 'Hide' : 'Show'} the session list`}
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? '\u25e7' : '\u25a1'}
        </button>
        <div className="brand"><span className="brand-dot" /> Claude Terminal</div>
        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search"
            placeholder="Search titles, messages, ids, tags, branches, PRs…   /"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears first and blurs only once the box is empty, so
              // the reflex key does the thing you actually wanted; an empty box
              // falls through to the window handler, which blurs it.
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
                return;
              }
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const first = flat[0];
              if (first) { setSelectedId(first.id); setCursorId(first.id); void attach(first); }
              (e.target as HTMLInputElement).blur();
            }}
          />
          {query && (
            <button
              className="search-clear"
              aria-label="Clear search"
              title="Clear search (Esc)"
              // The pointer lands on the button, not the field, so without this
              // the input blurs on mousedown and you lose your place.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}
            >
              ✕
            </button>
          )}
        </div>
        <div className="counts">
          {BUCKET_ORDER.map((b) => {
            const n = bucketCounts[b] ?? 0;
            return (
              <button
                key={b}
                className={`count-chip${bucketFilter === b ? ' on' : ''}${n ? '' : ' zero'}`}
                onClick={() => {
                  const next = bucketFilter === b ? null : b;
                  setBucketFilter(next);
                  if (next) expandBucket(next);
                }}
                title={`Show only ${BUCKET_LABEL[b]}`}
              >
                <span className="dot" style={{ background: BUCKET_COLOR[b] }} />
                {BUCKET_LABEL[b]} {n}
              </button>
            );
          })}
        </div>
        <button
          className="btn sm"
          onClick={() => { setNewCwd(selected?.cwd ?? knownCwds[0] ?? ''); setNewOpen((v) => !v); }}
          title="Start a new Claude session"
        >
          + New
        </button>
        <button
          className="btn sm icon"
          onClick={() => setHelpOpen(true)}
          title="Keyboard shortcuts and help  ?"
          aria-label="Keyboard shortcuts and help"
        >
          ?
        </button>
        <span className="scan-meta">
          {hiddenCount > 0 ? `${hiddenCount} hidden` : `${sessions.length} sessions`}
        </span>
        {newOpen && (
          <>
            <div className="scrim" onClick={() => setNewOpen(false)} />
            <div className="new-pop">
              <div className="detail-label">Start a new session in</div>
              <input
                className="tag-input"
                style={{ width: '100%', fontSize: 12 }}
                value={newCwd}
                autoFocus
                placeholder="/path/to/repo"
                onChange={(e) => setNewCwd(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void startNew(); } }}
              />
              <div className="new-list">
                {knownCwds.slice(0, 8).map((c) => (
                  <button key={c} className="btn sm" onClick={() => setNewCwd(c)} title={c}>
                    {shortPath(c)}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={() => setNewOpen(false)}>Cancel</button>
                <button className="btn sm primary" disabled={busy || !newCwd.trim()} onClick={() => void startNew()}>
                  Start
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {restorable.length > 0 && (
        <div className="restore-bar" role="status">
          <span className="restore-icon" aria-hidden>⟳</span>
          <div className="restore-text">
            <strong>
              {restorable.length} terminal{restorable.length === 1 ? ' was' : 's were'} open when you last quit.
            </strong>
            <span className="restore-names">
              {restorable.map((r) => r.title).join(' · ')}
            </span>
          </div>
          <div className="restore-actions">
            <button className="btn primary" disabled={restoring} onClick={() => void restoreAll()}>
              {restoring ? 'Reopening…' : `Reopen all ${restorable.length}`}
            </button>
            <button className="btn" disabled={restoring} onClick={() => void dismissRestore()}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div
        className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}
        onPointerEnter={() => setAiming(true)}
        onPointerLeave={() => setAiming(false)}
      >
        <div
          className="resizer"
          onPointerDown={startDrag}
          onDoubleClick={() => setSidebarW(SIDEBAR_DEFAULT)}
          title="Drag to resize · double-click to reset"
          role="separator"
          aria-orientation="vertical"
        />
        {payload?.storeReadOnly && (
          <div className="banner err">
            <strong>Read-only:</strong> <code>~/.claude-terminal/state.json</code> could not be read,
            so tags, priority, pin and snooze cannot be saved. Fix or delete it, then restart.
          </div>
        )}
        {error && <div className="banner err">{error}</div>}

        <div className="filters">
          <div className="filter-row">
            <button
              className={`btn sm${activeOnly ? ' on' : ''}`}
              aria-pressed={activeOnly}
              onClick={() => setActiveOnly((v) => !v)}
              title={
                activeOnly
                  ? (activeApplies
                      ? 'Showing only sessions with Claude running right now, snoozed ones included. Click to show every session.'
                      : `Active only is on, but ${query.trim() ? 'a search' : 'a bucket filter'} overrides it so nothing is hidden right now.`)
                  : 'Showing every session. Click to show only the ones running right now.'
              }
            >
              {/* Filled only when it is actually narrowing the list, so an
                  overridden toggle does not claim to be doing something. */}
              {activeApplies ? '\u25cf' : '\u25cb'} Active only {activeCount}
            </button>
          </div>
          <div className="filter-row">
            {SHAPE_ORDER.map((sh) => (
              <button
                key={sh}
                className={`btn sm${shapeFilter === sh ? ' on' : ''}`}
                title={SHAPE_HINT[sh]}
                aria-pressed={shapeFilter === sh}
                onClick={() => setShapeFilter(shapeFilter === sh ? null : sh)}
              >
                {SHAPE_GLYPH[sh]} {SHAPE_LABEL[sh]} {shapeCounts[sh] ?? 0}
              </button>
            ))}
          </div>
          {(payload?.tags.length ?? 0) > 0 && (
            <div className="filter-row tags">
              {payload!.tags.map((t) => (
                <button
                  key={t}
                  className={`chip tag clickable${tagFilter === t ? ' on' : ''}`}
                  aria-pressed={tagFilter === t}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {/* The exit must render whenever the view is open, not only while
              something is archived — unarchiving the last item used to remove
              the only way back out. */}
          {(showArchived || (payload?.counts.archived ?? 0) > 0) && (
            <div className="filter-row">
              <button
                className={`btn sm${showArchived ? ' on' : ''}`}
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? '← Back to active' : `Archived ${payload!.counts.archived}`}
              </button>
            </div>
          )}
          {(query || shapeFilter || tagFilter || bucketFilter) && (
            <div className="filter-row">
              <button
                className="btn sm"
                onClick={() => {
                  setQuery(''); setShapeFilter(null); setTagFilter(null); setBucketFilter(null);
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        {/* One listbox PER BUCKET, with the collapse header outside it. A
            single listbox wrapping everything is invalid: its children must be
            options or groups, and the headers, filters and empty-state are
            neither — so assistive tech saw a listbox with zero options. */}
        <div className="list">
          {BUCKET_ORDER.map((b) => {
            const list = groups.get(b) ?? [];
            if (!list.length) return null;
            if (bucketFilter && b !== bucketFilter) return null;
            const isCollapsed = collapsed.has(b) && !showCollapsed;
            return (
              <div key={b}>
                <button
                  className="group-head"
                  aria-controls={isCollapsed ? undefined : `bucket-${b}`}
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const n = new Set(prev);
                      if (n.has(b)) n.delete(b); else n.add(b);
                      return n;
                    })
                  }
                >
                  <span className="caret">{isCollapsed ? '▶' : '▼'}</span>
                  <span className="gdot" style={{ background: BUCKET_COLOR[b] }} />
                  {BUCKET_LABEL[b]}
                  <span className="n">{list.length}</span>
                </button>
                {!isCollapsed && (
                  <div
                    id={`bucket-${b}`}
                    role="listbox"
                    aria-label={BUCKET_LABEL[b]}
                    tabIndex={0}
                    aria-activedescendant={
                      list.some((x) => x.id === flat[cursor]?.id) ? flat[cursor]?.id : undefined
                    }
                  >
                  {list.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      now={now}
                      selected={s.id === selectedId}
                      atCursor={flat[cursor]?.id === s.id}
                      onClick={() => select(s)}
                    />
                  ))}
                  </div>
                )}
              </div>
            );
          })}
          {/* Keyed off `flat`, not `visible`: filtering to a bucket that is
              empty under the current query left `visible` non-empty, so every
              group rendered null and the list area was simply blank. */}
          {!flat.length && (
            <div className="empty-list">
              {visible.length && BUCKET_ORDER.every((b) => !(groups.get(b) ?? []).length || collapsed.has(b) || (bucketFilter && b !== bucketFilter))
                ? 'Every group is collapsed — expand one above.'
                : bucketFilter && visible.length
                ? <>Nothing in <strong>{BUCKET_LABEL[bucketFilter]}</strong> matches the current filters.</>
                : query || shapeFilter || tagFilter
                  ? 'No session matches these filters.'
                  : showArchived ? 'Nothing archived.' : 'No sessions found.'}
              {(query || shapeFilter || tagFilter || bucketFilter) && (
                <div style={{ marginTop: 10 }}>
                  <button
                    className="btn sm"
                    onClick={() => {
                      setQuery(''); setShapeFilter(null); setTagFilter(null); setBucketFilter(null);
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="main">
        {newTermId && !selected ? (
          <>
            <div className="detail">
              <div className="detail-top">
                <span className="row-dot" style={{ background: 'var(--st-working)', marginTop: 0 }} />
                <span className="detail-title">New session</span>
                <span className="detail-path">{shortPath(newCwd)} · naming itself…</span>
                <div className="detail-actions">
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={async () => {
                      await api.killTerm(newTermId, true);
                      setNewTermId(null);
                      await refresh(true);
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
            <TerminalPane
              key={newTermId}
              termId={newTermId}
              onExit={() => void refresh(true)}
              onIdentified={(sid) => { setPendingSessionId(sid); }}
            />
          </>
        ) : selected ? (
          <>
            <div className="detail">
              {renameOpen && (
                <>
                  <div className="scrim" onClick={() => setRenameOpen(false)} />
                  <div className="rename-pop">
                    <div className="detail-label">Rename this session</div>
                    <input
                      ref={renameRef}
                      className="tag-input"
                      style={{ width: '100%', fontSize: 12 }}
                      value={renameText}
                      autoFocus
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenameOpen(false);
                          return;
                        }
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        if (!renameText.trim()) return;
                        setRenameOpen(false);
                        void termCommand(selected, 'rename', renameText.trim());
                      }}
                    />
                    <div className="rename-hint">
                      Runs <code>/rename</code> in the terminal, so the session names itself.
                    </div>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => setRenameOpen(false)}>Cancel</button>
                      <button
                        className="btn sm primary"
                        disabled={busy || !renameText.trim()}
                        onClick={() => {
                          setRenameOpen(false);
                          void termCommand(selected, 'rename', renameText.trim());
                        }}
                      >
                        Rename
                      </button>
                    </div>
                  </div>
                </>
              )}
              {artifacts.length > 0 && (
                <div className="artifacts" aria-label="Artifacts published by this session">
                  <span className="detail-label">Artifacts</span>
                  {artifacts.map((a) => (
                    <a
                      key={a.url}
                      className="artifact"
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      title={[
                        a.title,
                        a.url,
                        `updated ${relTime(a.updatedAt, now)} ago`,
                        a.revisions > 1 ? `${a.revisions} versions` : '',
                      ].filter(Boolean).join('\n')}
                    >
                      <span className="artifact-icon" aria-hidden>&#9635;</span>
                      <span className="artifact-title">{a.title}</span>
                      {/* Republishing lands on the same URL, so the count is
                          the only thing distinguishing a living document from
                          a one-off. */}
                      {a.revisions > 1 && <span className="artifact-rev">v{a.revisions}</span>}
                    </a>
                  ))}
                </div>
              )}
              <div className="detail-top">
                <span className="row-dot" style={{ background: STATE_COLOR[selected.state], marginTop: 0 }}
                      title={STATE_LABEL[selected.state]} />
                <span className="detail-title">{selected.title}</span>
                <button
                  className="detail-id"
                  onClick={() => copy('id', selected.id)}
                  title="Copy the full session id"
                >
                  {selected.id}
                  {copied === 'id' && <span className="copied-flash">copied</span>}
                </button>
                <span className="detail-path">
                  {shortPath(selected.cwd)}
                  {selected.branch ? ` · ${selected.branch}` : ''}
                  {selected.git?.isWorktree ? ' · worktree' : ''}
                  {` · ${relTime(selected.lastActivity, now)} ago`}
                </span>
                <div className="detail-actions">
                  {selected.review && (
                    <span
                      className="review-tag"
                      title={`This session was opened with /${selected.review.command}`}
                    >
                      /{selected.review.command}
                    </span>
                  )}
                  {/* The PR under review is a different thing from the PR this
                      session RAISED, and only usually the same one — reviewing
                      your own draft is the common case, and then showing both
                      buttons would just be the same link twice. */}
                  {(selected.review?.prs ?? [])
                    .filter((p) => p.url !== selected.pr?.url)
                    .map((p) => (
                      <a key={p.url} className="btn" href={p.url} target="_blank" rel="noreferrer"
                         title={`Reviewing ${p.repository} #${p.number}`}>
                        Reviewing #{p.number}
                      </a>
                    ))}
                  {selected.pr && (
                    <a className="btn" href={selected.pr.url} target="_blank" rel="noreferrer"
                       title={`${selected.pr.repository} #${selected.pr.number}`}>
                      PR #{selected.pr.number}
                    </a>
                  )}
                  <button
                    className="btn"
                    onClick={() => copy('resume', `cd ${selected.cwd} && claude --resume ${selected.id}`)}
                    title="Copy the resume command for your own terminal"
                  >
                    Copy resume
                    {copied === 'resume' && <span className="copied-flash">Copied</span>}
                  </button>
                  {termOpen ? (
                    <>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => void termCommand(selected, 'branch')}
                        title="Fork this session into a new one from here (/branch). The terminal follows the branch."
                      >
                        Branch
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setRenameText(selected.title);
                          setRenameOpen(true);
                          setTimeout(() => renameRef.current?.select(), 30);
                        }}
                        title="Rename this session (/rename)"
                      >
                        Rename
                      </button>
                      <button className="btn" disabled={busy} onClick={() => void restart(selected)}>Restart</button>
                      <button className="btn danger" disabled={busy} onClick={() => void closeTerm(selected)}>Close</button>
                    </>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={busy || liveElsewhere}
                      onClick={() => void attach(selected)}
                      title={liveElsewhere
                        ? `Already running in another terminal (pid ${selected.live!.pid}) — resuming twice would conflict`
                        : 'Open this session in an embedded terminal'}
                    >
                      Open terminal
                    </button>
                  )}
                </div>
              </div>

              <div className="detail-row">
                <span className="detail-label">Priority</span>
                {(['p0', 'p1', 'p2'] as Priority[]).map((p) => (
                  <button
                    key={p}
                    className={`btn sm${selected.user.priority === p ? ' on' : ''}`}
                    onClick={() => void patch(selected.id, { priority: selected.user.priority === p ? null : p })}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
                <button
                  className={`btn sm${selected.user.pinned ? ' on' : ''}`}
                  onClick={() => void patch(selected.id, { pinned: !selected.user.pinned })}
                >
                  {selected.user.pinned ? '★ Pinned' : '☆ Pin'}
                </button>
                <span className="detail-label" style={{ marginLeft: 6 }}>Snooze</span>
                {SNOOZE_OPTIONS.map(([label, ms]) => (
                  <button key={label} className="btn sm"
                          onClick={() => void patch(selected.id, { snoozedUntil: Date.now() + ms })}>
                    {label}
                  </button>
                ))}
                {selected.user.snoozedUntil && selected.user.snoozedUntil > now && (
                  <button className="btn sm on" onClick={() => void patch(selected.id, { snoozedUntil: null })}>
                    Unsnooze
                  </button>
                )}
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void patch(selected.id, { archived: !selected.user.archived })}
                  title={selected.user.archived ? 'Return to the active list' : 'Hide from the active list'}
                >
                  {selected.user.archived ? 'Unarchive' : 'Archive'}
                </button>
              </div>

              <div className="detail-row">
                <span className="detail-label">Tags</span>
                {selected.user.tags.map((t) => (
                  <button
                    key={t}
                    className="chip tag removable"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => void patch(selected.id, { tags: selected.user.tags.filter((x) => x !== t) })}
                  >
                    {t} ✕
                  </button>
                ))}
                <input
                  key={selected.id}
                  ref={tagRef}
                  className="tag-input"
                  placeholder="add tag…"
                  list="ct-tags"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
                    if (!v) return;
                    if (!selected.user.tags.includes(v)) {
                      void patch(selected.id, { tags: [...selected.user.tags, v] });
                    }
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
                <datalist id="ct-tags">
                  {(payload?.tags ?? []).map((t) => <option key={t} value={t} />)}
                </datalist>
                <span className="detail-path" style={{ marginLeft: 8 }}>
                  {selected.reasons.join(' · ')}
                </span>
              </div>
            </div>

            {termOpen && termId ? (
              <TerminalPane
                key={`${termId}:${restartNonce}`}
                termId={termId}
                onExit={() => { setExitedFor(selected.id); void refresh(true); }}
              />
            ) : (
              <div className="term-wrap">
                <div className="term-empty">
                  <h3>{liveElsewhere ? 'Running in another terminal' : 'No terminal open'}</h3>
                  <p>
                    {liveElsewhere ? (
                      <>
                        This session is live under pid <strong>{selected.live!.pid}</strong> ({selected.live!.status}).
                        Resuming it here would open a second client against the same transcript, so use
                        <em> Copy resume</em> only if you have closed the other one.
                      </>
                    ) : (
                      <>Open an embedded terminal for this session, or copy its resume command to run it yourself.</>
                    )}
                  </p>
                  {selected.lastPrompt && (
                    <p style={{ fontFamily: 'var(--mono)', color: 'var(--fg-muted)' }}>
                      Last prompt: “{selected.lastPrompt.slice(0, 220)}”
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="term-wrap">
            <div className="term-empty">
              <h3>Pick a session</h3>
              <p>Sessions are ranked by what needs you, not by when you last touched them.</p>
              <div className="help-grid">
                {SHORTCUTS.map((k) => (
                  <React.Fragment key={k.keys}>
                    <kbd>{k.keys}</kbd><span>{k.what}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {helpOpen && (
        <>
          <div className="scrim dim" onClick={() => setHelpOpen(false)} />
          <div className="help-modal" role="dialog" aria-modal="true" aria-label="Help">
            <div className="help-head">
              <strong>Claude Terminal</strong>
              <button className="btn sm" onClick={() => setHelpOpen(false)} title="Close (Esc)">✕</button>
            </div>

            <p className="help-note">
              Every Claude Code session on this machine, ranked by what needs you rather than by
              when you last touched it. Open one and its terminal runs right here — the same
              <code> claude --resume</code> you would have typed.
            </p>

            <div className="help-section">Keyboard</div>
            <div className="help-grid">
              {SHORTCUTS.map((k) => (
                <React.Fragment key={k.keys}>
                  <kbd>{k.keys}</kbd><span>{k.what}</span>
                </React.Fragment>
              ))}
            </div>

            <div className="help-section">Reading the list</div>
            <div className="help-grid">
              {BUCKET_ORDER.map((b) => (
                <React.Fragment key={b}>
                  <span className="help-swatch"><span className="dot" style={{ background: BUCKET_COLOR[b] }} /></span>
                  <span><strong>{BUCKET_LABEL[b]}</strong> — {BUCKET_HELP[b]}</span>
                </React.Fragment>
              ))}
              {SHAPE_ORDER.map((sh) => (
                <React.Fragment key={sh}>
                  <span className="help-swatch"><span className={`shape ${sh}`}>{SHAPE_GLYPH[sh]}</span></span>
                  <span><strong>{SHAPE_LABEL[sh]}</strong> — {SHAPE_HINT[sh]}</span>
                </React.Fragment>
              ))}
            </div>

            <div className="help-section">Good to know</div>
            <ul className="help-list">
              <li>
                Ranking pauses while your pointer is over the list, so a row never moves out
                from under a click.
              </li>
              <li>
                <strong>Artifacts</strong> published by a session appear above its title. They open
                on claude.ai; republishing keeps one entry and bumps its version.
              </li>
              <li>
                A session opened with a review command is typed as a <b>review</b> and links to
                every PR the invocation named — several, when the review covers several. A
                session branched off a review does not inherit the label: only the command this
                session ran itself counts.
              </li>
              <li>
                Terminals you leave open are offered back the next time you launch, so quitting to
                update costs you nothing.
              </li>
              <li>
                <strong>Active only</strong> is on by default and shows just the sessions with
                Claude running right now — including snoozed ones, because a session that is
                still running has not really been set aside. Searching, or clicking one of the
                counts at the top, overrides it, so you can always reach a session it hides.
              </li>
              <li>
                Drag the edge of the list to resize it; double-click that edge to reset it.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
