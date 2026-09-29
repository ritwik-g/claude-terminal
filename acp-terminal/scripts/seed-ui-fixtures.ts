/**
 * Seeds an app dir with realistic sessions for UI work and screenshots:
 * every session state, several vendors, git and non-git folders, split agent
 * messages, tool calls with exit codes, a subagent, a plan and a long transcript.
 *
 *   ACP_APP_DIR=/tmp/acp-ui-demo npx tsx scripts/seed-ui-fixtures.ts
 *   ACP_APP_DIR=/tmp/acp-ui-demo PORT=7996 ACP_ENABLE_MOCK=1 npx tsx server/cli.ts
 *
 * The server resets transient states on start (a "working" session with no
 * live agent becomes "needs you"; pending approvals are cleared). To see those
 * live, start a Built-in Demo Agent session and send "please run a command".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AcpSession, ToolCallRecord, TurnMessage, TurnSegment } from '../server/types.js';

const appDir = process.env.ACP_APP_DIR;
if (!appDir) {
  console.error('Set ACP_APP_DIR to the app dir to seed (never your real ~/.acp-terminal).');
  process.exit(1);
}
if (path.resolve(appDir) === path.join(os.homedir(), '.acp-terminal')) {
  console.error('Refusing to seed the real ~/.acp-terminal.');
  process.exit(1);
}

const sessionsDir = path.join(appDir, 'sessions');
const workRoot = path.join(os.tmpdir(), 'acp-ui-fixture-repos');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

const now = Date.now();
const min = 60_000;
let seq = 0;
const id = (p: string) => `${p}-${(++seq).toString(36)}`;

function repo(name: string, git: boolean): string {
  const dir = path.join(workRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (git && !fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  }
  return dir;
}

function tool(p: Partial<ToolCallRecord> & { title: string }, at: number): ToolCallRecord {
  return { id: id('toolu'), status: 'completed', startedAt: at, completedAt: at + 2_000, ...p };
}

function agentTurn(parts: Array<string | ToolCallRecord | { thought: string }>, at: number, extra: Partial<TurnMessage> = {}): TurnMessage {
  const segments: TurnSegment[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let content = '';
  let thoughts = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      segments.push({ kind: 'text', id: id('seg'), text: part, messageId: id('msg') });
      content += (content ? '\n\n' : '') + part;
    } else if ('thought' in part) {
      segments.push({ kind: 'thought', id: id('seg'), text: part.thought });
      thoughts += part.thought;
    } else {
      toolCalls.push(part);
      if (!part.parentToolUseId) segments.push({ kind: 'tool', id: id('seg'), toolCallId: part.id });
    }
  }
  return { id: id('msg'), role: 'agent', content, thoughts, toolCalls, segments, timestamp: at, ...extra };
}

const userTurn = (text: string, at: number): TurnMessage => ({ id: id('msg'), role: 'user', content: text, timestamp: at });

function session(p: Partial<AcpSession> & Pick<AcpSession, 'title' | 'agentId' | 'agentName' | 'cwd' | 'turns'>): AcpSession {
  const last = p.turns[p.turns.length - 1];
  return {
    id: id('acp-fixture'),
    titleSource: 'user',
    startedAt: now - 3 * 60 * min,
    updatedAt: last?.timestamp ?? now,
    state: 'needs_you',
    score: 100,
    reasons: ['needs_you base (+100)'],
    lastPrompt: [...p.turns].reverse().find((t) => t.role === 'user')?.content || '',
    recap: [...p.turns].reverse().find((t) => t.role === 'agent')?.content?.slice(0, 160) || '',
    usage: { inputTokens: 48_200, outputTokens: 6_100, cachedTokens: 31_000, contextTokens: 52_400 },
    git: null,
    user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: false },
    pendingPermission: null,
    agentStopped: true,
    ...p,
  };
}

// 1. Rich Claude session: split messages, tools, a subagent and a plan.
const t1 = now - 25 * min;
const explore = tool(
  {
    title: 'Map every place that reads the session cookie',
    kind: 'think',
    toolName: 'Agent',
    isSubagent: true,
    subagentType: 'Explore',
    description: 'Map every place that reads the session cookie',
    input: { description: 'Map every place that reads the session cookie', subagent_type: 'Explore', prompt: 'Find every read of the session cookie under src/ and report file:line with a one-line note each.' },
    output:
      'Found 4 reads:\n- `src/middleware/auth.ts:42` parses the cookie on every request\n- `src/routes/login.ts:18` sets it\n- `src/routes/logout.ts:9` clears it\n- `src/ws/upgrade.ts:27` reads it without verifying the signature\n\nThe WebSocket upgrade path is the only unverified read.\nagentId: a1b2c3\n<usage>subagent_tokens: 18231\ntool_uses: 6\nduration_ms: 9410</usage>',
  },
  t1 + 20_000
);
const exploreChildren = [
  tool({ title: 'Grep', kind: 'search', toolName: 'Grep', input: { pattern: 'session_id' }, output: 'src/middleware/auth.ts\nsrc/routes/login.ts\nsrc/routes/logout.ts\nsrc/ws/upgrade.ts', parentToolUseId: explore.id }, t1 + 22_000),
  tool({ title: 'Read src/ws/upgrade.ts', kind: 'read', toolName: 'Read', input: { file_path: '/repo/src/ws/upgrade.ts' }, output: '27  const sid = parseCookie(req.headers.cookie).session_id;', parentToolUseId: explore.id }, t1 + 25_000),
];
const s1 = session({
  title: 'Harden auth middleware',
  agentId: 'claude',
  agentName: 'Claude Code (ACP)',
  model: 'sonnet',
  cwd: repo('api-server', true),
  git: { branch: 'fix/auth-cookie', uncommittedFiles: 3, unpushedCommits: 1 } as AcpSession['git'],
  user: { priority: 'p0', pinned: true, snoozedUntil: null, tags: [], cleanup: false },
  plan: [
    { content: 'Find every read of the session cookie', status: 'completed' },
    { content: 'Verify the signature on the WebSocket upgrade', status: 'completed' },
    { content: 'Add a regression test for unsigned cookies', status: 'in_progress' },
    { content: 'Update the security notes in the README', status: 'pending' },
  ],
  turns: [
    userTurn('The WebSocket upgrade accepts forged session cookies. Find every place we read the cookie and make sure each one verifies the signature. Add a test.', t1),
    agentTurn(
      [
        { thought: 'Start by finding all cookie reads; a subagent can map them while I read the middleware.' },
        "I'll map every read of the session cookie first, then fix the unverified ones.",
        tool({ title: 'Read src/middleware/auth.ts', kind: 'read', toolName: 'Read', input: { file_path: '/repo/src/middleware/auth.ts' }, output: '42  const sid = verify(parseCookie(req.headers.cookie).session_id);' }, t1 + 10_000),
        explore,
        ...exploreChildren,
        'The subagent found one unverified read, in `src/ws/upgrade.ts:27`. Fixing it to go through `verify()` like the HTTP middleware does.',
        tool({ title: 'Edit src/ws/upgrade.ts', kind: 'edit', toolName: 'Edit', input: { file_path: '/repo/src/ws/upgrade.ts', old_string: 'parseCookie(', new_string: 'verify(parseCookie(' } }, t1 + 40_000),
        tool({ title: 'npm test -- auth', kind: 'execute', toolName: 'Bash', description: 'Run the auth tests', input: { command: 'npm test -- auth' }, output: 'FAIL  test/ws.test.ts\n  ✕ rejects unsigned cookie (12 ms)\n\nTests: 1 failed, 23 passed', exitCode: 1 }, t1 + 50_000),
        'One test fails because it still expects the old behaviour. Updating the fixture to sign its cookie.',
        tool({ title: 'Edit test/ws.test.ts', kind: 'edit', toolName: 'Edit', input: { file_path: '/repo/test/ws.test.ts' } }, t1 + 60_000),
        tool({ title: 'npm test -- auth', kind: 'execute', toolName: 'Bash', description: 'Re-run the auth tests', input: { command: 'npm test -- auth' }, output: 'PASS  test/ws.test.ts\nPASS  test/auth.test.ts\n\nTests: 24 passed', exitCode: 0 }, t1 + 70_000),
        '## Done\n\n- `src/ws/upgrade.ts` now verifies the cookie signature, matching the HTTP path.\n- `test/ws.test.ts` covers an unsigned cookie being rejected.\n\n| Check | Result |\n| --- | --- |\n| Auth tests | 24 passed |\n| Lint | clean |\n\nNext I can add the README note on cookie signing. Want me to?',
      ],
      t1 + 5_000,
      { agentId: 'claude', agentName: 'Claude Code (ACP)', model: 'sonnet' }
    ),
  ],
});

// 2. Codex session, parked with a failed command.
const t2 = now - 2 * 60 * min;
const s2 = session({
  title: 'Fix flaky checkout e2e test',
  agentId: 'codex',
  agentName: 'Codex CLI (ACP)',
  model: '5.6-terra',
  cwd: repo('storefront', true),
  git: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 2 } as AcpSession['git'],
  state: 'parked',
  reasons: ['parked base (+30)', '2 unpushed commits (+20)'],
  turns: [
    userTurn('checkout.spec.ts fails about one run in five on CI. Find out why.', t2),
    agentTurn(
      [
        'Running the spec in a loop to reproduce.',
        tool({ title: 'for i in $(seq 20); do npx playwright test checkout; done', kind: 'execute', input: { command: 'for i in $(seq 20); do npx playwright test checkout; done' }, output: '17 passed, 3 failed\nError: locator.click: Timeout 5000ms exceeded (button "Pay")', exitCode: 1 }, t2 + 30_000),
        'The Pay button is clicked before the payment iframe finishes loading. I committed a wait on the iframe `load` event; 50 runs in a row now pass.',
      ],
      t2 + 10_000
    ),
  ],
});

// 3. Gemini session, idle, outside git.
const t3 = now - 26 * 60 * min;
const s3 = session({
  title: 'Draft release notes for 0.17',
  agentId: 'antigravity',
  agentName: 'Google Antigravity (ACP)',
  model: 'gemini-3.1-pro',
  cwd: repo('notes', false),
  state: 'quiet',
  reasons: ['quiet base (+10)'],
  turns: [
    userTurn('Summarize the merged PRs since 0.16 into release notes.', t3),
    agentTurn(['Here is a draft:\n\n### Added\n- LAN access is now opt-in\n- Subagent cards in the conversation\n\n### Fixed\n- Approval cards no longer get stuck after a cancel'], t3 + 20_000),
  ],
});

// 4. Snoozed Claude session with priority.
const t4 = now - 5 * 60 * min;
const s4 = session({
  title: 'Investigate memory growth in worker',
  agentId: 'claude',
  agentName: 'Claude Code (ACP)',
  model: 'opus',
  cwd: repo('worker', true),
  git: { branch: 'perf/heap', uncommittedFiles: 0, unpushedCommits: 0 } as AcpSession['git'],
  state: 'snoozed',
  user: { priority: 'p2', pinned: false, snoozedUntil: now + 45 * min, tags: [], cleanup: false },
  turns: [userTurn('Heap grows ~40MB/hour in the queue worker. Profile it.', t4), agentTurn(['Captured two heap snapshots an hour apart; retained size grows in `JobCache`. It never evicts finished jobs.'], t4 + 60_000)],
});

// 5. Demo agent session marked for cleanup.
const t5 = now - 3 * 24 * 60 * min;
const s5 = session({
  title: 'Try the demo agent',
  agentId: 'mock',
  agentName: 'Built-in ACP Demo Agent',
  model: 'mock-model-v1',
  cwd: repo('scratch', false),
  state: 'quiet',
  user: { priority: null, pinned: false, snoozedUntil: null, tags: [], cleanup: true },
  usage: { inputTokens: 1_870, outputTokens: 0, cachedTokens: 0, contextTokens: 1_870 },
  turns: [userTurn('hello', t5), agentTurn(['Hi! I am the built-in demo agent. Ask me to "run a command" to see an approval request.'], t5 + 2_000)],
});

// 6. A long transcript, to exercise windowing and scrolling.
const t6 = now - 8 * 60 * min;
const longTurns: TurnMessage[] = [];
for (let i = 0; i < 80; i++) {
  longTurns.push(userTurn(`Step ${i + 1}: continue with the next file.`, t6 + i * 60_000));
  longTurns.push(
    agentTurn(
      [
        tool({ title: `Read src/module-${i}.ts`, kind: 'read', toolName: 'Read', input: { file_path: `/repo/src/module-${i}.ts` }, output: 'export {}' }, t6 + i * 60_000 + 5_000),
        `Updated \`module-${i}.ts\`; moving on.`,
      ],
      t6 + i * 60_000 + 3_000
    )
  );
}
const s6 = session({
  title: 'Migrate modules to strict mode',
  agentId: 'claude',
  agentName: 'Claude Code (ACP)',
  model: 'haiku',
  cwd: repo('monorepo', true),
  git: { branch: 'chore/strict', uncommittedFiles: 12, unpushedCommits: 0 } as AcpSession['git'],
  turns: longTurns,
  usage: { inputTokens: 171_000, outputTokens: 22_000, cachedTokens: 120_000, contextTokens: 171_000 },
});

for (const s of [s1, s2, s3, s4, s5, s6]) {
  fs.writeFileSync(path.join(sessionsDir, `${s.id}.json`), JSON.stringify(s, null, 2), { mode: 0o600 });
}
console.log(`Seeded 6 sessions into ${sessionsDir} (repos under ${workRoot}).`);
