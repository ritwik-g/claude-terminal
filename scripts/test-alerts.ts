/**
 * Usage alerts, snooze wake times and context sizing:  npm run test:alerts
 *
 * Four things meet here and each one is easy to get quietly wrong:
 *
 *   - `wakeAt` has to name the next time you will be at your desk, which means
 *     skipping weekends and surviving a DST boundary. Both are arithmetic that
 *     LOOKS right when written as `now + 24h` and is not.
 *   - `alertsFor` has to fire once per condition per window and then go quiet
 *     until the window itself rolls over — the de-duplication lives in the key,
 *     so the key is what gets checked.
 *   - a session is only flagged as worth compacting while it is actually
 *     SPENDING — running now — and the cache warning lists a session only
 *     while its cache is still there to save.
 *   - `contextTokens` is read out of real transcripts, and the only proof that
 *     the field it reads still exists is reading the ones on this machine.
 *
 * The first three are pure and use fixed clocks. The last runs against your real
 * ~/.claude/projects tree, because a fixture would only prove that the parser
 * can parse the fixture.
 */
import { alertsFor } from '../web/src/alerts';
import { DEFAULT_PREFS, type Prefs } from '../web/src/prefs';
import {
  BREAK_WINDOW_MS, breakCandidates, breakDue, cacheExpiresAt, compactBeforeSnooze, cacheExpiring, cacheLeftMs, formatTokens, wakeAt,
  worthCompacting,
} from '../web/src/util';
import { scanAll } from '../server/scan';
import { EMPTY_USER_STATE, type Session } from '../server/types';
import type { UsageSnapshot } from '../server/usage';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const show = (t: number) => {
  const d = new Date(t);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Local midnight-anchored clock, so these read as wall time wherever they run. */
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

const NINE = 9 * 60;

function wakeChecks(): void {
  console.log('\nwakeAt — "tomorrow" and "next week"\n');

  // 2026-09-22 is a Tuesday. Everything below is anchored to that week.
  const tue = at(2026, 9, 22, 14, 30);
  const tomorrow = wakeAt(tue, 1, NINE);
  check('Tuesday afternoon → Wednesday 09:00', show(tomorrow) === 'Wed 23/9 09:00', show(tomorrow));

  const friEvening = at(2026, 9, 25, 18, 5);
  const afterFri = wakeAt(friEvening, 1, NINE);
  check('Friday evening → Monday 09:00, not Saturday', show(afterFri) === 'Mon 28/9 09:00', show(afterFri));

  const satMorning = at(2026, 9, 26, 10, 0);
  const afterSat = wakeAt(satMorning, 1, NINE);
  check('Saturday → Monday 09:00', show(afterSat) === 'Mon 28/9 09:00', show(afterSat));

  // A week from a Tuesday is the next Tuesday; a week from a Saturday lands on
  // a Saturday and has to slide to the Monday after it.
  const weekFromTue = wakeAt(tue, 7, NINE);
  check('Tuesday + 1 week → the next Tuesday 09:00', show(weekFromTue) === 'Tue 29/9 09:00', show(weekFromTue));
  const weekFromSat = wakeAt(satMorning, 7, NINE);
  check('Saturday + 1 week → the Monday after 09:00', show(weekFromSat) === 'Mon 5/10 09:00', show(weekFromSat));

  // Snoozing at 08:00 for "tomorrow" must not resolve to a 09:00 that is 55
  // minutes away. minDays already moves it a day, so this is really a guard on
  // the arithmetic never landing in the past.
  const early = at(2026, 9, 22, 8, 5);
  check('an early-morning "tomorrow" is still tomorrow', wakeAt(early, 1, NINE) > early + 12 * 3600_000);

  // Every result must be in the future, at the requested minute, and never on
  // a weekend — swept across a whole year of start times so a DST boundary in
  // any zone is included rather than hoped for.
  let bad = 0;
  let notNine = 0;
  let weekend = 0;
  for (let i = 0; i < 365 * 4; i++) {
    const start = at(2026, 1, 1, 0, 0) + i * 6 * 3600_000;
    for (const days of [1, 7]) {
      const w = wakeAt(start, days, NINE);
      if (w <= start) bad++;
      const d = new Date(w);
      if (d.getHours() !== 9 || d.getMinutes() !== 0) notNine++;
      if (d.getDay() === 0 || d.getDay() === 6) weekend++;
    }
  }
  check('every wake time is in the future', bad === 0, `${bad} in the past`);
  check('every wake time is exactly 09:00 local, DST included', notNine === 0, `${notNine} off the hour`);
  check('no wake time lands on a weekend', weekend === 0, `${weekend} on a weekend`);

  // The wake hour is a setting, so an odd one has to work as well as 09:00.
  const odd = wakeAt(tue, 1, 6 * 60 + 45);
  check('a 06:45 wake hour is honoured', show(odd) === 'Wed 23/9 06:45', show(odd));
}

function alertChecks(): void {
  console.log('\nalertsFor — when to interrupt\n');

  const now = at(2026, 9, 22, 10, 12);
  const snap = (fivePct: number, fiveResetsInMin: number, weekPct = 20): UsageSnapshot => ({
    fiveHour: { percent: fivePct, resetsAt: now + fiveResetsInMin * 60_000 },
    weekly: { percent: weekPct, resetsAt: now + 5 * 24 * 3600_000 },
    fetchedAt: now - 60_000,
    stale: false,
  });
  const prefs: Prefs = { ...DEFAULT_PREFS };
  const keys = (u: UsageSnapshot | null, p = prefs) => alertsFor(u, p, now).map((a) => a.key);

  check('a quiet account raises nothing', keys(snap(12, 48)).length === 0);
  check('null usage raises nothing', keys(null).length === 0);

  check('80% of the 5-hour window fires', keys(snap(80, 200)).some((k) => k.startsWith('fiveHour:pct')));
  check('79% does not', keys(snap(79, 200)).length === 0);
  check('the threshold is a setting', keys(snap(72, 200), { ...prefs, usageThresholdPct: 70 }).length === 1);

  check('30 minutes before a reset fires', keys(snap(12, 29)).some((k) => k.startsWith('fiveHour:reset')));
  check('31 minutes before does not', keys(snap(12, 31)).length === 0);
  check('a reset already past does not', keys(snap(12, -5)).some((k) => k.startsWith('fiveHour:reset')) === false);

  check('the weekly window is watched too', keys(snap(10, 300, 85)).some((k) => k.startsWith('weekly:pct')));

  // The 5-hour window is the one that stops work today, so it must lead when
  // both windows are shouting.
  const both = alertsFor(snap(85, 300, 90), prefs, now);
  check('the 5-hour window sorts first', both[0]?.window === 'fiveHour', both[0]?.key);

  // A reading whose own window has already rolled over describes a window that
  // no longer exists, so its percentage cannot justify an alert.
  const expired: UsageSnapshot = {
    fiveHour: { percent: 96, resetsAt: now - 10 * 60_000 },
    weekly: null,
    fetchedAt: now - 40 * 60_000,
    stale: false,
  };
  check('an expired window raises no threshold alert', keys(expired).length === 0);

  // The key is what stops an alert firing every 30 seconds — and what lets the
  // NEXT window fire again. Same window, same key; new window, new key.
  const a1 = keys(snap(85, 200));
  const a2 = keys(snap(88, 200));
  check('the same window keeps the same key as the number moves', a1[0] === a2[0], `${a1[0]} vs ${a2[0]}`);
  const later: UsageSnapshot = {
    fiveHour: { percent: 85, resetsAt: now + 400 * 60_000 },
    weekly: null,
    fetchedAt: now,
    stale: false,
  };
  check('a new window gets a new key', keys(later)[0] !== a1[0], keys(later)[0]);

  check('alerts off means silence', keys(snap(99, 5), { ...prefs, alertsEnabled: false }).length === 0);
}

/** Just enough Session to be selected, or not, as a compaction candidate. */
function fakeSession(over: Partial<Session> & { id: string }): Session {
  return {
    file: '', projectKey: '', cwd: '', branch: '', title: over.id, titleSource: 'id',
    lastPrompt: '', recap: '', pr: null, review: null, startedAt: 0, lastActivity: 0,
    sizeBytes: 0, messages: 0, contextTokens: 0, lastApiAt: 0, cacheTtlMs: 3600_000, version: '',
    tail: { lastStopReason: null, lastRole: null, lastUserWasToolResult: false,
            endedMidTool: false, pendingTools: [], pendingQuestion: null },
    live: null, git: null, user: { ...EMPTY_USER_STATE }, shape: 'task', state: 'quiet',
    score: 0, reasons: [], attached: false, termId: null, keepWarm: null,
    ...over,
  };
}

const LIVE = { pid: 1, status: 'idle' as const, name: '', statusUpdatedAt: 0, startedAt: 0 };

function candidateChecks(): void {
  console.log('\nworthCompacting — big, running, and its cache about to go\n');

  const now = Date.parse('2026-09-23T12:00:00Z');
  const MIN = 60_000;
  const risk = { leadMs: 20 * MIN, minTokens: 100_000 };
  const at = (id: string, ago: number, over: Partial<Session> = {}) =>
    fakeSession({ id, contextTokens: 400_000, live: LIVE, lastApiAt: now - ago * MIN, cacheTtlMs: 60 * MIN, ...over });

  check('a big running session with its cache about to expire is flagged', worthCompacting(at('soon', 50), risk, now));
  check('a big one with plenty of cache left is not — nothing is lost yet', !worthCompacting(at('fresh', 10), risk, now));
  check('one whose cache has expired is not — compacting now costs a full rewrite',
    !worthCompacting(at('gone', 70), risk, now));
  check('a session under the size floor is not', !worthCompacting(at('small', 50, { contextTokens: 9_000 }), risk, now));
  check('an idle session is never flagged, however big', !worthCompacting(at('idle', 50, { live: null }), risk, now));
  check('an archived session is not, even running',
    !worthCompacting(at('archived', 50, { user: { ...EMPTY_USER_STATE, archived: true } }), risk, now));
}

function cacheChecks(): void {
  console.log('\ncacheExpiring — whose cache is about to lapse\n');

  const now = Date.parse('2026-09-23T12:00:00Z');
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const opts = { leadMs: 20 * MIN, minTokens: 100_000 };
  // Last API call `ago` minutes back, so the cache has 60 - ago left.
  const at = (id: string, ago: number, over: Partial<Session> = {}) =>
    fakeSession({ id, contextTokens: 300_000, live: LIVE, lastApiAt: now - ago * MIN, cacheTtlMs: HOUR, ...over });

  const soon = at('soon', 50);
  const sooner = at('sooner', 55);
  const plenty = at('plenty', 20);
  const expired = at('expired', 61);
  const small = at('small', 50, { contextTokens: 40_000 });
  const dead = at('dead', 50, { live: null });
  const warm = at('warm', 50, {
    keepWarm: {
      active: true, enabledAt: 0, until: now + HOUR, untilSend: false, pausePct: null, pings: 0,
      lastPingAt: null, awaitingReply: false, nextPingAt: null, lastResult: null, held: null,
      heldSince: null, unsentSince: null, stopped: null,
    },
  });
  const snoozed = at('snoozed', 50, { user: { ...EMPTY_USER_STATE, snoozedUntil: now + HOUR } });
  const neverCalled = fakeSession({ id: 'never', contextTokens: 300_000, live: LIVE });
  const fiveMin = at('five-min', 1, { cacheTtlMs: 5 * MIN });

  const got = cacheExpiring(
    [plenty, soon, expired, small, dead, warm, snoozed, neverCalled, sooner, fiveMin], opts, now,
  ).map((s) => s.id);
  check('only live, big, unwarmed caches inside the lead are listed', got.join(',') === 'five-min,sooner,soon', got.join(','));
  check('an expired cache is not — compacting it now costs a full rewrite anyway', !got.includes('expired'));
  check('one kept warm is not', !got.includes('warm'));
  check('a 5-minute cache is timed on its own lifetime', got[0] === 'five-min', got.join(','));
  check('the expiry is the last API call plus the lifetime', cacheExpiresAt(soon) === now - 50 * MIN + HOUR);
  check('a session with no API call has no expiry', cacheLeftMs(neverCalled, now) === null);
  check('at most four are listed',
    cacheExpiring(Array.from({ length: 7 }, (_, i) => at(`m${i}`, 45 + i)), opts, now).length === 4);
}

function breakChecks(): void {
  console.log('\nbreak reminders — lunch and the end of the day\n');

  const times = { lunch: 12 * 60, 'day-end': 16 * 60 };
  const local = (h: number, m = 0) => new Date(2026, 8, 23, h, m).getTime();

  check('nothing is due in the morning', breakDue(local(10), times) === null);
  check('lunch is due at 12:00', breakDue(local(12), times)?.kind === 'lunch');
  check('and still at 12:59', breakDue(local(12, 59), times)?.kind === 'lunch');
  check('but not an hour later', breakDue(local(13), times) === null);
  const end = breakDue(local(16, 20), times);
  check('the end of the day is due at 16:20', end?.kind === 'day-end');
  check('its key names the day, so it fires once a day', end?.key === 'day-end:2026-9-23', end?.key);
  check('a reminder that is off never fires', breakDue(local(12, 10), { ...times, lunch: null }) === null);
  check('when two overlap the later one wins',
    breakDue(local(12, 40), { lunch: 12 * 60, 'day-end': 12 * 60 + 30 })?.kind === 'day-end');
  check('the window is an hour', BREAK_WINDOW_MS === 60 * 60_000);

  const now = local(16, 5);
  const MIN = 60_000;
  const s = (id: string, tokens: number, ago: number, over: Partial<Session> = {}) =>
    fakeSession({ id, contextTokens: tokens, live: LIVE, lastApiAt: now - ago * MIN, cacheTtlMs: 60 * MIN, ...over });
  const warm = {
    active: true, enabledAt: 0, until: now + 60 * MIN, untilSend: false, pausePct: null, pings: 0,
    lastPingAt: null, awaitingReply: false, nextPingAt: null, lastResult: null, held: null,
    heldSince: null, unsentSince: null, stopped: null,
  };
  const all = [
    s('mid', 200_000, 5),
    s('big', 600_000, 40),
    s('expired', 900_000, 70),
    s('small', 50_000, 5),
    s('closed', 500_000, 5, { live: null }),
    s('kept', 300_000, 5, { keepWarm: warm }),
  ];
  const lunch = breakCandidates(all, 'lunch', 100_000, now).map((x) => x.id);
  const dayEnd = breakCandidates(all, 'day-end', 100_000, now).map((x) => x.id);
  check('lunch lists warm, big, running caches, biggest first — not ones kept warm',
    lunch.join(',') === 'big,mid', lunch.join(','));
  check('the end of the day also lists one kept warm, since that stops before morning',
    dayEnd.join(',') === 'big,kept,mid', dayEnd.join(','));
  check('with a cache still fresh — it will not be by the time you are back', lunch.includes('mid'));
}

function snoozeChecks(): void {
  console.log('\ncompactBeforeSnooze — ask before a warm cache is snoozed away\n');

  const now = Date.parse('2026-09-23T12:00:00Z');
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  // Last API call 10 minutes ago: the cache expires at now + 50m.
  const s = (over: Partial<Session> = {}) => fakeSession({
    id: 'big', contextTokens: 400_000, attached: true, termId: 't1', live: LIVE,
    lastApiAt: now - 10 * MIN, cacheTtlMs: HOUR, ...over,
  });
  const kw = (until: number) => ({
    active: true, enabledAt: 0, until, untilSend: false, pausePct: null, pings: 0,
    lastPingAt: null, awaitingReply: false, nextPingAt: null, lastResult: null, held: null,
    heldSince: null, unsentSince: null, stopped: null,
  });
  const MINTOK = 100_000;

  check('a big warm session snoozed past its cache is asked about', compactBeforeSnooze(s(), now + 4 * HOUR, MINTOK, now));
  check('not when it wakes before the cache expires', !compactBeforeSnooze(s(), now + 30 * MIN, MINTOK, now));
  check('not under the size floor', !compactBeforeSnooze(s({ contextTokens: 50_000 }), now + 4 * HOUR, MINTOK, now));
  check('not once the cache has expired — compacting then costs a rewrite too',
    !compactBeforeSnooze(s({ lastApiAt: now - 2 * HOUR }), now + 4 * HOUR, MINTOK, now));
  check('not in someone else\'s terminal — there is nothing here to type into',
    !compactBeforeSnooze(s({ attached: false, termId: null }), now + 4 * HOUR, MINTOK, now));
  check('not when keep-warm covers the whole snooze',
    !compactBeforeSnooze(s({ keepWarm: kw(now + 8 * HOUR) }), now + 4 * HOUR, MINTOK, now));
  check('but yes when the snooze outlasts keep-warm',
    compactBeforeSnooze(s({ keepWarm: kw(now + 2 * HOUR) }), now + 4 * HOUR, MINTOK, now));
}

async function contextChecks(): Promise<void> {
  console.log('\ncontextTokens — read from your real transcripts\n');

  const sessions = await scanAll();
  if (sessions.length < 3) {
    console.log('  (too few transcripts on this machine to be meaningful — skipped)');
    return;
  }
  const withCtx = sessions.filter((s) => s.contextTokens > 0);
  console.log(`  (${sessions.length} sessions, ${withCtx.length} with a context reading)\n`);

  // If this ever drops to zero the `usage` block has moved or been renamed,
  // and every compaction suggestion in the app silently stops appearing.
  check('some sessions carry a context reading', withCtx.length > 0);

  // 2M is past any published context window; anything above it means we are
  // summing something we should not be — a subagent's turn, or every turn in
  // the file rather than the last one.
  const absurd = withCtx.filter((s) => s.contextTokens > 2_000_000);
  check('no session reports an impossible context', absurd.length === 0,
    absurd.map((s) => `${s.id.slice(0, 8)}=${s.contextTokens}`).join(', '));

  // A transcript big enough to hold a real conversation should have a reading
  // of a real conversation's size, not a few hundred tokens from a stub turn.
  const big = withCtx.filter((s) => s.sizeBytes > 2_000_000);
  const tiny = big.filter((s) => s.contextTokens < 5_000);
  check('multi-megabyte transcripts report a real context size', tiny.length === 0,
    tiny.map((s) => `${s.id.slice(0, 8)}=${s.contextTokens}`).join(', '));

  const heaviest = [...withCtx].sort((a, b) => b.contextTokens - a.contextTokens).slice(0, 5);
  console.log('\n  heaviest sessions:');
  for (const s of heaviest) {
    console.log(`    ${formatTokens(s.contextTokens).padStart(6)}  ${s.title.slice(0, 56)}`);
  }
}

const main = async () => {
  wakeChecks();
  alertChecks();
  candidateChecks();
  cacheChecks();
  breakChecks();
  snoozeChecks();
  await contextChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
