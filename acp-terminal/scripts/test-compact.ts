/**
 * Context compaction: the history formatter and handoff, the "Compact when finished"
 * decision, and the handoff path end to end against the built-in mock agent (which has
 * no compact command, so it takes the fallback). No real agent is started.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const testAppDir = path.join(os.tmpdir(), `acp-compact-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.ACP_APP_DIR = testAppDir;

const { formatSessionHistory, sessionManager } = await import('../server/acp/session-mgr.js');
const { autoCompactDecision, latestCompaction, parseAutoCompact, readAutoCompactDefault, HANDOFF_SUMMARY_PROMPT } = await import('../server/compaction.js');
const { parseCompactionUpdate } = await import('../server/acp/client-host.js');
const { store } = await import('../server/store.js');
const { rankSession } = await import('../server/rank.js');
type TurnMessage = import('../server/types.js').TurnMessage;

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      console.log(`  ok  ${name}`);
    },
    (err) => {
      console.error(`  FAIL ${name}`);
      throw err;
    }
  );
}

const user = (id: string, content: string): TurnMessage => ({ id, role: 'user', content, timestamp: 1 });
const agent = (id: string, content: string): TurnMessage => ({ id, role: 'agent', content, timestamp: 1 });
const card = (id: string, summary?: string, status: 'completed' | 'failed' = 'completed'): TurnMessage => ({
  id,
  role: 'system',
  content: 'Context compacted',
  timestamp: 1,
  compaction: { status, method: 'handoff', trigger: 'manual', startedAt: 1, summary },
});
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

console.log('Formatter and handoff');

await test('a compaction summary is included, once, with only the turns after it', () => {
  const turns = [user('u1', 'OLD-QUESTION'), agent('a1', 'OLD-ANSWER'), card('c1', 'SUMMARY-ONE'), user('u2', 'NEW-QUESTION'), agent('a2', 'NEW-ANSWER')];
  const out = formatSessionHistory(turns);
  assert.equal(count(out, 'SUMMARY-ONE'), 1);
  assert.ok(out.includes('NEW-QUESTION') && out.includes('NEW-ANSWER'));
  assert.ok(!out.includes('OLD-QUESTION') && !out.includes('OLD-ANSWER'), 'turns before the summary must not be repeated');
  assert.ok(out.indexOf('SUMMARY-ONE') < out.indexOf('NEW-QUESTION'), 'summary comes first');
});

await test('a summary alone (no turns since) is still handed off', () => {
  const out = formatSessionHistory([user('u1', 'Q'), agent('a1', 'A'), card('c1', 'ONLY-SUMMARY')]);
  assert.ok(out.includes('ONLY-SUMMARY'));
});

await test('only the latest of several summaries is used', () => {
  const turns = [user('u1', 'Q1'), card('c1', 'FIRST-SUMMARY'), user('u2', 'Q2'), card('c2', 'SECOND-SUMMARY'), user('u3', 'Q3')];
  const out = formatSessionHistory(turns);
  assert.equal(count(out, 'SECOND-SUMMARY'), 1);
  assert.equal(count(out, 'FIRST-SUMMARY'), 0);
  assert.ok(!out.includes('Q2'));
});

await test('a compaction without a summary does not hide the turns before it', () => {
  const turns = [user('u1', 'KEEP-ME'), agent('a1', 'A'), card('c1', undefined), user('u2', 'LATER')];
  const out = formatSessionHistory(turns, { maxTurns: 10 });
  assert.ok(out.includes('KEEP-ME') && out.includes('LATER'));
  assert.equal(latestCompaction(turns), null);
});

await test('a failed compaction is not a checkpoint', () => {
  const turns = [user('u1', 'KEEP-ME'), card('c1', 'PARTIAL', 'failed'), user('u2', 'LATER')];
  assert.equal(latestCompaction(turns), null);
  assert.ok(!formatSessionHistory(turns).includes('PARTIAL'));
});

await test('the old local-only compaction turn (role system) is no longer dropped', () => {
  const legacy: TurnMessage = { id: 'compact-123', role: 'system', content: 'LEGACY-NOTE', timestamp: 1 };
  const out = formatSessionHistory([legacy, user('u2', 'AFTER')]);
  assert.ok(out.includes('LEGACY-NOTE') && out.includes('AFTER'));
  // Other system events (switches, stops) are still left out
  const other: TurnMessage = { id: 'sys-1', role: 'system', content: 'Switched model', timestamp: 1 };
  assert.ok(!formatSessionHistory([other, user('u', 'x')]).includes('Switched model'));
});

await test('no turns and no summary gives nothing to hand off', () => {
  assert.equal(formatSessionHistory([]), '');
});

console.log('Compact when finished');

const base = {
  setting: { enabled: true, thresholdPercent: 50 },
  stopReason: 'end_turn',
  queuedCount: 0,
  backgroundRunning: false,
  pendingPermission: false,
  contextTokens: 120_000,
  contextWindow: 200_000,
};

await test('compacts after a clean turn over the threshold', () => {
  assert.equal(autoCompactDecision(base).compact, true);
  assert.equal(autoCompactDecision({ ...base, contextTokens: 100_000 }).compact, true, 'exactly at the threshold counts');
});
await test('not under the threshold', () => {
  assert.equal(autoCompactDecision({ ...base, contextTokens: 99_000 }).compact, false);
  assert.equal(autoCompactDecision({ ...base, setting: { enabled: true, thresholdPercent: 70 } }).compact, false);
});
await test('not while queued messages remain', () => {
  assert.equal(autoCompactDecision({ ...base, queuedCount: 1 }).compact, false);
});
await test('not after a cancelled, failed or refused turn', () => {
  for (const stopReason of ['cancelled', 'refusal', 'max_tokens', undefined]) {
    assert.equal(autoCompactDecision({ ...base, stopReason }).compact, false, String(stopReason));
  }
});
await test('not while waiting for approval or with background work running', () => {
  assert.equal(autoCompactDecision({ ...base, pendingPermission: true }).compact, false);
  assert.equal(autoCompactDecision({ ...base, backgroundRunning: true }).compact, false);
});
await test('only background work asks to be decided again once it settles', () => {
  assert.equal(autoCompactDecision({ ...base, backgroundRunning: true }).waitForBackground, true);
  assert.equal(autoCompactDecision({ ...base, backgroundRunning: true, queuedCount: 1 }).waitForBackground, undefined);
  assert.equal(autoCompactDecision({ ...base, backgroundRunning: true, stopReason: 'cancelled' }).waitForBackground, undefined);
  assert.equal(autoCompactDecision(base).waitForBackground, undefined);
});
await test('not when off, or when context use is unknown', () => {
  assert.equal(autoCompactDecision({ ...base, setting: { enabled: false, thresholdPercent: 50 } }).compact, false);
  assert.equal(autoCompactDecision({ ...base, setting: undefined }).compact, false);
  assert.equal(autoCompactDecision({ ...base, contextTokens: 0 }).compact, false);
});
await test('the reported window is used, e.g. a 1M window at 120k is under 50%', () => {
  assert.equal(autoCompactDecision({ ...base, contextWindow: 1_000_000 }).compact, false);
});
await test('API input is validated', () => {
  assert.deepEqual(parseAutoCompact({ enabled: true, thresholdPercent: 30 }), { enabled: true, thresholdPercent: 30 });
  assert.deepEqual(parseAutoCompact({ enabled: false }), { enabled: false, thresholdPercent: 50 });
  assert.equal(parseAutoCompact({ enabled: 'yes' }), null);
  assert.equal(parseAutoCompact({ enabled: true, thresholdPercent: 150 }), null);
});
await test('the handoff prompt asks for the fixed sections', () => {
  for (const h of ['Goal', 'Decisions', 'Files changed', 'Current state', 'Next steps']) assert.ok(HANDOFF_SUMMARY_PROMPT.includes(`## ${h}`), h);
});

console.log('Compaction updates');

await test('compaction_update and summary chunks decode, with token counts from the meta', () => {
  const done = parseCompactionUpdate({
    sessionUpdate: 'compaction_update',
    compactionId: 'c-1',
    status: 'completed',
    summary: [{ type: 'text', text: 'All of it' }],
    _meta: { contextCompaction: { version: 1, trigger: 'manual', preTokens: 84_000, postTokens: 9_000 } },
  });
  assert.deepEqual(done, { compactionId: 'c-1', status: 'completed', summary: 'All of it', error: undefined, trigger: 'manual', preTokens: 84_000, postTokens: 9_000 });
  const chunk = parseCompactionUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1', content: { type: 'text', text: 'part' } });
  assert.deepEqual(chunk, { compactionId: 'c-1', summaryChunk: 'part' });
  assert.equal(parseCompactionUpdate({ sessionUpdate: 'compaction_update' }), null);
});

console.log('Handoff compaction against the mock agent');

const waitForIdle = async (id: string, timeoutMs = 20_000) => {
  const start = Date.now();
  while (sessionManager.isTurnInFlight(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${id} to go idle`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-compact-cwd-'));
store.clear();
sessionManager.init();

try {
  const s = await sessionManager.createSession({ agentId: 'mock', cwd });
  // The mock's reply mentions commands, so a prompt quoting it asks for approval; let that through
  sessionManager.updateAnnotations(s.id, { autoApprove: true });

  await test('manual compaction keeps the transcript, captures the summary, and restarts the agent', async () => {
    await sessionManager.sendPrompt(s.id, 'Remember the codeword PAPAYA');
    await waitForIdle(s.id);
    const before = sessionManager.getSession(s.id)!.turns.length;
    await sessionManager.compactSession(s.id);
    await waitForIdle(s.id);
    const after = sessionManager.getSession(s.id)!;
    assert.equal(after.turns.length, before + 1, 'only the card is added');
    const c = after.turns[after.turns.length - 1].compaction!;
    assert.equal(c.status, 'completed');
    assert.equal(c.method, 'handoff');
    assert.ok(c.summary && c.summary.length > 20, 'the reply became the summary');
    assert.ok(!after.turns.some((t) => t.role === 'agent' && t.content?.includes(c.summary!.slice(0, 40)) && t.timestamp >= c.startedAt), 'the summary is not also a reply');
    assert.equal(after.isAgentRunning, false, 'the agent was restarted (stopped until the next prompt)');
    assert.equal(after.contextHandoffPending, true);
    assert.equal(rankSession(after).state, 'needs_you', 'ranks like the finished turn');
  });

  await test('the next prompt carries the summary once, not the compacted turns', async () => {
    const summary = sessionManager.getSession(s.id)!.turns.at(-1)!.compaction!.summary!;
    await sessionManager.sendPrompt(s.id, 'What was the codeword');
    await waitForIdle(s.id);
    const lastThought = sessionManager.getSession(s.id)!.turns.filter((t) => t.role === 'agent').at(-1)!.thoughts || '';
    // The mock echoes the prompt it received into its first thought
    assert.ok(lastThought.includes('Summary of the conversation so far'), lastThought.slice(0, 300));
    assert.equal(count(lastThought, summary.slice(0, 60)), 1);
    assert.ok(!lastThought.includes('Remember the codeword PAPAYA'), 'the compacted prompt is not resent');
  });

  await test('an agent switch hands off the latest summary plus the turns after it', async () => {
    const summary = sessionManager.getSession(s.id)!.turns.find((t) => t.compaction?.status === 'completed')!.compaction!.summary!;
    await sessionManager.setSessionAgent(s.id, 'mock', undefined, undefined, 'compact');
    await sessionManager.sendPrompt(s.id, 'Carry on please');
    await waitForIdle(s.id);
    const lastThought = sessionManager.getSession(s.id)!.turns.filter((t) => t.role === 'agent').at(-1)!.thoughts || '';
    assert.equal(count(lastThought, summary.slice(0, 60)), 1);
    assert.ok(lastThought.includes('What was the codeword'), 'turns after the boundary are included');
    assert.ok(!lastThought.includes('Remember the codeword PAPAYA'));
  });

  await test('"Compact when finished" fires after a clean turn over the threshold, marked automatic', async () => {
    // The mock reports 1870 of 200000 tokens (~0.9%)
    sessionManager.setAutoCompact(s.id, { enabled: true, thresholdPercent: 0.5 });
    const cards = () => sessionManager.getSession(s.id)!.turns.filter((t) => t.compaction).length;
    const n = cards();
    await sessionManager.sendPrompt(s.id, 'One more small thing');
    await waitForIdle(s.id);
    const turns = sessionManager.getSession(s.id)!.turns;
    assert.equal(cards(), n + 1);
    assert.equal(turns.at(-1)!.compaction?.trigger, 'auto');
    assert.equal(turns.at(-1)!.compaction?.status, 'completed');
    // The last choice is the default for new sessions
    sessionManager.setAutoCompact(s.id, { enabled: true, thresholdPercent: 30 });
    assert.deepEqual(readAutoCompactDefault(), { enabled: true, thresholdPercent: 30 });
    const fresh = await sessionManager.createSession({ agentId: 'mock', cwd });
    assert.deepEqual(fresh.autoCompact, { enabled: true, thresholdPercent: 30 });
    sessionManager.deleteSession(fresh.id);
    sessionManager.setAutoCompact(s.id, { enabled: true, thresholdPercent: 0.5 });
  });

  await test('queued messages drain first; compaction runs once, after the last', async () => {
    const cards = () => sessionManager.getSession(s.id)!.turns.filter((t) => t.compaction).length;
    const n = cards();
    await sessionManager.queuePrompt(s.id, 'First queued note');
    const second = await sessionManager.queuePrompt(s.id, 'Second queued note');
    assert.equal(second.queued, true);
    await new Promise((r) => setTimeout(r, 200));
    await waitForIdle(s.id, 30_000);
    // The queue hands over between prompts; give the last turn's follow-ups a moment
    await new Promise((r) => setTimeout(r, 300));
    await waitForIdle(s.id, 30_000);
    const turns = sessionManager.getSession(s.id)!.turns;
    assert.equal(cards(), n + 1, 'one compaction for the whole run');
    const idx = turns.findIndex((t) => t.role === 'user' && t.content === 'Second queued note');
    assert.ok(idx > 0 && turns.slice(idx).some((t) => t.compaction), 'the compaction comes after the last queued message');
    assert.ok(!turns.slice(turns.findIndex((t) => t.content === 'First queued note'), idx).some((t) => t.compaction), 'none between them');
  });

  await test('a cancelled turn is not followed by a compaction', async () => {
    const cards = () => sessionManager.getSession(s.id)!.turns.filter((t) => t.compaction).length;
    const n = cards();
    void sessionManager.sendPrompt(s.id, 'Write a long answer');
    // Cancel once the agent has started answering (the last compaction restarted it)
    for (let i = 0; i < 100 && sessionManager.getSession(s.id)!.turns.at(-1)!.role !== 'agent'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await sessionManager.cancelPrompt(s.id);
    await waitForIdle(s.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cards(), n);
  });

  await test('Stop during a compaction marks it stopped and frees the session', async () => {
    sessionManager.setAutoCompact(s.id, { enabled: false, thresholdPercent: 50 });
    await sessionManager.sendPrompt(s.id, 'Another plain note');
    await waitForIdle(s.id);
    await sessionManager.compactSession(s.id);
    await new Promise((r) => setTimeout(r, 150));
    await sessionManager.cancelPrompt(s.id);
    await waitForIdle(s.id);
    const c = sessionManager.getSession(s.id)!.turns.at(-1)!.compaction!;
    assert.equal(c.status, 'cancelled');
    assert.equal(sessionManager.isTurnInFlight(s.id), false);
  });

  await test('compacting twice with nothing new in between is refused', async () => {
    await sessionManager.compactSession(s.id);
    await waitForIdle(s.id);
    await assert.rejects(() => sessionManager.compactSession(s.id), /Nothing new to compact/);
  });

  await test('after Stop then Start, compaction hands the new agent the history it has not seen', async () => {
    const { AcpClientHost } = await import('../server/acp/client-host.js');
    const sent: string[] = [];
    const original = AcpClientHost.prototype.sendPrompt;
    AcpClientHost.prototype.sendPrompt = function (this: any, text: string, att?: any) {
      sent.push(text);
      return original.call(this, text, att);
    };
    try {
      await sessionManager.sendPrompt(s.id, 'Remember the codeword MANGO');
      await waitForIdle(s.id);
      await sessionManager.stopSessionAgent(s.id);
      await sessionManager.startSessionAgent(s.id);
      assert.equal(sessionManager.getSession(s.id)!.contextHandoffPending, true, 'the restarted agent has not had the history');
      sent.length = 0;
      await sessionManager.compactSession(s.id);
      await waitForIdle(s.id);
      assert.ok(sent[0]?.includes('MANGO'), 'the summary prompt carries the history');
      const c = sessionManager.getSession(s.id)!.turns.at(-1)!.compaction!;
      assert.equal(c.method, 'handoff');
      assert.equal(c.status, 'completed');
    } finally {
      AcpClientHost.prototype.sendPrompt = original;
    }
  });

  await test('a compaction the agent started is closed when the agent is stopped', async () => {
    await sessionManager.sendPrompt(s.id, 'Something to talk about');
    await waitForIdle(s.id);
    (sessionManager as any).applyCompactionUpdate(s.id, { compactionId: 'agent-c1', status: 'in_progress' });
    assert.equal(sessionManager.getSession(s.id)!.turns.at(-1)!.compaction?.status, 'running');
    await sessionManager.stopSessionAgent(s.id);
    const c = sessionManager.getSession(s.id)!.turns.filter((t) => t.compaction?.trigger === 'agent').at(-1)!.compaction!;
    assert.equal(c.status, 'cancelled');
    assert.ok(c.endedAt);
  });
} finally {
  sessionManager.shutdown();
  fs.rmSync(testAppDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${passed} compaction checks passed`);
process.exit(0);
