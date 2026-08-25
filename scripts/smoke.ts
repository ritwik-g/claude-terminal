/**
 * Black-box smoke test against a running server.
 *
 * Deliberately never spawns a real Claude session: every /api/terms case here
 * is one that must be REJECTED before reaching node-pty. Run it after any
 * change to the server:  npm run smoke
 */
const BASE = process.env.CT_BASE ?? 'http://127.0.0.1:7777';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function statusOf(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(`${BASE}${path}`, init);
  return res.status;
}

function json(body: unknown): RequestInit {
  return { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const main = async () => {
  console.log(`smoke: ${BASE}\n`);

  // ---- reachability + payload shape ----
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('health responds', health?.ok === true);

  const payload = await fetch(`${BASE}/api/sessions`).then((r) => r.json());
  const sessions: any[] = payload.sessions ?? [];
  check('sessions returned', sessions.length > 0, `got ${sessions.length}`);

  // Bucket counts must agree with the array they summarise.
  const now = Date.now();
  const recount: Record<string, number> = { attention: 0, working: 0, parked: 0, quiet: 0, snoozed: 0, archived: 0 };
  for (const s of sessions) {
    if (s.user.archived) { recount.archived++; continue; }
    if (s.user.snoozedUntil && s.user.snoozedUntil > now) { recount.snoozed++; continue; }
    if (s.state === 'needs_you' || s.state === 'crashed') recount.attention++;
    else if (s.state === 'working') recount.working++;
    else if (s.state === 'parked') recount.parked++;
    else recount.quiet++;
  }
  check('counts match sessions', JSON.stringify(recount) === JSON.stringify(payload.counts),
    `${JSON.stringify(payload.counts)} vs ${JSON.stringify(recount)}`);
  check('counts sum to total', Object.values(payload.counts as Record<string, number>).reduce((a, b) => a + b, 0) === sessions.length);

  check('no empty titles', sessions.every((s) => s.title?.length > 0));
  check('no future activity', sessions.every((s) => s.lastActivity <= Date.now() + 60_000));
  check('all cwds absolute', sessions.every((s) => s.cwd.startsWith('/')));
  check('every session has a shape', sessions.every((s) => ['errand', 'task', 'thread'].includes(s.shape)));
  check('sorted by score desc', sessions.every((s, i) => i === 0 || sessions[i - 1].score >= s.score));
  check('no internal cache fields leak', sessions.every((s) => !('_mtimeMs' in s) && !('_size' in s)));
  check('live sessions are never quiet', sessions.every((s) => !s.live || s.state !== 'quiet'));

  // Regression guard: an age-based staleness rule on statusUpdatedAt dropped
  // live-but-idle sessions — precisely the ones waiting on the user. If the
  // registry has running sessions, some must show up as live here.
  const registryPids = sessions.filter((s) => s.live).length;
  check('live sessions are detected', registryPids > 0,
    `${registryPids} live — if Claude Code is running, this must be > 0`);
  check('idle live sessions rank as needs_you',
    sessions.filter((s) => s.live?.status === 'idle').every((s) => s.state === 'needs_you'));

  const id: string = sessions[0].id;

  // ---- state validation: reject rather than coerce ----
  check('unknown session id -> 404', await statusOf(`/api/sessions/not-a-real-id/state`, json({ tags: ['x'] })) === 404);
  check('__proto__ id -> 400', await statusOf(`/api/sessions/__proto__/state`, json({ note: 'x' })) === 400);
  check('traversal id -> 400', await statusOf(`/api/sessions/..%2F..%2Fetc%2Fpasswd/state`, json({ tags: ['x'] })) === 400);
  check('pinned as string -> 400', await statusOf(`/api/sessions/${id}/state`, json({ pinned: 'false' })) === 400);
  check('non-string tag -> 400', await statusOf(`/api/sessions/${id}/state`, json({ tags: [null] })) === 400);
  check('overlong tag -> 400', await statusOf(`/api/sessions/${id}/state`, json({ tags: ['a'.repeat(60)] })) === 400);
  check('snoozedUntil 0 -> 400', await statusOf(`/api/sessions/${id}/state`, json({ snoozedUntil: 0 })) === 400);
  check('bad priority -> 400', await statusOf(`/api/sessions/${id}/state`, json({ priority: 'p9' })) === 400);

  // Express 4 drops async rejections: a throwing PATCH handler used to hang
  // the socket open forever with no response.
  const hung = await Promise.race([
    fetch(`${BASE}/api/sessions/${id}/state`, json({ tags: 'not-an-array' })).then(() => 'responded'),
    new Promise((r) => setTimeout(() => r('HUNG'), 4000)),
  ]);
  check('bad body responds rather than hanging', hung === 'responded', String(hung));

  // ---- origin / host guard ----
  check('cross-origin -> 403',
    await statusOf('/api/sessions', { headers: { Origin: 'https://evil.example' } }) === 403);
  check('same-origin -> 200',
    await statusOf('/api/sessions', { headers: { Origin: BASE } }) === 200);
  check('bare IPv6 loopback Host allowed',
    await statusOf('/api/health', { headers: { Host: '[::1]:7777' } }) !== 403);

  // ---- terminal creation: only the rejected cases ----
  const post = (body: unknown): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  check('term traversal id -> 400', await statusOf('/api/terms', post({ id: '../escape', cwd: '/tmp' })) === 400);
  check('term missing cwd -> 400', await statusOf('/api/terms', post({ id: 'smoke1' })) === 400);
  check('term relative cwd -> 400', await statusOf('/api/terms', post({ id: 'smoke2', cwd: 'rel/path' })) === 400);
  check('term file cwd -> 400', await statusOf('/api/terms', post({ id: 'smoke3', cwd: '/etc/hosts' })) === 400);
  check('term missing cwd dir -> 400', await statusOf('/api/terms', post({ id: 'smoke4', cwd: '/no/such/dir/here' })) === 400);

  const terms = await fetch(`${BASE}/api/terms`).then((r) => r.json());
  // Exited terminals linger for a 10-minute reap grace window, so assert on
  // RUNNING ones — otherwise this cries wolf after any normal terminal use.
  const running = (terms.terms ?? []).filter((t: any) => !t.exited);
  check('no terminal was spawned', running.length === 0, `${running.length} running`);

  // ---- round-trip: tag on, tag off, row pruned ----
  const rt = await fetch(`${BASE}/api/sessions/${id}/state`, json({ tags: ['  SMOKE-Tag '] })).then((r) => r.json());
  check('tag normalised', rt.user?.tags?.[0] === 'smoke-tag', JSON.stringify(rt.user?.tags));
  const after = await fetch(`${BASE}/api/sessions?force=1`).then((r) => r.json());
  check('tag visible on the session', after.sessions.find((s: any) => s.id === id)?.user.tags.includes('smoke-tag'));
  check('tag in global tag list', (after.tags ?? []).includes('smoke-tag'));
  await fetch(`${BASE}/api/sessions/${id}/state`, json({ tags: [] }));
  const cleared = await fetch(`${BASE}/api/sessions?force=1`).then((r) => r.json());
  check('tag removed', !(cleared.tags ?? []).includes('smoke-tag'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error('smoke run failed:', err);
  process.exit(1);
});
