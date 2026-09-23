/**
 * Keep-warm:  npm run test:keepwarm
 *
 * Driven with a fake clock, fake terminals and a fake registry, over real
 * transcript files in a throwaway HOME — no processes and no server. What it
 * holds is the one promise the feature makes: it types into a session only
 * when that cannot land anywhere it should not.
 *
 *  - never while the session is busy, on a dialog, over an unanswered
 *    question, or before it has reported a status — only 'idle' or 'shell'
 *  - never over something you typed and did not send: that turns it OFF
 *  - keys you press while a dialog is up, and the reports a terminal sends by
 *    itself, are not typing
 *  - it gives up on a cache that keeps missing, and on a ping that started no
 *    turn, rather than pinging into the void
 *  - the ping's own turn is not a completion, not activity, not your last
 *    prompt, and not searchable
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-keepwarm-'));
// Before anything that reads paths.ts is imported: it resolves ~ once, at load.
process.env.HOME = path.join(ROOT, 'home');
const PROJECTS = path.join(ROOT, 'home', '.claude', 'projects', '-ct-keepwarm');
fs.mkdirSync(PROJECTS, { recursive: true });

const kw = await import('../server/keepwarm.js');
const { tickCompletions, completionEvents, resetCompletions, HOLD_MS } = await import('../server/completions.js');
const { scanAll } = await import('../server/scan.js');
type LiveInfo = import('../server/types.js').LiveInfo;
type TermInfo = import('../server/pty.js').TermInfo;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();
const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FILE = path.join(PROJECTS, `${SID}.jsonl`);

// ------------------------------------------------------------ transcript kit

const sent = (t: number, text = 'do the thing') => ({
  type: 'user', timestamp: iso(t), origin: { kind: 'human' }, promptSource: 'typed',
  message: { role: 'user', content: text },
});
const reply = (t: number, read = 50_000, write = 500, extra: object = {}) => ({
  type: 'assistant', timestamp: iso(t),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  ...extra,
});
const ping = (t: number) => ({
  type: 'user', timestamp: iso(t), origin: { kind: 'human' }, promptSource: 'typed',
  message: { role: 'user', content: kw.PING_TEXT },
});

function writeLog(recs: object[]): void {
  fs.writeFileSync(FILE, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function appendLog(...recs: object[]): void {
  fs.appendFileSync(FILE, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------------------------------------------------------------- fake world

let status: LiveInfo['status'] | null = 'idle';
let fiveHour: number | null = null;
let termAlive = true;
let writes: string[] = [];

const TERM: TermInfo = {
  id: 'term-1', sessionId: SID, cwd: ROOT, pid: 4242, cols: 80, rows: 24,
  startedAt: T0, exited: false, exitCode: null, exitedAt: null,
};

function world(): void {
  kw.resetKeepWarm();
  status = 'idle';
  fiveHour = null;
  termAlive = true;
  writes = [];
  kw.setKeepWarmDeps({
    terms: () => (termAlive ? [TERM] : []),
    status: () => status,
    fiveHourPct: () => fiveHour,
    write: (_id, data) => { writes.push(data); return true; },
    later: (fn) => fn(),
  });
}

const OPTS = { minutes: 240, untilSend: false, pausePct: 80 };
const pinged = () => writes.join('') === `${kw.PING_TEXT}\r`;
const view = () => kw.keepWarmView(SID)!;

console.log('keep-warm\n');

// ----------------------------------------------------------- terminal reports
{
  const reports = ['\x1b[I', '\x1b[O', '\x1b[<0;12;5M', '\x1b[<64;3;4m', '\x1b[?1;2c',
    '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[?2004;1$y', '\x1b[?1u', '\x1b]11;rgb:0a0a/0c0c/0f0f\x07',
    '\x1bP>|xterm.js(5.5.0)\x1b\\'];
  check('terminal reports are not typing', reports.every((r) => !kw.isTyping(r)),
    JSON.stringify(reports.filter((r) => kw.isTyping(r))));
  check('a key is typing', kw.isTyping('a'));
  check('a report with a key riding along is typing', kw.isTyping('\x1b[Ia'));
  check('a paste is typing', kw.isTyping('\x1b[200~hello\x1b[201~'));
  check('Enter alone is typing', kw.isTyping('\r'));
  check('a CSI-u key (Shift+Enter) is typing', kw.isTyping('\x1b[13;2u'));
}

// ------------------------------------------------------------ reading turns
{
  const t = kw.parseTurns([
    sent(T0),
    reply(T0 + MIN),
    { type: 'user', timestamp: iso(T0 + 2 * MIN), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] } },
    { type: 'user', timestamp: iso(T0 + 3 * MIN), origin: { kind: 'task-notification' }, promptSource: 'system', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    { type: 'user', timestamp: iso(T0 + 4 * MIN), isMeta: true, message: { role: 'user', content: 'injected' } },
    ping(T0 + 5 * MIN),
    reply(T0 + 6 * MIN, 1, 1, { isSidechain: true }),
  ].map((r) => JSON.stringify(r)).join('\n'));
  check('the last message you sent skips tool results, notifications, meta and pings',
    t.lastSentAt === T0, iso(t.lastSentAt ?? 0));
  check('the last API call skips subagent turns', t.lastApiAt === T0 + MIN, iso(t.lastApiAt ?? 0));

  const legacy = kw.parseTurns([
    { type: 'user', timestamp: iso(T0), message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', timestamp: iso(T0 + MIN), message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
  ].map((r) => JSON.stringify(r)).join('\n'));
  check('a transcript without origin fields still finds what you sent', legacy.lastSentAt === T0, iso(legacy.lastSentAt ?? 0));

  const asking = kw.parseTurns(JSON.stringify({
    type: 'assistant', timestamp: iso(T0),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] },
  }));
  check('an unanswered question is seen', asking.pendingQuestion);
}

// ------------------------------------------------------------------ enabling
{
  world();
  termAlive = false;
  writeLog([sent(T0), reply(T0 + MIN)]);
  let err = '';
  try { kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN); } catch (e: any) { err = e.message; }
  check('enabling needs a terminal of ours', /terminal/.test(err), err);

  world();
  writeLog([sent(T0)]);
  err = '';
  try { kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN); } catch (e: any) { err = e.message; }
  check('enabling needs an API call to time from', /nothing to keep warm/.test(err), err);
}

// ----------------------------------------------------------------- the ping
{
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.tickKeepWarm(T0 + 30 * MIN);
  check('nothing is sent before the ping is due', writes.length === 0, JSON.stringify(writes));
  check('  and the next ping is timed from the last API call', view().nextPingAt === T0 + MIN + kw.PING_AFTER_MS);

  kw.tickKeepWarm(T0 + 47 * MIN);
  check('a due ping on an idle session is typed, then submitted separately',
    writes.length === 2 && writes[0] === kw.PING_TEXT && writes[1] === '\r', JSON.stringify(writes));
  check('  and counted', view().pings === 1 && view().lastPingAt === T0 + 47 * MIN);
  check('  and shown as awaiting its reply', view().awaitingReply);

  writes = [];
  kw.tickKeepWarm(T0 + 48 * MIN);
  check('no second ping while the first is awaiting its reply', writes.length === 0);

  appendLog(ping(T0 + 47 * MIN), reply(T0 + 47 * MIN + 3000, 80_000, 300));
  kw.tickKeepWarm(T0 + 49 * MIN);
  check('a reply that read the cache is a hit', view().lastResult === 'hit', String(view().lastResult));
  check('  and no longer awaited', !view().awaitingReply);
  check('  and the next ping is timed from the reply',
    view().nextPingAt === T0 + 47 * MIN + 3000 + kw.PING_AFTER_MS);
}

// ----------------------------------------------------------------- holding
{
  const due = T0 + 50 * MIN;
  for (const [st, want] of [['busy', 'busy'], ['unknown', 'unknown'], [null, 'no-status'], ['waiting', 'waiting']] as const) {
    world();
    writeLog([sent(T0), reply(T0 + MIN)]);
    kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
    status = st;
    kw.tickKeepWarm(due);
    check(`status ${st} holds the ping as '${want}'`, writes.length === 0 && view().held === want,
      `${view().held} / ${JSON.stringify(writes)}`);
  }

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'shell';
  kw.tickKeepWarm(due);
  check('status shell — idle with a background shell — pings', pinged(), JSON.stringify(writes));

  world();
  writeLog([sent(T0), reply(T0 + MIN), {
    type: 'assistant', timestamp: iso(T0 + 2 * MIN),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'q1', name: 'ExitPlanMode', input: {} }] },
  }]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 3 * MIN);
  kw.tickKeepWarm(due);
  check('an unapproved plan holds the ping even when the registry says idle',
    writes.length === 0 && view().held === 'question', String(view().held));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  fiveHour = 85;
  kw.tickKeepWarm(due);
  check('a 5-hour window past the pause threshold holds the ping', view().held === 'usage' && writes.length === 0);
  fiveHour = 40;
  kw.tickKeepWarm(due + 2000);
  check('  and it goes once the window has room', pinged() && view().held === null);
}

// --------------------------------------------------------------- ping anyway
{
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'busy';
  kw.tickKeepWarm(T0 + 50 * MIN);
  kw.pingNow(SID, T0 + 51 * MIN);
  check('Ping anyway overrides a busy hold', pinged(), JSON.stringify(writes));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'waiting';
  let err = '';
  try { kw.pingNow(SID, T0 + 51 * MIN); } catch (e: any) { err = e.message; }
  check('  but never types into a dialog', writes.length === 0 && /dialog/.test(err), err);
}

// ------------------------------------------------------------------- typing
{
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.noteInput('term-1', '\x1b[I', T0 + 10 * MIN);
  kw.noteInput('term-1', '\x1b[<64;3;4M', T0 + 11 * MIN);
  kw.tickKeepWarm(T0 + 50 * MIN);
  check('clicking into the pane and scrolling it is not typing', pinged(), JSON.stringify(writes));

  const stops: string[] = [];
  const onStop = (e: { reason: string }) => stops.push(e.reason);
  kw.keepWarmEvents.on('stopped', onStop);

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.noteInput('term-1', 'half a thought', T0 + 10 * MIN);
  check('unsent typing is shown before it matters', view().unsentSince === T0 + 10 * MIN);
  kw.tickKeepWarm(T0 + 20 * MIN);
  check('  and does nothing while the ping is not due', view().active);
  kw.tickKeepWarm(T0 + 50 * MIN);
  check('typing left unsent turns keep-warm OFF instead of pinging',
    writes.length === 0 && view().stopped?.reason === 'typed', JSON.stringify(view().stopped));
  check('  and says so', stops.includes('typed'), JSON.stringify(stops));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.noteInput('term-1', 'next question', T0 + 10 * MIN);
  kw.noteInput('term-1', '\r', T0 + 10 * MIN + 500);
  appendLog(sent(T0 + 10 * MIN + 600, 'next question'), reply(T0 + 11 * MIN));
  kw.tickKeepWarm(T0 + 20 * MIN);
  check('typing that was sent is not a draft', view().active && view().unsentSince === null);
  kw.tickKeepWarm(T0 + 57 * MIN);
  check('  and the ping goes when due from the new turn', pinged(), JSON.stringify(writes));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'waiting';
  kw.noteInput('term-1', '1', T0 + 10 * MIN);
  status = 'idle';
  kw.tickKeepWarm(T0 + 50 * MIN);
  check('answering a dialog is not a draft', pinged() && view().active, JSON.stringify(view().stopped));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.noteInput('term-1', 'typed before keep-warm existed', T0 + 90_000);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.noteInput('term-1', 'x', T0 + 10 * MIN);
  kw.tickKeepWarm(T0 + 50 * MIN);
  check('typing still stops it after a re-enable', view().stopped?.reason === 'typed');
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 51 * MIN);
  kw.tickKeepWarm(T0 + 52 * MIN);
  check('  and turning it back on is you saying the box is empty', pinged() && view().active);

  kw.keepWarmEvents.off('stopped', onStop);
}

// ---------------------------------------------------------- cache behaviour
{
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.tickKeepWarm(T0 + 47 * MIN);
  appendLog(ping(T0 + 47 * MIN), reply(T0 + 47 * MIN + 3000, 2_000, 80_000));
  kw.tickKeepWarm(T0 + 48 * MIN);
  check('a miss on a ping sent inside the hour counts', view().lastResult === 'miss' && view().active);
  kw.tickKeepWarm(T0 + 93 * MIN);
  appendLog(ping(T0 + 93 * MIN), reply(T0 + 93 * MIN + 3000, 2_000, 80_000));
  kw.tickKeepWarm(T0 + 94 * MIN);
  check(`${kw.MISSES_TO_STOP} misses in a row stop it`, view().stopped?.reason === 'cache-miss', JSON.stringify(view()));

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 90 * MIN);
  kw.tickKeepWarm(T0 + 90 * MIN);
  check('turned on after the hour, it pings straight away', pinged());
  appendLog(ping(T0 + 90 * MIN), reply(T0 + 90 * MIN + 3000, 2_000, 80_000));
  kw.tickKeepWarm(T0 + 91 * MIN);
  check('  and that miss is "cold" — expected — not counted', view().lastResult === 'cold' && view().active);

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.tickKeepWarm(T0 + 47 * MIN);
  kw.tickKeepWarm(T0 + 53 * MIN);
  check('a ping that starts no turn stops it rather than piling up text',
    view().stopped?.reason === 'no-reply' && writes.length === 2, JSON.stringify(writes));
}

// ------------------------------------------------------- review regressions
{
  // One ping out at a time.
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'busy';
  kw.pingNow(SID, T0 + 3 * MIN);
  let err = '';
  try { kw.pingNow(SID, T0 + 3 * MIN + 500); } catch (e: any) { err = e.message; }
  check('a second Ping anyway is refused while the first is out', /already out/.test(err) && writes.length === 2, err);

  // A Ping anyway into a busy session is not scored against the cache.
  appendLog(reply(T0 + 3 * MIN + 2000, 1_000, 90_000));
  status = 'idle';
  kw.tickKeepWarm(T0 + 4 * MIN);
  check('  and its "reply" is not scored — it belongs to the running turn',
    view().lastResult === null && !view().awaitingReply && view().active, JSON.stringify(view()));

  // Keys typed in the gap before Enter.
  let pending: (() => void) | null = null;
  world();
  kw.setKeepWarmDeps({
    terms: () => [TERM], status: () => status, fiveHourPct: () => null,
    write: (_id, data) => { writes.push(data); return true; },
    later: (fn) => { pending = fn; },
  });
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  const due = T0 + 47 * MIN;
  kw.tickKeepWarm(due);
  kw.noteInput('term-1', 'q', due + 50);
  (pending as unknown as () => void)();
  check('a key typed before Enter is pressed stops it instead of submitting both',
    writes.length === 1 && view().stopped?.reason === 'typed', JSON.stringify({ writes, v: view().stopped }));

  world();
  kw.setKeepWarmDeps({
    terms: () => [TERM], status: () => status, fiveHourPct: () => null,
    write: (_id, data) => { writes.push(data); return true; },
    later: (fn) => { pending = fn; },
  });
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.tickKeepWarm(due);
  status = 'busy';
  (pending as unknown as () => void)();
  check('a turn that starts before Enter gets no Enter', writes.length === 1 && view().stopped?.reason === 'no-reply',
    JSON.stringify({ writes, v: view().stopped }));

  // A reply is only settled once the turn is over.
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.tickKeepWarm(T0 + 47 * MIN);
  appendLog(ping(T0 + 47 * MIN), reply(T0 + 47 * MIN + 2000, 80_000, 100));
  status = 'busy';
  kw.tickKeepWarm(T0 + 48 * MIN);
  check('a reply is not settled while the turn is still running', view().awaitingReply);
  status = 'idle';
  kw.tickKeepWarm(T0 + 48 * MIN + 2000);
  check('  and is once it ends', view().lastResult === 'hit');

  // Changing settings is not vouching for the input box.
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  kw.noteInput('term-1', 'draft', T0 + 5 * MIN);
  kw.enableKeepWarm(SID, FILE, { ...OPTS, minutes: 480 }, T0 + 6 * MIN);
  check('re-posting settings while it runs keeps the draft guard', view().unsentSince === T0 + 5 * MIN);

  // A paste while the registry still says 'waiting' is typing.
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  status = 'waiting';
  kw.noteInput('term-1', '\x1b[200~a pasted draft\x1b[201~', T0 + 5 * MIN);
  kw.noteInput('term-1', 'h', T0 + 5 * MIN + 100);
  status = 'idle';
  check('text typed while the registry lags a closed dialog still counts', view().unsentSince === T0 + 5 * MIN + 100);
}

// ------------------------------------------------------------------ ending
{
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  termAlive = false;
  kw.tickKeepWarm(T0 + 3 * MIN);
  check('a closed terminal stops it', view().stopped?.reason === 'terminal-closed');

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, { ...OPTS, minutes: 30 }, T0 + 2 * MIN);
  kw.tickKeepWarm(T0 + 33 * MIN);
  check('it ends when its time is up', view().stopped?.reason === 'expired');

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, { ...OPTS, untilSend: true }, T0 + 2 * MIN);
  appendLog(ping(T0 + 5 * MIN), reply(T0 + 5 * MIN + 1000));
  kw.tickKeepWarm(T0 + 6 * MIN);
  check('"until I reply" is not ended by its own ping', view().active);
  appendLog(sent(T0 + 20 * MIN), reply(T0 + 21 * MIN));
  kw.tickKeepWarm(T0 + 22 * MIN);
  check('  but is by a message of yours', view().stopped?.reason === 'sent');

  kw.disableKeepWarm(SID);
  check('turning it off forgets it', kw.keepWarmView(SID) === null);
}

// ------------------------------------------------------- the ping's own turn
{
  const got: unknown[] = [];
  const on = (e: unknown) => got.push(e);
  resetCompletions();
  completionEvents.on('completed', on);
  const live = (s: LiveInfo['status']) =>
    new Map([[SID, { pid: 1, status: s, name: '', statusUpdatedAt: 0, startedAt: 0 } as LiveInfo]]);

  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  const at = T0 + 47 * MIN;
  tickCompletions(at - 1000, live('idle'));
  kw.tickKeepWarm(at);
  tickCompletions(at + 1000, live('busy'));
  tickCompletions(at + 4000, live('idle'));
  tickCompletions(at + 4000 + HOLD_MS, live('idle'));
  check('the ping\'s turn is not announced as a completion', got.length === 0, JSON.stringify(got));

  tickCompletions(at + 60_000, live('busy'));
  tickCompletions(at + 70_000, live('idle'));
  tickCompletions(at + 70_000 + HOLD_MS, live('idle'));
  check('  and the next real turn still is', got.length === 1, JSON.stringify(got));

  // A ping turn too quick for the 2s tick to see must not leave the flag set.
  got.length = 0;
  resetCompletions();
  world();
  writeLog([sent(T0), reply(T0 + MIN)]);
  kw.enableKeepWarm(SID, FILE, OPTS, T0 + 2 * MIN);
  tickCompletions(at - 1000, live('idle'));
  kw.tickKeepWarm(at);
  appendLog(ping(at), reply(at + 800, 80_000, 100));
  tickCompletions(at + 2000, live('idle'));
  kw.tickKeepWarm(at + 2000);
  tickCompletions(at + 10_000, live('busy'));
  tickCompletions(at + 20_000, live('idle'));
  tickCompletions(at + 20_000 + HOLD_MS, live('idle'));
  check('an unseen ping turn does not swallow the next real finish', got.length === 1, JSON.stringify(got));
  completionEvents.off('completed', on);
  resetCompletions();
}

{
  writeLog([
    { type: 'custom-title', customTitle: 'kept warm', timestamp: iso(T0) },
    sent(T0, 'the real question'),
    { type: 'last-prompt', lastPrompt: 'the real question' },
    reply(T0 + MIN),
    ping(T0 + 47 * MIN),
    { type: 'last-prompt', lastPrompt: kw.PING_TEXT },
    reply(T0 + 47 * MIN + 3000, 90_000, 200),
    { type: 'system', subtype: 'turn_duration', timestamp: iso(T0 + 47 * MIN + 3000) },
  ]);
  const s = (await scanAll()).find((x) => x.id === SID)!;
  check('a ping does not move the session\'s activity time', s.lastActivity === T0 + MIN, iso(s.lastActivity));
  check('  or become its last prompt', s.lastPrompt === 'the real question', s.lastPrompt);
  check('  or its searchable text', !s.searchText.includes('cache refresh'), s.searchText);
  check('  but its reply still reads the context size', s.contextTokens === 90_203, String(s.contextTokens));
}

kw.setKeepWarmDeps(null);
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
