/**
 * The completion watcher:  npm run test:completions
 *
 * Pure logic, driven with a fake clock and a fake live registry — no processes,
 * no filesystem, no server. That is the whole reason `tickCompletions` takes
 * `now` and `live` as parameters: the behaviour worth pinning here is entirely
 * about SEQUENCE, and a test that had to spawn real sessions to reach it would
 * be slow, flaky, and unable to reach the interesting cases at all.
 *
 * What it holds:
 *  - a completion fires once the session has stayed stopped for the hold
 *  - a session that goes back to work inside the hold fires NOTHING, which is
 *    the case that decides whether this feature is usable — Claude Code reports
 *    'idle' between turns, so firing on the raw edge notifies you about a gap
 *  - a process that vanishes mid-work is reported, and one that vanishes while
 *    already idle is not
 *  - the first tick fires nothing, so starting the app does not announce every
 *    session it finds
 */
import { HOLD_MS, completionEvents, resetCompletions, tickCompletions } from '../server/completions.js';
import type { CompletionEvent, LiveInfo } from '../server/types.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
}

/** One live-registry entry; only `status` matters to the watcher. */
function entry(status: LiveInfo['status']): LiveInfo {
  return { pid: 1, status, name: '', statusUpdatedAt: 0, startedAt: 0 };
}

function live(...pairs: [string, LiveInfo['status']][]): Map<string, LiveInfo> {
  return new Map(pairs.map(([id, s]) => [id, entry(s)]));
}

/** Collect events emitted while running `fn`, from a clean watcher. */
function run(fn: (tick: (t: number, m: Map<string, LiveInfo>) => void) => void): CompletionEvent[] {
  resetCompletions();
  const got: CompletionEvent[] = [];
  const on = (e: CompletionEvent) => got.push(e);
  completionEvents.on('completed', on);
  try {
    fn((t, m) => tickCompletions(t, m));
  } finally {
    completionEvents.off('completed', on);
    resetCompletions();
  }
  return got;
}

console.log('completion watcher\n');

// A plain finish: busy, then idle, then long enough to believe it.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'idle']));
    tick(1000 + HOLD_MS, live(['a', 'idle']));
  });
  check('busy -> idle fires once the hold elapses',
    got.length === 1 && got[0].sessionId === 'a' && got[0].kind === 'idle',
    JSON.stringify(got));
  // The stamp is when it STOPPED (1000), not when the event fired. The UI keys
  // its markers on this, so a drifting value would re-raise a dismissed one.
  check('the event is stamped when it stopped, not when it fired',
    got[0]?.at === 1000, String(got[0]?.at));
}

// Nothing fires before the hold is up.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'idle']));
    tick(1000 + HOLD_MS - 1, live(['a', 'idle']));
  });
  check('nothing fires inside the hold window', got.length === 0, JSON.stringify(got));
}

// The case the hold exists for: a gap between turns, not a completion.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'idle']));
    tick(2000, live(['a', 'busy']));
    tick(60_000, live(['a', 'busy']));
  });
  check('a session that resumes inside the hold fires nothing',
    got.length === 0, JSON.stringify(got));
}

// Stopped ON a dialog is a different thing from a finished turn.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'waiting']));
    tick(1000 + HOLD_MS, live(['a', 'waiting']));
  });
  check('busy -> waiting reports kind "waiting"',
    got.length === 1 && got[0].kind === 'waiting', JSON.stringify(got));
}

// Sitting at a question for an hour must not re-announce itself every tick.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'waiting']));
    for (let t = 1000 + HOLD_MS; t < 3600_000; t += 60_000) tick(t, live(['a', 'waiting']));
  });
  check('a session left stopped fires exactly once', got.length === 1, String(got.length));
}

// The process went away mid-work.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live());
    tick(1000 + HOLD_MS, live());
  });
  check('a process that vanishes while busy reports kind "exited"',
    got.length === 1 && got[0].kind === 'exited', JSON.stringify(got));
}

// Closing a terminal on a session that was already idle is not news.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'idle']));
    tick(1000 + HOLD_MS, live(['a', 'idle']));   // the one legitimate event
    tick(2000 + HOLD_MS, live());                 // now the process exits
    tick(9000 + HOLD_MS * 2, live());
  });
  check('an already-idle session exiting adds nothing',
    got.length === 1 && got[0].kind === 'idle', JSON.stringify(got));
}

// Starting the app with work already in flight must be silent.
{
  const got = run((tick) => {
    tick(0, live(['a', 'idle'], ['b', 'waiting'], ['c', 'busy']));
    tick(HOLD_MS * 2, live(['a', 'idle'], ['b', 'waiting'], ['c', 'busy']));
  });
  check('the first tick announces nothing', got.length === 0, JSON.stringify(got));
}

// A session already running at startup still reports when it finishes.
{
  const got = run((tick) => {
    tick(0, live(['c', 'busy']));
    tick(1000, live(['c', 'idle']));
    tick(1000 + HOLD_MS, live(['c', 'idle']));
  });
  check('a session running at startup still reports its finish',
    got.length === 1 && got[0].sessionId === 'c', JSON.stringify(got));
}

// 'unknown' is a session too new to have reported — absence of information.
{
  const got = run((tick) => {
    tick(0, live(['a', 'unknown']));
    tick(1000, live(['a', 'unknown']));
    tick(HOLD_MS * 3, live(['a', 'unknown']));
  });
  check('a session that never reports a status announces nothing',
    got.length === 0, JSON.stringify(got));
}

// ...and it must not be read as a rest state by a busy session either.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live(['a', 'unknown']));
    tick(1000 + HOLD_MS * 2, live(['a', 'unknown']));
  });
  check('busy -> unknown is not a completion', got.length === 0, JSON.stringify(got));
}

// A resumed id starts clean rather than inheriting the old process's status.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy']));
    tick(1000, live());                    // gone: fires 'exited' after the hold
    tick(1000 + HOLD_MS, live());
    tick(2000 + HOLD_MS, live(['a', 'idle']));   // resumed, sitting idle
    tick(9000 + HOLD_MS * 3, live(['a', 'idle']));
  });
  check('a resumed session does not fire again on arrival',
    got.length === 1 && got[0].kind === 'exited', JSON.stringify(got));
}

// Several at once, each reported on its own terms.
{
  const got = run((tick) => {
    tick(0, live(['a', 'busy'], ['b', 'busy'], ['c', 'busy']));
    tick(1000, live(['a', 'idle'], ['b', 'waiting'], ['c', 'busy']));
    tick(1000 + HOLD_MS, live(['a', 'idle'], ['b', 'waiting'], ['c', 'busy']));
  });
  const kinds = new Map(got.map((e) => [e.sessionId, e.kind]));
  check('concurrent completions are reported independently',
    got.length === 2 && kinds.get('a') === 'idle' && kinds.get('b') === 'waiting',
    JSON.stringify(got));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
