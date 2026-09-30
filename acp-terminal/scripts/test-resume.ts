import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Continuing the same agent session: after Stop/Start and a server restart the agent
 * resumes its own session (ACP session/resume) instead of getting a summary; the cases
 * that must start a new one (handoff compaction, clean slate, start fresh, rewind, a
 * failed resume); "Send now" after a prompt cancel; and finding the Claude session of a
 * conversation recorded before CodePit kept them. Runs against a scripted agent.
 */

const testAppDir = path.join(os.tmpdir(), `codepit-resume-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
const stateDir = path.join(testAppDir, 'agent-state');
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;
fs.mkdirSync(stateDir, { recursive: true });

const { sessionManager, adoptClaudeSession } = await import('../server/acp/session-mgr.js');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`   ok  ${name}`);
  else {
    failures++;
    console.log(`   FAIL ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const TSX_BIN = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const agentEntry = (id: string, env: Record<string, string>) => ({
  id,
  name: 'Resume test agent',
  provider: 'mock' as const,
  description: 'Scripted agent for test-resume',
  command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
  args: [path.join(here, 'lib/effort-test-agent.ts')],
  env,
  icon: 'mock',
  defaultModel: 'big',
  availableModels: ['big', 'small'],
  efforts: [],
});
AGENT_REGISTRY.resumetest = agentEntry('resumetest', { EFFORT_TEST_STATE_DIR: stateDir });
AGENT_REGISTRY.nosteertest = agentEntry('nosteertest', { EFFORT_TEST_STATE_DIR: stateDir, EFFORT_TEST_NO_STEER: '1' });

async function waitForIdle(id: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (sessionManager.isTurnInFlight(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for session ${id} to go idle`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function ask(id: string, text: string): Promise<string> {
  await sessionManager.sendPrompt(id, text);
  await waitForIdle(id);
  const turns = sessionManager.getSession(id)!.turns;
  return [...turns].reverse().find((t) => t.role === 'agent')?.content || '';
}

const field = (reply: string, key: string) => reply.match(new RegExp(`${key}=(\\S+)`))?.[1];
const notes = (id: string) => sessionManager.getSession(id)!.turns.filter((t) => t.role === 'system').map((t) => t.content || '');

async function main(): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-resume-ws-'));
  const { id } = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });

  console.log('1. Stop and start continue the same agent session');
  const first = await ask(id, 'remember pineapple');
  const agentSession = sessionManager.getSession(id)!.agentSessionId;
  check('a new agent session is recorded and can be continued', Boolean(agentSession) && sessionManager.getSession(id)!.agentResume?.sessionId === agentSession);
  await sessionManager.stopSessionAgent(id);
  check('the stop note says the next message continues it', notes(id).at(-1)!.includes('continues the same agent session'), notes(id).at(-1));
  const second = await ask(id, 'what was the word?');
  check('a new process', field(second, 'pid') !== field(first, 'pid'), second);
  check('continuing the same conversation', field(second, 'resumed') === 'true' && field(second, 'seen') === '2' && field(second, 'first') === 'remember', second);
  check('no summary sent to a continued session', field(second, 'history') === 'false', second);
  const s2 = sessionManager.getSession(id)!;
  check('same agent session id', s2.agentSessionId === agentSession);
  check('one agent session, continued once', s2.agentSessions?.length === 1 && s2.agentSessions[0].resumes === 1, s2.agentSessions);
  const noteAt = s2.turns.findIndex((t) => t.content?.startsWith('↪️ Continued agent session'));
  const askAt = s2.turns.findIndex((t) => t.role === 'user' && t.content === 'what was the word?');
  check('the "continued" note sits before the message that started it', noteAt !== -1 && noteAt < askAt, { noteAt, askAt });

  console.log('2. Settings the agent resets on resume are applied again');
  await sessionManager.setSessionMode(id, 'acceptEdits');
  await sessionManager.setSessionFastMode(id, true);
  await sessionManager.stopSessionAgent(id);
  const third = await ask(id, 'and now?');
  check('approval mode and fast mode re-applied', field(third, 'mode') === 'acceptEdits' && field(third, 'fast') === 'true', third);
  check('still the same conversation', field(third, 'seen') === '3', third);

  console.log('3. A server restart continues it too');
  sessionManager.shutdown();
  const fourth = await ask(id, 'after the restart');
  check('continued after the restart', field(fourth, 'resumed') === 'true' && field(fourth, 'seen') === '4' && field(fourth, 'history') === 'false', fourth);

  console.log('4. When the agent cannot continue it, a new session gets a summary');
  await sessionManager.stopSessionAgent(id);
  fs.rmSync(path.join(stateDir, `${agentSession}.json`));
  const fifth = await ask(id, 'after the loss');
  check('a new session', field(fifth, 'resumed') === 'false' && field(fifth, 'seen') === '1', fifth);
  check('handed the conversation', field(fifth, 'history') === 'true', fifth);
  const s5 = sessionManager.getSession(id)!;
  check('says why', notes(id).some((n) => n.startsWith('⚠️ Could not continue agent session')), notes(id).slice(-3));
  check('the new session replaces the old one, with the reason', s5.agentSessions?.length === 2 && Boolean(s5.agentSessions[1].replacedBecause), s5.agentSessions);
  check('the old one is marked ended', Boolean(s5.agentSessions?.[0].endedAt));
  check('the new one is the one to continue', s5.agentResume?.sessionId === s5.agentSessionId && s5.agentSessionId !== agentSession);

  console.log('5. A handoff compaction starts over with the summary');
  await sessionManager.compactSession(id);
  await waitForIdle(id);
  const compacted = sessionManager.getSession(id)!;
  check('the compacted agent session is not continued', !compacted.agentResume, compacted.agentResume);
  const sixth = await ask(id, 'after compaction');
  check('a new session handed the summary', field(sixth, 'seen') === '1' && field(sixth, 'history') === 'true', sixth);

  console.log('6. A clean slate starts a new session with nothing');
  await sessionManager.setSessionAgent(id, 'resumetest', 'big', undefined, 'none');
  check('nothing to continue', !sessionManager.getSession(id)!.agentResume);
  const seventh = await ask(id, 'clean slate');
  check('a new session without the conversation', field(seventh, 'seen') === '1' && field(seventh, 'history') === 'false', seventh);

  console.log('7. Start fresh sets the agent session aside');
  await ask(id, 'one more');
  await sessionManager.forgetAgentSession(id, 'compact');
  const forgotten = sessionManager.getSession(id)!;
  check('nothing to continue, agent stopped', !forgotten.agentResume && !forgotten.isAgentRunning);
  const eighth = await ask(id, 'fresh start');
  check('a new session handed the conversation since the clean slate', field(eighth, 'seen') === '1' && field(eighth, 'history') === 'true', eighth);
  const slow = sessionManager.sendPrompt(id, 'slow-turn');
  await new Promise((r) => setTimeout(r, 300));
  let refused = false;
  await sessionManager.forgetAgentSession(id).catch(() => (refused = true));
  check('refused while a turn runs', refused);
  await sessionManager.cancelPrompt(id);
  await slow;
  await waitForIdle(id);

  console.log('8. Rewinding the conversation starts a new session');
  await ask(id, 'to be undone');
  await sessionManager.rollbackSession(id, { action: 'undo_last' });
  check('nothing to continue after a rewind', !sessionManager.getSession(id)!.agentResume);

  console.log('9. "Send now" right after the running turn is cancelled');
  const ns = await sessionManager.createSession({ agentId: 'nosteertest', cwd, model: 'big' });
  await ask(ns.id, 'warm up');
  const running = sessionManager.sendPrompt(ns.id, 'slow-turn please');
  for (let i = 0; i < 100 && !sessionManager.isTurnInFlight(ns.id); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  await sessionManager.queuePrompt(ns.id, 'do this instead');
  await sessionManager.sendQueuedNow(ns.id, sessionManager.getSession(ns.id)!.queuedPrompts![0].id);
  await running;
  await waitForIdle(ns.id);
  for (let i = 0; i < 100 && !sessionManager.getSession(ns.id)!.turns.some((t) => t.role === 'user' && t.content === 'do this instead'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await waitForIdle(ns.id);
  const nsTurns = sessionManager.getSession(ns.id)!.turns;
  const sentAt = nsTurns.findIndex((t) => t.role === 'user' && t.content === 'do this instead');
  check('the message is sent, not lost', sentAt !== -1, nsTurns.map((t) => [t.role, t.content?.slice(0, 30)]));
  check('and answered', nsTurns.slice(sentAt + 1).some((t) => t.role === 'agent' && t.content?.includes('pid=')));
  check('the queue is empty', !sessionManager.getSession(ns.id)!.queuedPrompts?.length);
  const log = fs.readFileSync(path.join(testAppDir, 'logs', 'queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the queue log records it', log.some((e) => e.event === 'queued' && e.text === 'do this instead') && log.some((e) => e.event === 'sent-now' && e.text === 'do this instead'), log.slice(-3));

  console.log('10. Finding the Claude session of a conversation from before');
  const claudeDir = path.join(testAppDir, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const project = path.join(claudeDir, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const claudeId = '11111111-2222-3333-4444-555555555555';
  const entry = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  fs.writeFileSync(
    path.join(project, `${claudeId}.jsonl`),
    [
      entry('[Prior Conversation Context (Compacted)]\nold stuff\n\n[Active User Request]\nfirst question here'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
      entry('[Attached Image: x.png (Saved at: /tmp/x.png)]\n\nplease fix the login page'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    ].join('\n') + '\n'
  );
  const legacy: any = {
    agentId: 'claude',
    cwd,
    turns: [
      { id: 'u1', role: 'user', content: 'first question here' },
      { id: 'a1', role: 'agent', content: 'answer' },
      { id: 'u2', role: 'user', content: 'please fix the login page' },
      { id: 'u3', role: 'user', content: 'the message being sent now' },
    ],
  };
  check('found by its last message, skipping the one being sent', adoptClaudeSession(legacy, 'u3') === claudeId);
  check('not when the last message differs', adoptClaudeSession({ ...legacy, turns: legacy.turns.slice(0, 2) }) === undefined);
  check('never for a session that already records its agent sessions', adoptClaudeSession({ ...legacy, agentSessions: [{ id: 'x' }] }, 'u3') === undefined);
  check('never for other agents', adoptClaudeSession({ ...legacy, agentId: 'codex' }, 'u3') === undefined);
  check('never after the context was cleared or rewound', adoptClaudeSession({ ...legacy, skipClaudeAdoption: true }, 'u3') === undefined);

  console.log('11. Rewinding to before a clean slate undoes it');
  const earlier = sessionManager.getSession(id)!.turns.find((t) => t.role === 'user')!;
  await sessionManager.setSessionAgent(id, 'resumetest', 'big', undefined, 'none');
  check('a clean slate marks where the handover starts', sessionManager.getSession(id)!.contextStartIndex !== undefined);
  await sessionManager.rollbackSession(id, { turnId: earlier.id, action: 'revert_to_this' });
  const rewound = sessionManager.getSession(id)!;
  check('the mark is gone, so later turns are handed over', rewound.contextStartIndex === undefined && rewound.skipClaudeAdoption === true);

  console.log('12. Claude keywords: ultrathink once, never on a slash command');
  AGENT_REGISTRY.claude = { ...agentEntry('claude', { EFFORT_TEST_STATE_DIR: stateDir }), name: 'Claude Code (ACP)' };
  const claudeSession = await sessionManager.createSession({ agentId: 'claude', cwd, model: 'big' });
  await sessionManager.setSessionUltra(claudeSession.id, { ultrathinkNext: true });
  const slash = await ask(claudeSession.id, '/help');
  check('a slash command goes without keywords', field(slash, 'keywords') === 'none', slash);
  check('ultrathink stays armed', sessionManager.getSession(claudeSession.id)!.ultrathinkNext === true);
  const thought = await ask(claudeSession.id, 'think about it');
  check('the next message carries ultrathink', field(thought, 'keywords') === 'ultrathink', thought);
  const userTurn = [...sessionManager.getSession(claudeSession.id)!.turns].reverse().find((t) => t.role === 'user')!;
  check('shown on the message, not in its text', userTurn.keywords?.[0] === 'ultrathink' && userTurn.content === 'think about it', userTurn);
  const after = await ask(claudeSession.id, 'and again');
  check('used up after one message', field(after, 'keywords') === 'none' && !sessionManager.getSession(claudeSession.id)!.ultrathinkNext, after);
  delete process.env.CLAUDE_CONFIG_DIR;
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  sessionManager.shutdown();
  fs.rmSync(testAppDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} resume check(s) failed`);
  process.exit(1);
}
console.log('\nAll resume checks passed');
process.exit(0);
