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

  write(S.review, [
    ...base(900_000),
    command('pr-review', 'https://github.com/Zipstack/unstract-cloud/pull/1703 keep it lite', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // A plugin-scoped review command, invoked with no PR to point at.
  write(S.reviewNoPr, [
    ...base(900_000),
    command('unstract:standard-review-lite', 'the current diff', 890_000),
    { type: 'assistant', message: { stop_reason: 'end_turn' }, cwd: WORK, timestamp: at(300_000) },
  ]);

  // Names a PR but is not a review; must not be marked as one.
  write(S.notReview, [
    ...base(900_000),
    command('compact', 'https://github.com/Zipstack/unstract-cloud/pull/999', 890_000),
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
    check('all synthetic sessions are scanned', payload.sessions.length === 6, `got ${payload.sessions.length}`);

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
      by(S.review)?.review?.pr?.repository === 'Zipstack/unstract-cloud',
      JSON.stringify(by(S.review)?.review?.pr));
    check('a plugin-scoped review command counts too',
      by(S.reviewNoPr)?.review?.command === 'unstract:standard-review-lite',
      JSON.stringify(by(S.reviewNoPr)?.review));
    check('  with no PR when none was named', by(S.reviewNoPr)?.review?.pr === null);
    check('a non-review command is not a review even when it names a PR',
      by(S.notReview)?.review === null, JSON.stringify(by(S.notReview)?.review));
    check('a session with no command at all is not a review', by(S.none)?.review === null);
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
