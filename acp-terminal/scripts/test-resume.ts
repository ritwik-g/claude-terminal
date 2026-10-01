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

const { sessionManager, adoptClaudeSession, listImportableAgentSessions } = await import('../server/acp/session-mgr.js');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');
const { store } = await import('../server/store.js');

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
// What the scripted agent was last sent in one of its sessions, word for word
const lastSent = (agentSessionId: string): string => JSON.parse(fs.readFileSync(path.join(stateDir, `${agentSessionId}.json`), 'utf8')).prompts.at(-1);

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

  console.log('5. A new CodePit session can import an existing agent conversation');
  let importRefused = '';
  await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big', importAgentSessionId: s5.agentSessionId }).catch((err) => (importRefused = err.message));
  check('not one another CodePit session continues', /already continued/.test(importRefused), importRefused);
  const donor = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });
  await ask(donor.id, 'remember papaya');
  const donorAgentSession = sessionManager.getSession(donor.id)!.agentSessionId!;
  await sessionManager.forgetAgentSession(donor.id);
  const imported = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big', importAgentSessionId: donorAgentSession });
  const importedReply = await ask(imported.id, 'what was the word?');
  check('the imported id is resumed rather than copied', field(importedReply, 'resumed') === 'true' && field(importedReply, 'seen') === '2' && field(importedReply, 'first') === 'remember', importedReply);
  check('the new CodePit session records the imported agent session', imported.agentSessions?.[0]?.id === donorAgentSession && imported.agentSessions?.[0]?.resumes === 1, imported.agentSessions);

  console.log('6. A handoff compaction starts over with the summary');
  await sessionManager.compactSession(id);
  await waitForIdle(id);
  const compacted = sessionManager.getSession(id)!;
  check('the compacted agent session is not continued', !compacted.agentResume, compacted.agentResume);
  const sixth = await ask(id, 'after compaction');
  check('a new session handed the summary', field(sixth, 'seen') === '1' && field(sixth, 'history') === 'true', sixth);

  console.log('7. A clean slate starts a new session with nothing');
  await sessionManager.setSessionAgent(id, 'resumetest', 'big', undefined, 'none');
  check('nothing to continue', !sessionManager.getSession(id)!.agentResume);
  const seventh = await ask(id, 'clean slate');
  check('a new session without the conversation', field(seventh, 'seen') === '1' && field(seventh, 'history') === 'false', seventh);

  console.log('8. Start fresh sets the agent session aside');
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

  console.log('9. Rewinding the conversation starts a new session');
  await ask(id, 'to be undone');
  await sessionManager.rollbackSession(id, { action: 'undo_last' });
  check('nothing to continue after a rewind', !sessionManager.getSession(id)!.agentResume);

  console.log('10. "Send now" right after the running turn is cancelled');
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

  console.log('11. Finding and listing local sessions that can be imported');
  const claudeDir = path.join(testAppDir, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const project = path.join(claudeDir, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  const claudeId = '11111111-2222-3333-4444-555555555555';
  const entry = (text: string, at = cwd) => JSON.stringify({ type: 'user', cwd: at, message: { role: 'user', content: text } });
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
  const claudeImports = listImportableAgentSessions('claude', cwd);
  check('the existing Claude transcript is an import candidate', claudeImports.some((s) => s.id === claudeId && s.label.includes('please fix the login page')), claudeImports);
  // /x/my-app and /x/my/app share a Claude project folder: the transcript says which it was
  const otherFolderId = '66666666-7777-8888-9999-000000000000';
  fs.writeFileSync(path.join(project, `${otherFolderId}.jsonl`), entry('about another checkout', path.join(path.dirname(cwd), 'elsewhere')) + '\n');
  check('not one started in another folder with the same project name', !listImportableAgentSessions('claude', cwd).some((s) => s.id === otherFolderId));
  // One a CodePit session continues, now or after a switch back, is not offered
  const holder = store.get(ns.id)!;
  const heldResume = holder.agentResume;
  holder.agentResume = { agentId: 'claude', sessionId: claudeId, cwd, savedAt: Date.now() };
  store.save(holder, { touch: false });
  check('not one a CodePit session continues', !listImportableAgentSessions('claude', cwd).some((s) => s.id === claudeId));
  holder.agentResume = heldResume;
  store.save(holder, { touch: false });

  const codexDir = path.join(testAppDir, 'codex-config');
  process.env.CODEPIT_CODEX_CONFIG_DIR = codexDir;
  const codexSessionId = '01a0f5e4-9e38-75d1-9dc1-47c2a0c789d0';
  const codexFile = path.join(codexDir, 'sessions', '2026', '10', '01', `rollout-test-${codexSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: codexSessionId, cwd } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue the Codex migration' }] } }),
  ].join('\n') + '\n');
  const codexImports = listImportableAgentSessions('codex', cwd);
  check('the existing Codex transcript is an import candidate', codexImports.some((s) => s.id === codexSessionId && s.label.includes('Codex migration')), codexImports);
  holder.parkedAgentResumes = [{ agentId: 'codex', agentName: 'Codex', sessionId: codexSessionId, cwd, savedAt: 0, parkedAt: 0 }];
  store.save(holder, { touch: false });
  check('not one set aside to continue', !listImportableAgentSessions('codex', cwd).some((s) => s.id === codexSessionId));
  delete holder.parkedAgentResumes;
  store.save(holder, { touch: false });
  delete process.env.CODEPIT_CODEX_CONFIG_DIR;

  console.log('12. Rewinding to before a clean slate undoes it');
  const earlier = sessionManager.getSession(id)!.turns.find((t) => t.role === 'user')!;
  await sessionManager.setSessionAgent(id, 'resumetest', 'big', undefined, 'none');
  check('a clean slate marks where the handover starts', sessionManager.getSession(id)!.contextStartIndex !== undefined);
  await sessionManager.rollbackSession(id, { turnId: earlier.id, action: 'revert_to_this' });
  const rewound = sessionManager.getSession(id)!;
  check('the mark is gone, so later turns are handed over', rewound.contextStartIndex === undefined && rewound.skipClaudeAdoption === true);

  console.log('13. Claude keywords: ultrathink once, never on a slash command');
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

  console.log('14. Switching to another agent and back continues the first agent session');
  AGENT_REGISTRY.resumeother = { ...agentEntry('resumeother', { EFFORT_TEST_STATE_DIR: stateDir }), name: 'Other test agent' };
  const sw = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });
  check('the default title is just the folder', sw.title === path.basename(cwd), sw.title);
  await ask(sw.id, 'remember mango');
  const aSession = sessionManager.getSession(sw.id)!.agentSessionId!;
  await sessionManager.setSessionAgent(sw.id, 'resumeother', 'big');
  const away = sessionManager.getSession(sw.id)!;
  check('the first agent session is kept for later', away.parkedAgentResumes?.length === 1 && away.parkedAgentResumes[0].sessionId === aSession && !away.agentResume, away.parkedAgentResumes);
  check('its record says how to get it back', Boolean(away.agentSessions?.find((r) => r.id === aSession)?.endReason?.startsWith('Set aside when you switched to Other test agent')), away.agentSessions);
  check('a plain switch hands over a summary', notes(sw.id).at(-1)!.includes('[Context: compact]'), notes(sw.id).at(-1));
  const bReply = await ask(sw.id, 'question for the other agent');
  check('the other agent starts a new session with a summary', field(bReply, 'seen') === '1' && field(bReply, 'history') === 'true', bReply);
  await sessionManager.setSessionAgent(sw.id, 'resumetest', 'big');
  const back = sessionManager.getSession(sw.id)!;
  check('switching back makes it the one to continue', back.agentResume?.sessionId === aSession && !back.parkedAgentResumes?.some((p) => p.sessionId === aSession), back);
  check('the other agent session is kept for later now', back.parkedAgentResumes?.length === 1 && back.parkedAgentResumes[0].agentId === 'resumeother', back.parkedAgentResumes);
  check('the switch note says it continues', notes(sw.id).at(-1)!.includes(`[Context: continues ${aSession.slice(0, 8)}]`), notes(sw.id).at(-1));
  const aReply = await ask(sw.id, 'back to you');
  check('the same agent session, continued', field(aReply, 'resumed') === 'true' && field(aReply, 'seen') === '2' && field(aReply, 'first') === 'remember', aReply);
  const caughtUp = lastSent(aSession);
  // The other agent's reply quotes its own first prompt (its handoff), so look at where the list starts
  // and for this agent's own reply ("first=remember ...") rather than for the words
  const firstEntry = caughtUp.split('\n').find((l) => l.startsWith('- '));
  check('caught up with only the turns it missed', firstEntry === '- User: "question for the other agent"' && !caughtUp.includes('first=remember'), caughtUp);
  check('under a catch-up header naming the other agent', caughtUp.startsWith('[Catch-up Since You Last Took Part') && caughtUp.includes('while Other test agent handled'), caughtUp);
  const records = sessionManager.getSession(sw.id)!.agentSessions!;
  const aRecord = records.find((r) => r.id === aSession)!;
  check('no new agent session recorded, the first one continued once', records.filter((r) => r.agentId === 'resumetest').length === 1 && aRecord.resumes === 1 && !aRecord.endReason, records);
  check('the catch-up mark is used up', sessionManager.getSession(sw.id)!.catchUpAfterTurnId === undefined);
  await ask(sw.id, 'and again');
  check('the catch-up is sent once', lastSent(aSession) === 'and again', lastSent(aSession));

  console.log('15. A rewind past where it was set aside, or a clean slate, drops a kept agent session');
  await sessionManager.rollbackSession(sw.id, { action: 'undo_last' });
  check('a rewind that keeps what it saw keeps it', sessionManager.getSession(sw.id)!.parkedAgentResumes?.length === 1);
  const otherQuestion = sessionManager.getSession(sw.id)!.turns.find((t) => t.role === 'user' && t.content === 'question for the other agent')!;
  const bSession = sessionManager.getSession(sw.id)!.parkedAgentResumes![0].sessionId;
  await sessionManager.rollbackSession(sw.id, { turnId: otherQuestion.id, action: 'revert_before_this' });
  const rewoundSw = sessionManager.getSession(sw.id)!;
  check('a rewind past what it saw drops it', !rewoundSw.parkedAgentResumes && rewoundSw.agentSessions!.find((r) => r.id === bSession)!.endReason!.startsWith('Conversation rewound'), rewoundSw.parkedAgentResumes);
  await ask(sw.id, 'start over here');
  const a2 = sessionManager.getSession(sw.id)!.agentSessionId!;
  await sessionManager.setSessionAgent(sw.id, 'resumeother', 'big');
  check('kept again on the next switch', sessionManager.getSession(sw.id)!.parkedAgentResumes?.[0]?.sessionId === a2);
  await ask(sw.id, 'other agent again');
  await sessionManager.setSessionAgent(sw.id, 'resumetest', 'big', undefined, 'none');
  const slate = sessionManager.getSession(sw.id)!;
  check('a clean slate keeps nothing for later', !slate.parkedAgentResumes && !slate.agentResume && !notes(sw.id).at(-1)!.includes('continues'), slate.parkedAgentResumes);
  const slateReply = await ask(sw.id, 'clean start');
  check('and starts a new agent session with nothing', field(slateReply, 'resumed') === 'false' && field(slateReply, 'seen') === '1' && field(slateReply, 'history') === 'false', slateReply);

  console.log('16. Old default titles become the folder name');
  const folder = path.basename(cwd);
  const retitle = (sid: string, title: string, titleSource: 'auto' | 'user' | 'agent') => {
    const s = store.get(sid)!;
    Object.assign(s, { title, titleSource });
    store.save(s, { touch: false });
  };
  retitle(id, `Resume test agent in ${folder}`, 'auto');
  retitle(ns.id, `Codex CLI (ACP) (from Claude Code (ACP)) in ${folder}`, 'auto');
  retitle(imported.id, `Resume test agent in ${folder}`, 'user');
  retitle(claudeSession.id, 'Resume test agent in another-folder', 'auto');
  retitle(sw.id, `Fix the login in ${folder}`, 'auto');
  sessionManager.init();
  const title = (sid: string) => sessionManager.getSession(sid)!.title;
  check('an agent-named default title is migrated', title(id) === folder, title(id));
  check('a failover default title is migrated', title(ns.id) === folder, title(ns.id));
  check('a title the user set is left alone', title(imported.id) === `Resume test agent in ${folder}`, title(imported.id));
  check('another folder is left alone', title(claudeSession.id) === 'Resume test agent in another-folder', title(claudeSession.id));
  check('a title that does not name an agent is left alone', title(sw.id) === `Fix the login in ${folder}`, title(sw.id));

  console.log('17. An agent session started but never sent the conversation still gets it after a model change');
  const ks = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });
  await ask(ks.id, 'remember kiwi');
  await sessionManager.setSessionAgent(ks.id, 'resumeother', 'big');
  await sessionManager.startSessionAgent(ks.id);
  const owed = sessionManager.getSession(ks.id)!.agentSessionId!;
  check('started, owing the conversation', sessionManager.getSession(ks.id)!.contextHandoffPending === true);
  // Like an agent that takes the model only on a restart
  await sessionManager.stopSessionAgent(ks.id);
  await sessionManager.setSessionAgent(ks.id, 'resumeother', 'small');
  const kept = sessionManager.getSession(ks.id)!;
  check('the same agent session is kept, still owing it', kept.agentResume?.sessionId === owed && kept.contextHandoffPending === true, kept.contextHandoffPending);
  check('the switch line does not say the context is kept', !notes(ks.id).at(-1)!.includes('[Context: kept]'), notes(ks.id).at(-1));
  const keptReply = await ask(ks.id, 'what did I ask before?');
  check('the continued session is handed the conversation', field(keptReply, 'resumed') === 'true' && field(keptReply, 'history') === 'true', keptReply);

  console.log('18. One switched back to but dropped before it continued says why it ended');
  const ds = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });
  await ask(ds.id, 'remember lime');
  const dsAgent = sessionManager.getSession(ds.id)!.agentSessionId!;
  await sessionManager.setSessionAgent(ds.id, 'resumeother', 'big');
  await ask(ds.id, 'over to you');
  await sessionManager.setSessionAgent(ds.id, 'resumetest', 'big');
  check('switched back, it is the one to continue', sessionManager.getSession(ds.id)!.agentResume?.sessionId === dsAgent);
  await sessionManager.forgetAgentSession(ds.id);
  const dsRecord = sessionManager.getSession(ds.id)!.agentSessions!.find((r) => r.id === dsAgent)!;
  check('its record no longer says it continues', dsRecord.endReason === 'Set aside for a fresh agent session', dsRecord);

  console.log('19. A message taken back out after a switch does not lose where the set-aside session was');
  const ms = await sessionManager.createSession({ agentId: 'resumetest', cwd, model: 'big' });
  await ask(ms.id, 'remember plum');
  const msAgent = sessionManager.getSession(ms.id)!.agentSessionId!;
  // Like a "send now" message still on its way at the switch, then taken back out when it fails
  const pendingTurn = { id: `usr-${Date.now()}-pending`, role: 'user' as const, content: 'not delivered', timestamp: Date.now() };
  const beforeSwitch = store.get(ms.id)!;
  beforeSwitch.turns.push(pendingTurn);
  store.save(beforeSwitch, { touch: false });
  await sessionManager.setSessionAgent(ms.id, 'resumeother', 'big');
  const afterSwitch = store.get(ms.id)!;
  afterSwitch.turns = afterSwitch.turns.filter((t) => t.id !== pendingTurn.id);
  store.save(afterSwitch, { touch: false });
  await ask(ms.id, 'question while plum is away');
  await sessionManager.setSessionAgent(ms.id, 'resumetest', 'big');
  await ask(ms.id, 'back again');
  const msSent = lastSent(msAgent);
  check('caught up on what it missed, not handed everything again', msSent.startsWith('[Catch-up Since You Last Took Part') && msSent.split('\n').find((l) => l.startsWith('- ')) === '- User: "question while plum is away"', msSent);
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
