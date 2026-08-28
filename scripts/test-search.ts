/**
 * Search matcher checks, run against the real session set on a running server:
 *   npm run test:search
 *
 * Synthetic ids would prove nothing here. The thing worth checking is that
 * every id in your actual ~/.claude/projects tree is reachable by prefix and
 * that no ordinary word starts hitting sessions by id — both are properties of
 * the real distribution, not of a fixture.
 */
import { matches, shortId } from '../web/src/util';
import type { Session } from '../server/types';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.CT_BASE ?? 'http://127.0.0.1:7777';

/**
 * Every /api call is token-gated, so this harness reads the token the server
 * wrote and attaches it. Shadowing `fetch` keeps the token out of the call
 * sites, which are about behaviour under test, not authentication.
 */
const TOKEN_FILE = path.join(os.homedir(), '.claude-terminal', 'token');
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
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The free-text half of the matcher, so we can tell an id hit from a text hit. */
function textHay(s: Session): string {
  return [
    s.title, s.lastPrompt, s.recap, s.branch, s.cwd,
    s.user.tags.join(' '), s.user.note,
    s.pr ? `pr #${s.pr.number} ${s.pr.repository}` : '',
    s.user.priority ?? '', s.shape,
  ].join(' ').toLowerCase();
}

const main = async () => {
  console.log(`search: ${BASE}\n`);
  const res = await fetch(`${BASE}/api/sessions`);
  const sessions: Session[] = (await res.json()).sessions;
  if (sessions.length < 3) {
    console.log('need at least 3 sessions to be meaningful — is the server scanning?');
    process.exit(1);
  }
  const count = (q: string) => sessions.filter((s) => matches(s, q)).length;
  console.log(`  (${sessions.length} sessions)\n`);

  // Every id must be findable, by every form you might have it in.
  for (const s of [sessions[0], sessions[sessions.length >> 1], sessions[sessions.length - 1]]) {
    const tag = shortId(s.id);
    check(`${tag}: full id finds exactly it`, count(s.id) === 1);
    check(`${tag}: 8-char prefix finds exactly it`, count(tag) === 1);
    check(`${tag}: uppercase id finds exactly it`, count(s.id.toUpperCase()) === 1);
    check(`${tag}: transcript path finds exactly it`, count(s.file) === 1);
    check(`${tag}: bare <id>.jsonl finds exactly it`, count(`${s.id}.jsonl`) === 1);
  }

  // The 8 chars shown in the list are only useful if they are unambiguous.
  const seen = new Map<string, number>();
  for (const s of sessions) seen.set(shortId(s.id), (seen.get(shortId(s.id)) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1);
  check('8-char prefixes are unique across every session', dupes.length === 0, JSON.stringify(dupes));

  // Ids are hex, so the risk of matching them is that ordinary typing starts
  // hitting them. Anything under 3 chars must never match an id at all...
  for (const t of ['a', 'ab', 'f1', '0a', 'de']) {
    const byIdOnly = sessions.filter((s) => matches(s, t) && !textHay(s).includes(t));
    check(`"${t}" matches nothing by id alone`, byIdOnly.length === 0);
  }
  // ...and real words that happen to be valid hex must not gain hits either.
  const hexWords = ['add', 'bed', 'dad', 'fed', 'ace', 'face', 'cafe', 'deed', 'beef', 'fade', 'feed', 'cab', 'bad'];
  let gained = 0;
  for (const w of hexWords) {
    gained += count(w) - sessions.filter((s) => textHay(s).includes(w)).length;
  }
  check(`hex-like words gain no id hits (${hexWords.length} words)`, gained === 0, `+${gained}`);

  // A prefix must still reach every session that genuinely starts with it.
  const p = shortId(sessions[0].id).slice(0, 4);
  const truly = sessions.filter((s) => s.id.toLowerCase().startsWith(p)).length;
  check(`4-char prefix "${p}" reaches all ${truly} of its sessions`, count(p) >= truly);

  // Multi-term search still ANDs: an id plus a term it cannot satisfy is empty.
  check('id AND an impossible term yields nothing', count(`${sessions[0].id} zzzznope`) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
