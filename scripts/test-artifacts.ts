/**
 * Artifacts and review detection:  npm run test:artifacts
 *
 * Self-contained — builds a throwaway HOME with synthetic transcripts and runs
 * a server against it, so nothing here reads or writes your real sessions.
 *
 * The case that matters most is `mid-file artifacts`. scan.ts samples the first
 * 256KB and the last 1MB of a transcript, which is right for titles and
 * pr-links because Claude Code re-emits those — but a frame-link is written
 * once, when you publish, and never again. Against the real corpus 51 of the 71
 * artifacts in transcripts bigger than that window sit between the two sampled
 * ranges. A version of this feature built on the shared scanner passes every
 * other check here and silently loses three quarters of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-artifacts-'));
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const PORT = 7793;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Every /api call is token-gated, so this harness reads the token the server
 * wrote and attaches it. Shadowing `fetch` keeps the token out of the call
 * sites, which are about behaviour under test, not authentication.
 */
const TOKEN_FILE = path.join(FAKE_HOME, '.claude-terminal', 'token');
function ctToken(): string {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-ct-token': ctToken() },
  });


let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const S = {
  many: '11111111-1111-4111-8111-111111111111',
  big: '22222222-2222-4222-8222-222222222222',
  none: '33333333-3333-4333-8333-333333333333',
  review: '44444444-4444-4444-8444-444444444444',
  reviewNoPr: '55555555-5555-4555-8555-555555555555',
  notReview: '66666666-6666-4666-8666-666666666666',
  remediation: '77777777-7777-4777-8777-777777777777',
  reviewLatePr: '88888888-8888-4888-8888-888888888888',
  prInToolOutput: '99999999-9999-4999-8999-999999999999',
  multiPr: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  branchedFromReview: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  branchOwnReview: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const PROJECTS = path.join(FAKE_HOME, '.claude', 'projects', '-ct-artifacts-work');

function write(id: string, lines: unknown[]): void {
  fs.writeFileSync(
    path.join(PROJECTS, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

const now = Date.now();
const at = (offMs: number) => new Date(now - offMs).toISOString();

/** A user turn carrying a slash command, the way Claude Code records one. */
function command(name: string, args: string, off: number) {
  return {
    type: 'user',
    cwd: WORK,
    timestamp: at(off),
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: `<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
      }],
    },
  };
}

function frame(url: string, title: string, off: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'frame-link',
    sessionId: 'x',
    path: `/tmp/${title}.html`,
    frameUrl: url,
    title,
    timestamp: at(off),
    ...extra,
  };
}

function scaffold(): void {
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });

  const base = (off: number) => [
    { type: 'custom-title', customTitle: 'x', cwd: WORK, timestamp: at(off) },
  ];

  // Several artifacts, one of them republished three times, plus the
  // count-only records that carry no URL and must not become entries.
  write(S.many, [
    ...base(900_000),
    { type: 'custom-title', customTitle: 'many artifacts', cwd: WORK, timestamp: at(890_000) },
    frame('https://claude.ai/code/artifact/aaa', 'First Draft', 800_000),
    { type: 'frame-link', sessionId: 'x', artifactCount: 1, timestamp: at(790_000) },
    frame('https://claude.ai/code/artifact/bbb', 'Second Thing', 700_000),
    frame('https://claude.ai/code/artifact/aaa', 'Renamed Draft', 600_000),
    frame('https://claude.ai/code/artifact/aaa', 'Final Name', 500_000),
    { type: 'frame-link', sessionId: 'x', artifactCount: 3, timestamp: at(450_000) },
    // No title at all: still openable, so it must still be listed.
    frame('https://claude.ai/code/artifact/ccc', '', 400_000, { title: undefined }),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A transcript deliberately larger than HEAD_BYTES + TAIL_BYTES (1.25MB) with
  // its only artifact stranded in the middle, where the sampled scanner cannot
  // see it. The padding sits on both sides of the frame-link.
  const pad = (n: number, off: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'assistant',
      cwd: WORK,
      timestamp: at(off - i),
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(900) }] },
    }));
  write(S.big, [
    ...base(900_000),
    { type: 'custom-title', customTitle: 'big transcript', cwd: WORK, timestamp: at(890_000) },
    ...pad(900, 880_000),
    frame('https://claude.ai/code/artifact/mid', 'Stranded Mid-File', 500_000),
    ...pad(900, 400_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(1000) },
  ]);

  write(S.none, [
    ...base(900_000),
    { type: 'custom-title', customTitle: 'no artifacts', cwd: WORK, timestamp: at(890_000) },
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A review covering three PRs at once — comparing them, or working a stack.
  // Showing only the first hid what the session was actually about.
  write(S.multiPr, [
    ...base(900_000),
    command(
      'pr-review',
      'compare https://github.com/acme/widgets/pull/11 with ' +
      'https://github.com/acme/widgets/pull/22 and https://github.com/acme/toolkit/pull/33',
      890_000,
    ),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // `/branch` copies the parent's conversation into the new transcript and
  // tags every inherited record with `forkedFrom`. The parent's /pr-review
  // therefore sits at line 0 of a branch that is reviewing nothing — which is
  // exactly how a branched session used to inherit its parent's review label.
  write(S.branchedFromReview, [
    { ...command('pr-review', 'https://github.com/acme/widgets/pull/4242', 900_000),
      forkedFrom: { sessionId: S.review, messageUuid: 'u-1' } },
    { type: 'user', cwd: WORK, timestamp: at(880_000),
      forkedFrom: { sessionId: S.review, messageUuid: 'u-2' },
      message: { role: 'user', content: [{ type: 'text', text: 'earlier parent turn' }] } },
    { type: 'user', cwd: WORK, timestamp: at(500_000),
      message: { role: 'user', content: [{ type: 'text', text: 'now do something unrelated' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // The mirror case: a branch that runs its OWN review command must still be
  // marked, or the fork guard would have thrown out the real signal too.
  write(S.branchOwnReview, [
    { ...command('pr-review', 'https://github.com/acme/widgets/pull/1', 900_000),
      forkedFrom: { sessionId: S.review, messageUuid: 'u-1' } },
    command('pr-review', 'https://github.com/acme/toolkit/pull/777', 500_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  write(S.review, [
    ...base(900_000),
    command('pr-review', 'https://github.com/acme/widgets/pull/1703 keep it lite', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A plugin-scoped review command, invoked with no PR to point at.
  write(S.reviewNoPr, [
    ...base(900_000),
    command('acme:standard-review-lite', 'the current diff', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A remediation skill is a review loop whose name contains no "review".
  write(S.remediation, [
    ...base(900_000),
    command('acme:max-remediation', 'https://github.com/acme/toolkit/pull/2135', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // The PR was given in prose first, and the review invoked bare afterwards.
  write(S.reviewLatePr, [
    ...base(900_000),
    {
      type: 'user',
      cwd: WORK,
      timestamp: at(880_000),
      message: { role: 'user', content: [{ type: 'text', text: 'look at https://github.com/acme/widgets/pull/1706 with me' }] },
    },
    command('pr-review', 'keep it lite', 870_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A PR URL that only ever appears in TOOL OUTPUT must not be adopted: a bare
  // review here names no PR, and inventing one is worse than showing none.
  //
  // The message MIXES a tool_result with a text part, which is the only shape
  // that actually tests the guard: rawTextOf() already ignores a lone
  // tool_result, so a pure-tool_result fixture passes whether the guard is
  // there or not — it did, until deleting the guard failed to break it.
  write(S.prInToolOutput, [
    ...base(900_000),
    command('pr-review', 'the current diff', 890_000),
    {
      type: 'user',
      cwd: WORK,
      timestamp: at(880_000),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: 'gh output: https://github.com/acme/toolkit/pull/9999' },
        ],
      },
    },
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // Names a PR but is not a review; must not be marked as one.
  write(S.notReview, [
    ...base(900_000),
    command('compact', 'https://github.com/acme/widgets/pull/999', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);
}

async function waitForUp(proc: ChildProcess, ms = 40_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode})`);
    try {
      if ((await fetch(`${BASE}/api/sessions`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

const main = async () => {
  console.log(`artifacts: ${ROOT}\n`);
  scaffold();

  const bigSize = fs.statSync(path.join(PROJECTS, `${S.big}.jsonl`)).size;
  check('the big transcript really exceeds the sampled window',
    bigSize > 256 * 1024 + 1024 * 1024, `${Math.round(bigSize / 1024)}KB`);

  const proc = spawn('npx', ['tsx', 'server/cli.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: FAKE_HOME, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForUp(proc);
    const payload: any = await (await fetch(`${BASE}/api/sessions?force=1`)).json();
    check('all synthetic sessions are scanned', payload.sessions.length === 12, `got ${payload.sessions.length}`);

    const get = async (id: string) =>
      (await (await fetch(`${BASE}/api/sessions/${id}/artifacts`)).json()).artifacts;

    // ---- artifacts ----
    const many = await get(S.many);
    check('distinct artifacts are listed', many.length === 3, JSON.stringify(many.map((a: any) => a.title)));
    check('count-only frame-links are not artifacts',
      !many.some((a: any) => !a.url), JSON.stringify(many));

    const aaa = many.find((a: any) => a.url.endsWith('/aaa'));
    check('a republished artifact collapses to one entry', !!aaa);
    check('its latest title wins', aaa?.title === 'Final Name', aaa?.title);
    check('its revisions are counted', aaa?.revisions === 3, String(aaa?.revisions));
    check('a once-published artifact reports one revision',
      many.find((a: any) => a.url.endsWith('/bbb'))?.revisions === 1);
    check('an untitled artifact still gets a label',
      !!many.find((a: any) => a.url.endsWith('/ccc'))?.title);
    check('newest first',
      many[0].url.endsWith('/ccc'), JSON.stringify(many.map((a: any) => a.url)));

    // The one this whole module exists for.
    const big = await get(S.big);
    check('an artifact stranded mid-file is still found', big.length === 1, JSON.stringify(big));
    check('  and it is the right one', big[0]?.title === 'Stranded Mid-File', big[0]?.title);

    check('a session with no artifacts returns none', (await get(S.none)).length === 0);

    const unknown = await fetch(`${BASE}/api/sessions/not-a-session/artifacts`);
    check('an unknown session is a 404, not a crash', unknown.status === 404, String(unknown.status));
    const traversal = await fetch(`${BASE}/api/sessions/${encodeURIComponent('../../etc/passwd')}/artifacts`);
    check('a traversal id is refused', traversal.status === 404, String(traversal.status));

    // ---- review detection ----
    const by = (id: string) => payload.sessions.find((s: any) => s.id === id);
    check('a /pr-review session is marked as a review', by(S.review)?.review?.command === 'pr-review',
      JSON.stringify(by(S.review)?.review));
    check('  and the PR it names is extracted',
      by(S.review)?.review?.pr?.number === 1703 &&
      by(S.review)?.review?.pr?.repository === 'acme/widgets',
      JSON.stringify(by(S.review)?.review?.pr));
    check('a plugin-scoped review command counts too',
      by(S.reviewNoPr)?.review?.command === 'acme:standard-review-lite',
      JSON.stringify(by(S.reviewNoPr)?.review));
    check('  with no PR when none was named', by(S.reviewNoPr)?.review?.pr === null);
    check('a non-review command is not a review even when it names a PR',
      by(S.notReview)?.review === null, JSON.stringify(by(S.notReview)?.review));
    check('a session with no command at all is not a review', by(S.none)?.review === null);
    check('a remediation skill counts as a review, despite its name',
      by(S.remediation)?.review?.command === 'acme:max-remediation',
      JSON.stringify(by(S.remediation)?.review));
    check('  and its PR is read the same way', by(S.remediation)?.review?.pr?.number === 2135);
    check('a bare review falls back to the PR the person typed earlier',
      by(S.reviewLatePr)?.review?.pr?.number === 1706,
      JSON.stringify(by(S.reviewLatePr)?.review));
    check('a PR seen only in tool output is NOT adopted',
      by(S.prInToolOutput)?.review?.pr === null,
      JSON.stringify(by(S.prInToolOutput)?.review));
    check('  but that session is still marked a review',
      by(S.prInToolOutput)?.review?.command === 'pr-review');

    // ---- several PRs in one review ----
    check('a review naming three PRs keeps all three',
      by(S.multiPr)?.review?.prs?.length === 3,
      JSON.stringify(by(S.multiPr)?.review?.prs?.map((p: any) => p.number)));
    check('  in the order they were named',
      JSON.stringify(by(S.multiPr)?.review?.prs?.map((p: any) => p.number)) === '[11,22,33]',
      JSON.stringify(by(S.multiPr)?.review?.prs?.map((p: any) => p.number)));
    check('  across different repositories',
      by(S.multiPr)?.review?.prs?.[2]?.repository === 'acme/toolkit');
    check('  and `pr` still names the first, for readers that want just one',
      by(S.multiPr)?.review?.pr?.number === 11);
    check('a single-PR review still reports exactly one',
      by(S.review)?.review?.prs?.length === 1, JSON.stringify(by(S.review)?.review?.prs));

    // ---- a branch does not inherit its parent's review ----
    check('a session branched off a review is NOT itself a review',
      by(S.branchedFromReview)?.review === null,
      JSON.stringify(by(S.branchedFromReview)?.review));
    check('  so it does not claim the parent\'s PR either',
      by(S.branchedFromReview)?.shape !== 'review',
      String(by(S.branchedFromReview)?.shape));
    check('a branch that runs its OWN review command is still a review',
      by(S.branchOwnReview)?.review?.command === 'pr-review',
      JSON.stringify(by(S.branchOwnReview)?.review));
    check('  and takes the PR IT named, not the inherited one',
      by(S.branchOwnReview)?.review?.pr?.number === 777,
      JSON.stringify(by(S.branchOwnReview)?.review?.pr));

    // ---- review is a shape you can filter by ----
    check('a review session is typed as a review',
      by(S.review)?.shape === 'review', String(by(S.review)?.shape));
    check('  overriding the span-derived shape',
      by(S.remediation)?.shape === 'review', String(by(S.remediation)?.shape));
    check('a non-review keeps its span-derived shape',
      by(S.none)?.shape !== 'review', String(by(S.none)?.shape));

    // ---- searching the messages themselves ----
    const search = async (q: string) =>
      (await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`)).json()).ids as string[];
    check('a phrase only ever said in a message is findable',
      (await search('something unrelated')).includes(S.branchedFromReview),
      JSON.stringify(await search('something unrelated')));
    check('  and does not match sessions that never said it',
      !(await search('something unrelated')).includes(S.none));
    check('every term must match, not just one',
      (await search('unrelated nonexistentword')).length === 0);
    check('a one-character query is refused rather than matching everything',
      (await search('a')).length === 0);
    check('message search does not leak into the payload',
      by(S.review) !== undefined && !('searchText' in (by(S.review) as any)),
      JSON.stringify(Object.keys(by(S.review) ?? {})));

    check('review is never written into the tags a human owns',
      by(S.review)?.user.tags.length === 0, JSON.stringify(by(S.review)?.user.tags));
  } finally {
    proc.kill('SIGTERM');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
};

main()
  .then((f) => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error(e); console.error(`left ${ROOT} for inspection`); process.exit(1); });
