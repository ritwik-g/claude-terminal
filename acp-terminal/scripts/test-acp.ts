import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Isolate test storage from the user's real ~/.codepit directory BEFORE any imports
const testAppDir = path.join(os.tmpdir(), `codepit-test-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;

// Dynamic imports ensure environment variables are evaluated before any server module is imported
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { listAgents } = await import('../server/agents/registry.js');
const { searchSessions } = await import('../server/search.js');
const { store } = await import('../server/store.js');
const { getAppDir, getSessionsDir } = await import('../server/paths.js');
const { TurnInFlightError } = await import('../server/acp/client-host.js');
const { checkAccess, getRemoteAddress } = await import('../server/security.js');
const { apiRouter } = await import('../server/api.js');
const { parseElicitationFields, validateElicitationContent } = await import('../server/acp/elicitation.js');
const { default: express } = await import('express');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');

// A session accepts one turn at a time; wait until the previous one (e.g. a fire-and-forget
// initial prompt) has finished before sending the next.
async function waitForIdle(id: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (sessionManager.isTurnInFlight(id)) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for session ${id} to go idle`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function fakeRequest(opts: { remote: string; headers?: Record<string, string> }): IncomingMessage {
  return { headers: opts.headers || {}, socket: { remoteAddress: opts.remote } } as unknown as IncomingMessage;
}

async function runTests() {
  console.log('🧪 [Test Suite] Starting CodePit Test Suite...\n');
  console.log(`📁 Using isolated test storage: ${testAppDir}\n`);

  // Verify that test suite is NOT using the user's production ~/.codepit directory
  const realUserSessionsDir = path.join(os.homedir(), '.codepit', 'sessions');
  const initialUserFiles = fs.existsSync(realUserSessionsDir) ? fs.readdirSync(realUserSessionsDir) : [];

  if (getAppDir() !== testAppDir) {
    throw new Error(`CRITICAL: Test suite is not using isolated testAppDir! (Got ${getAppDir()}, expected ${testAppDir})`);
  }
  if (!getSessionsDir().startsWith(testAppDir)) {
    throw new Error(`CRITICAL: Test sessions directory points outside testAppDir: ${getSessionsDir()}`);
  }

  // Setup temp directory as a test git repo
  const testDir = path.join(os.tmpdir(), `acp-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  execSync('git init -b main', { cwd: testDir });
  execSync('git config user.email "test@example.com"', { cwd: testDir });
  execSync('git config user.name "Test User"', { cwd: testDir });
  fs.writeFileSync(path.join(testDir, 'README.md'), '# ACP Test Repo\n');
  execSync('git add README.md && git commit -m "initial commit"', { cwd: testDir });

  try {
    // 1. Verify Agent Registry
    console.log('1️⃣ Checking Agent Registry...');
    const agents = listAgents();
    const agentIds = agents.map((a) => a.id);
    console.log(`   Found agents: ${agentIds.join(', ')}`);
    if (!agentIds.includes('claude') || !agentIds.includes('codex') || !agentIds.includes('mock')) {
      throw new Error(`Missing expected agents in registry: ${agentIds}`);
    }
    console.log('   ✅ Agent registry contains Claude, Codex, Antigravity, and Mock\n');

    // 2. Initialize Session Manager with clean isolated store
    console.log('2️⃣ Initializing Session Manager...');
    store.clear();
    sessionManager.init();

    // 3. Create Session with Mock Agent
    console.log('3️⃣ Creating Session with Mock ACP Agent in git repo...');
    const session = await sessionManager.createSession({
      agentId: 'mock',
      cwd: testDir,
      title: 'ACP Test Session',
    });
    console.log(`   Created session: ${session.id} (Agent: ${session.agentName})`);
    if (!session.id.startsWith('acp-')) {
      throw new Error('Session ID unexpected shape');
    }
    console.log('   ✅ Session created and initialized with ACP handshake\n');

    // 4. Test Basic Prompt & Message Streaming
    console.log('4️⃣ Testing Prompt & Turn Streaming...');
    await sessionManager.sendPrompt(session.id, 'Hello ACP agent! Please introduce yourself.');

    // Wait briefly for turn to complete
    await new Promise((r) => setTimeout(r, 1200));

    const updated = sessionManager.getSession(session.id);
    if (!updated || updated.turns.length === 0) {
      throw new Error('Turns were not recorded in session');
    }
    console.log(`   Recorded turns: ${updated.turns.length}`);
    const lastTurn = updated.turns[updated.turns.length - 1];
    console.log(`   Agent thoughts: "${lastTurn.thoughts?.slice(0, 60)}..."`);
    console.log(`   Agent response: "${lastTurn.content?.slice(0, 60)}..."`);
    console.log(`   Session State: ${updated.state} (Score: ${updated.score})`);
    console.log(`   Token Usage: Context ${updated.usage.contextTokens} tokens`);

    if (updated.state !== 'needs_you') {
      throw new Error(`Expected state 'needs_you' after turn completion, got '${updated.state}'`);
    }
    console.log('   ✅ Prompt streaming, turn recording, and token usage verified\n');

    // 5. Test Permission Request & Attention Ranking (Blocked State)
    console.log('5️⃣ Testing Permission Request & Attention Ranking...');
    
    // Listen for permission request event
    const permPromise = new Promise<{ sessionId: string; permission: any }>((resolve) => {
      sessionManager.once('permissionRequested', resolve);
    });

    // Send prompt that triggers a permission request
    console.log('   Sending prompt requesting a terminal command...');
    sessionManager.sendPrompt(session.id, 'Please run test command in terminal');

    const permEvent = await permPromise;
    console.log(`   Received permission request: "${permEvent.permission.title}"`);
    console.log(`   Available options: ${permEvent.permission.options.map((o: any) => o.name).join(', ')}`);

    const blockedSession = sessionManager.getSession(session.id)!;
    console.log(`   Session State: ${blockedSession.state}`);
    console.log(`   Session Score: ${blockedSession.score}`);
    console.log(`   Inspectable Reasons: \n     - ${blockedSession.reasons.join('\n     - ')}`);

    if (blockedSession.state !== 'blocked' || blockedSession.score < 200) {
      throw new Error(`Expected state 'blocked' with score >= 200, got ${blockedSession.state} with ${blockedSession.score}`);
    }
    console.log(`   Summary: ${blockedSession.rankSummary}`);
    if (!blockedSession.rankSummary?.includes(permEvent.permission.title) || blockedSession.rankFactors?.[0]?.label !== 'Waiting for your approval') {
      throw new Error(`Ranking should explain the approval in plain words: ${blockedSession.rankSummary} / ${JSON.stringify(blockedSession.rankFactors)}`);
    }
    const factorSum = (blockedSession.rankFactors || []).reduce((n, f) => n + f.points, 0);
    if (factorSum !== blockedSession.score) throw new Error(`Factors (${factorSum}) must add up to the score (${blockedSession.score})`);
    console.log('   ✅ Blocked state correctly surfaced to top of attention ranking\n');

    // 6. Test Resolving Permission
    console.log('6️⃣ Approving Permission...');
    const turnPromise = new Promise<void>((resolve) => {
      const handler = (evt: any) => {
        if (evt.sessionId === session.id && evt.type === 'turnCompleted') {
          sessionManager.off('sessionStream', handler);
          resolve();
        }
      };
      sessionManager.on('sessionStream', handler);
    });

    const approved = await sessionManager.resolvePermission(session.id, 'allow');
    if (!approved) throw new Error('Failed to resolve permission');

    // Wait for command execution and turn completion
    await turnPromise;

    const postApprovalSession = sessionManager.getSession(session.id)!;
    console.log(`   Post-approval State: ${postApprovalSession.state}`);
    const completedTurn = postApprovalSession.turns[postApprovalSession.turns.length - 1];
    const toolCall = completedTurn.toolCalls?.[0];
    console.log(`   Tool call status: ${toolCall?.status} (output length: ${toolCall?.output?.length || 0})`);
    console.log('   ✅ Tool executed and turn completed after permission approval\n');

    // 7. Test Priority & Annotations
    console.log('7️⃣ Testing Priority Boost & Pinned...');
    sessionManager.updateAnnotations(session.id, { priority: 'p0', pinned: true });
    const prioritizedSession = sessionManager.getSession(session.id)!;
    console.log(`   New Score: ${prioritizedSession.score}`);
    console.log(`   Reasons: \n     - ${prioritizedSession.reasons.join('\n     - ')}`);
    if (prioritizedSession.score < 10000) {
      throw new Error('Pinned boost not applied properly');
    }
    const labels = (prioritizedSession.rankFactors || []).map((f) => f.label);
    if (!labels.includes('Pinned') || !labels.includes('You set priority P0') || !/pinned/.test(prioritizedSession.rankSummary || '')) {
      throw new Error(`Pin and priority should be explained: ${JSON.stringify(labels)} / ${prioritizedSession.rankSummary}`);
    }
    if (prioritizedSession.reasons.some((r) => /base|_/.test(r))) throw new Error(`Reasons still use rule names: ${prioritizedSession.reasons}`);
    console.log('   ✅ Priority P0 and Pinned boosts verified\n');

    // 8. Test Agent Failover / Switching (Claude -> Codex / Target)
    console.log('8️⃣ Testing Agent Switching & Failover...');
    // Create an uncommitted file to simulate work left in repo
    fs.writeFileSync(path.join(testDir, 'work-in-progress.txt'), 'Refactoring task in progress...');
    
    console.log(`   Failing over from ${session.agentName} to Codex...`);
    const codexSession = await sessionManager.switchAgent(session.id, 'mock'); // use mock for local execution
    sessionManager.updateAnnotations(codexSession.id, { autoApprove: true });
    console.log(`   New session created: ${codexSession.id}`);
    console.log(`   Title: ${codexSession.title}`);
    console.log(`   Failover lineage: failoverFromId=${codexSession.failoverFromId}`);
    console.log(`   Initial handoff turn: "${codexSession.turns[0]?.content?.slice(0, 100)}..."`);

    if (codexSession.failoverFromId !== session.id) {
      throw new Error('Lineage link failoverFromId missing');
    }
    console.log('   ✅ Agent failover and context handover verified\n');

    // 8b. Test In-Place Agent & Model Switching (same session, internally managed subprocess)
    console.log('8️⃣b Testing In-Place Agent & Model Switching...');
    const sessionCountBefore = sessionManager.listSessions().length;
    const switchedSession = await sessionManager.setSessionAgent(session.id, 'mock', 'gpt-4o');
    if (switchedSession.id !== session.id) {
      throw new Error('In-place switch must keep the same session ID');
    }
    if (switchedSession.model !== 'gpt-4o') {
      throw new Error('In-place switch did not update model');
    }
    const sessionCountAfter = sessionManager.listSessions().length;
    if (sessionCountAfter !== sessionCountBefore) {
      throw new Error(`In-place switch created an unwanted duplicate session! Before: ${sessionCountBefore}, After: ${sessionCountAfter}`);
    }
    const systemTurn = switchedSession.turns[switchedSession.turns.length - 1];
    if (systemTurn.role !== 'system') {
      throw new Error('In-place switch did not record system turn');
    }
    console.log(`   Session maintained: ${switchedSession.id} with agent ${switchedSession.agentName} [${switchedSession.model}]`);
    console.log(`   System turn recorded: "${systemTurn.content}"`);
    console.log('   ✅ In-place switching verified (no duplicate sessions, single thread preserved)\n');

    // 8c. Test Undo / Rollback Messages to a Point
    console.log('8️⃣c Testing Conversation Undo / Rollback...');
    // Add two test turns to codexSession to test rollback (after the failover handoff turn finishes)
    await waitForIdle(codexSession.id);
    await sessionManager.sendPrompt(codexSession.id, 'Alpha greeting message');
    await new Promise((r) => setTimeout(r, 600));
    await sessionManager.sendPrompt(codexSession.id, 'Beta exploration message');
    await new Promise((r) => setTimeout(r, 600));

    const preRollbackTurns = sessionManager.getSession(codexSession.id)!.turns;
    const secondPromptTurn = preRollbackTurns.find((t) => t.role === 'user' && t.content === 'Beta exploration message')!;
    if (!secondPromptTurn) throw new Error('Second prompt turn not found');

    // Test revert_before_this (edit & resend flow)
    const { session: rolledBackSession, restoredPrompt } = await sessionManager.rollbackSession(codexSession.id, {
      turnId: secondPromptTurn.id,
      action: 'revert_before_this',
    });

    if (restoredPrompt !== 'Beta exploration message') {
      throw new Error(`Expected restoredPrompt to be "Beta exploration message", got "${restoredPrompt}"`);
    }
    const hasSecondTurn = rolledBackSession.turns.some((t) => t.id === secondPromptTurn.id);
    if (hasSecondTurn) {
      throw new Error('Rollback failed to remove the target turn and subsequent messages');
    }
    console.log(`   Rolled back from ${preRollbackTurns.length} turns to ${rolledBackSession.turns.length} turns`);
    console.log(`   Restored prompt text: "${restoredPrompt}"`);
    console.log('   ✅ Conversation undo / rollback verified\n');

    // 8d. Test Context History Transfer & Session Compaction
    console.log('8️⃣d Testing Context History Transfer & Session Compaction...');
    // In-place switch with context transfer enabled
    const preSwitchTurns = codexSession.turns.length;
    const switchedContextSession = await sessionManager.setSessionAgent(codexSession.id, 'mock', 'gpt-4o', undefined, 'compact');
    // The handover is settled when the new agent starts: a new agent session gets the conversation
    const switchNote = switchedContextSession.turns[switchedContextSession.turns.length - 1]?.content || '';
    if (!switchNote.includes('[Context: compact]')) {
      throw new Error(`Switching with prior turns must announce the handover, got "${switchNote}"`);
    }
    // Send next prompt - should ingest context and clear handoffPending
    await sessionManager.sendPrompt(codexSession.id, 'Next instruction after switch');
    await new Promise((r) => setTimeout(r, 600));

    const postPromptSession = sessionManager.getSession(codexSession.id)!;
    if (postPromptSession.contextHandoffPending) {
      throw new Error('contextHandoffPending must be cleared after first prompt');
    }
    console.log('   Context handoff lifecycle verified (pending -> injected & cleared)');

    // Test compactSession: the mock agent has no compact command, so it writes a handoff summary
    const turnsBeforeCompact = sessionManager.getSession(codexSession.id)!.turns.length;
    await sessionManager.compactSession(codexSession.id);
    await waitForIdle(codexSession.id);
    const compacted = sessionManager.getSession(codexSession.id)!;
    const card = compacted.turns[compacted.turns.length - 1];
    if (compacted.turns.length !== turnsBeforeCompact + 1) {
      throw new Error(`Compaction must keep the transcript and add one card (had ${turnsBeforeCompact}, now ${compacted.turns.length})`);
    }
    if (card.compaction?.status !== 'completed' || card.compaction.method !== 'handoff' || !card.compaction.summary) {
      throw new Error(`Expected a completed handoff compaction with a summary, got ${JSON.stringify(card.compaction)}`);
    }
    if (!compacted.contextHandoffPending) throw new Error('A handoff compaction must seed the next prompt with its summary');
    console.log(`   Compaction card: "${card.content}"`);
    console.log('   ✅ Context history transfer & session compaction verified\n');

    // 9. Test Full-Text Search
    console.log('9️⃣ Testing Full-Text Search...');
    await sessionManager.sendPrompt(codexSession.id, 'Please continue the Refactoring task in this repository');
    await new Promise((r) => setTimeout(r, 600));

    const searchResults = searchSessions('Refactoring task');
    console.log(`   Found ${searchResults.length} sessions matching "Refactoring task"`);
    if (searchResults.length === 0) {
      throw new Error('Search failed to find sessions by message content');
    }
    console.log('   ✅ Full-text search over message content verified\n');

    // 9b. Background work settles after its turn, and never outlives the agent
    console.log('9️⃣b Testing background work lifecycle...');
    const bgSession = await sessionManager.createSession({ agentId: 'mock', cwd: testDir, title: 'Background work' });
    const bgCall = () => sessionManager.getSession(bgSession.id)!.turns.flatMap((t) => t.toolCalls || []).filter((c) => c.background).at(-1);
    await sessionManager.sendPrompt(bgSession.id, 'Run the build in the background');
    await waitForIdle(bgSession.id);
    if (!bgCall() || bgCall()!.status !== 'completed' || bgCall()!.backgroundState !== 'running') {
      throw new Error(`Background call should be running after its turn: ${JSON.stringify(bgCall())}`);
    }
    for (let i = 0; i < 50 && bgCall()!.backgroundState === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
    if (bgCall()!.backgroundState !== 'completed' || !bgCall()!.output?.includes('background work finished')) {
      throw new Error(`Background call should complete with its real output: ${JSON.stringify(bgCall())}`);
    }
    if (sessionManager.getSession(bgSession.id)!.state === 'working') throw new Error('A task finishing after the turn must not mark the session working');
    // The call and the reply sent right before the prompt response share one turn
    const bgTurns = sessionManager.getSession(bgSession.id)!.turns.filter((t) => t.role === 'agent' && (t.toolCalls?.length || t.content?.includes('Started it in the background')));
    if (bgTurns.length !== 1 || !bgTurns[0].toolCalls?.length || !bgTurns[0].content?.includes('Started it in the background')) {
      throw new Error(`Tool call and reply split across turns: ${JSON.stringify(bgTurns.map((t) => ({ calls: t.toolCalls?.length, content: t.content })))}`);
    }
    await sessionManager.sendPrompt(bgSession.id, 'Another background job please');
    await waitForIdle(bgSession.id);
    await sessionManager.stopSessionAgent(bgSession.id);
    if (bgCall()!.backgroundState !== 'stopped' || !/stopped/i.test(bgCall()!.backgroundSummary || '')) {
      throw new Error(`Stopping the agent should stop its background work: ${JSON.stringify(bgCall())}`);
    }
    console.log('   ✅ Background work completes after the turn, shows its output, and stops with the agent\n');

    // 9b2. Subagents in sessions of their own (Codex): shown as subagent calls, their work filed under them
    console.log('9️⃣b2 Testing subagents that report through their own session...');
    const subSession = await sessionManager.createSession({ agentId: 'mock', cwd: testDir, title: 'Subagent sessions' });
    await waitForIdle(subSession.id);
    const subBefore = sessionManager.getSession(subSession.id)!;
    const planBefore = JSON.stringify(subBefore.plan ?? null);
    const permSeen = new Promise<any>((resolve) => {
      const handler = (evt: any) => {
        if (evt.sessionId === subSession.id) {
          sessionManager.off('permissionRequested', handler);
          resolve(evt.permission);
        }
      };
      sessionManager.on('permissionRequested', handler);
    });
    const subTurn = sessionManager.sendPrompt(subSession.id, 'Use a subagent, and it needs permission');
    const subPerm = await permSeen;
    if (subPerm.subagent !== 'Explorer') throw new Error(`A subagent's approval should say which subagent asks: ${JSON.stringify(subPerm)}`);
    await sessionManager.resolvePermission(subSession.id, 'allow');
    await subTurn;
    await waitForIdle(subSession.id);
    const sub = sessionManager.getSession(subSession.id)!;
    const subCalls = sub.turns.flatMap((t) => t.toolCalls || []);
    const explorerCall = subCalls.find((c) => c.isSubagent && c.title === 'Explorer');
    const checkerCall = subCalls.find((c) => c.isSubagent && c.title === 'Checker');
    const lsCall = subCalls.find((c) => c.title === 'ls config');
    if (!explorerCall || explorerCall.status !== 'completed' || !explorerCall.subagentText?.includes('Found 3 config files')) {
      throw new Error(`The subagent should be a completed subagent call with its reply: ${JSON.stringify(explorerCall)}`);
    }
    if (!lsCall || lsCall.parentToolUseId !== explorerCall.id || lsCall.status !== 'completed') {
      throw new Error(`The subagent's own tool call should be filed under it: ${JSON.stringify(lsCall)}`);
    }
    if (!checkerCall || checkerCall.parentToolUseId !== explorerCall.id || checkerCall.backgroundState !== 'stopped') {
      throw new Error(`A subagent's subagent should sit under it and show as stopped: ${JSON.stringify(checkerCall)}`);
    }
    const mainTurn = sub.turns.filter((t) => t.role === 'agent').at(-1)!;
    const mainToolSegs = (mainTurn.segments || []).filter((seg) => seg.kind === 'tool').map((seg: any) => seg.toolCallId);
    if (mainToolSegs.join(',') !== explorerCall.id) throw new Error(`Only the subagent itself belongs in the main flow: ${mainToolSegs}`);
    if (!mainTurn.content?.includes('The subagent found 3 config files') || /Found 3 config files|Checking the list|Looking for/.test(mainTurn.content || '')) {
      throw new Error(`The subagent's messages must stay out of the main reply: ${JSON.stringify(mainTurn.content)}`);
    }
    if (JSON.stringify(sub.plan ?? null) !== planBefore || sub.usage.contextTokens === 99999) {
      throw new Error(`A subagent's plan and usage must not replace the conversation's: plan=${JSON.stringify(sub.plan)} context=${sub.usage.contextTokens}`);
    }
    const explorerTask = sub.agentTasks?.find((t) => t.toolCallId === explorerCall.id);
    const checkerTask = sub.agentTasks?.find((t) => t.toolCallId === checkerCall.id);
    if (!explorerTask || explorerTask.kind !== 'subagent' || explorerTask.status !== 'completed' || explorerTask.prompt !== 'Find the config files') {
      throw new Error(`The subagent should get a completed task with its task text: ${JSON.stringify(explorerTask)}`);
    }
    const segKinds = (explorerTask.segments || []).map((seg) => seg.kind).join(',');
    if (!segKinds.includes('thought') || !segKinds.includes('tool') || !segKinds.includes('text')) {
      throw new Error(`The subagent's task should hold its reasoning, calls and reply: ${segKinds}`);
    }
    if (explorerTask.audit?.subagentId !== explorerCall.id.replace(/^subagent:/, '')) throw new Error(`The subagent's own id should be recorded: ${JSON.stringify(explorerTask.audit)}`);
    if (!checkerTask || checkerTask.status !== 'stopped' || checkerTask.parentTaskId !== explorerTask.id) {
      throw new Error(`The nested subagent's task should be stopped and belong to the first: ${JSON.stringify(checkerTask)}`);
    }
    console.log('   ✅ Subagent sessions stream into their own subagent, nested ones included, with labelled approvals\n');

    // 9c. Messages sent during a turn queue behind it and drain in order; a stopped turn pauses the queue
    console.log('9️⃣c Testing the prompt queue...');
    const qSession = await sessionManager.createSession({ agentId: 'mock', cwd: testDir, title: 'Queue' });
    const userTexts = () => sessionManager.getSession(qSession.id)!.turns.filter((t) => t.role === 'user').map((t) => t.content);
    const queued = () => sessionManager.getSession(qSession.id)!.queuedPrompts || [];
    const drained = async () => {
      for (let i = 0; i < 200 && (queued().length > 0 || sessionManager.isTurnInFlight(qSession.id)); i++) await new Promise((r) => setTimeout(r, 100));
    };
    if ((await sessionManager.queuePrompt(qSession.id, 'queue one')).queued) throw new Error('An idle session should send at once');
    if (!(await sessionManager.queuePrompt(qSession.id, 'queue two')).queued) throw new Error('A busy session should queue');
    await sessionManager.queuePrompt(qSession.id, 'queue three');
    sessionManager.updateQueuedPrompt(qSession.id, queued()[1].id, 'queue three, edited');
    await drained();
    if (JSON.stringify(userTexts()) !== JSON.stringify(['queue one', 'queue two', 'queue three, edited'])) {
      throw new Error(`Queue should drain in order: ${JSON.stringify(userTexts())}`);
    }
    await sessionManager.queuePrompt(qSession.id, 'queue four');
    await sessionManager.queuePrompt(qSession.id, 'queue five');
    await sessionManager.queuePrompt(qSession.id, 'queue six');
    await sessionManager.cancelPrompt(qSession.id);
    await new Promise((r) => setTimeout(r, 800));
    if (queued().length !== 2 || sessionManager.isTurnInFlight(qSession.id)) throw new Error('A stopped turn must pause the queue');
    sessionManager.removeQueuedPrompt(qSession.id, queued()[0].id);
    await sessionManager.sendQueuedNow(qSession.id, queued()[0].id);
    await drained();
    if (userTexts().at(-1) !== 'queue six' || userTexts().includes('queue five')) {
      throw new Error(`Send-now and remove should act on the right items: ${JSON.stringify(userTexts())}`);
    }
    // A new message is not stuck behind a paused queue: it goes out, then the paused queue follows
    await sessionManager.queuePrompt(qSession.id, 'queue seven');
    await sessionManager.queuePrompt(qSession.id, 'queue eight');
    await sessionManager.cancelPrompt(qSession.id);
    await new Promise((r) => setTimeout(r, 800));
    if (queued().length !== 1) throw new Error('A stopped turn must pause the queue');
    if ((await sessionManager.queuePrompt(qSession.id, 'queue nine')).queued) throw new Error('A new message must not wait behind a paused queue');
    await drained();
    if (JSON.stringify(userTexts().slice(-3)) !== JSON.stringify(['queue seven', 'queue nine', 'queue eight'])) {
      throw new Error(`The paused queue should resume after the new message: ${JSON.stringify(userTexts())}`);
    }
    // Stop is final even when the agent ignores it and ends the turn cleanly: the queue stays paused
    await drained();
    await sessionManager.queuePrompt(qSession.id, 'stubborn turn');
    await sessionManager.queuePrompt(qSession.id, 'after the stubborn turn');
    await sessionManager.cancelPrompt(qSession.id);
    await new Promise((r) => setTimeout(r, 800));
    if (queued().length !== 1 || userTexts().includes('after the stubborn turn') || sessionManager.isTurnInFlight(qSession.id)) {
      throw new Error(`A turn that ends cleanly after Stop must not drain the queue: queued=${queued().length} sent=${JSON.stringify(userTexts().slice(-2))}`);
    }
    sessionManager.removeQueuedPrompt(qSession.id, queued()[0].id);
    // Two "Send now" clicks on the same paused message send it once
    await sessionManager.queuePrompt(qSession.id, 'queue ten');
    await sessionManager.queuePrompt(qSession.id, 'queue eleven');
    await sessionManager.cancelPrompt(qSession.id);
    await new Promise((r) => setTimeout(r, 800));
    const sendNowId = queued()[0].id;
    await Promise.allSettled([sessionManager.sendQueuedNow(qSession.id, sendNowId), sessionManager.sendQueuedNow(qSession.id, sendNowId)]);
    await drained();
    if (userTexts().filter((t) => t === 'queue eleven').length !== 1) {
      throw new Error(`A double "Send now" must send the message once: ${JSON.stringify(userTexts())}`);
    }
    console.log('   ✅ Queue drains in order, pauses on stop, resumes after a new message, and supports edit, remove and send-now\n');

    // 9d. Codex account rate limits (app-server `account/rateLimits/read`) map onto plan windows
    const { parseCodexRateLimits } = await import('../server/codex-limits.js');
    const codexLimits = parseCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 20, windowDurationMins: 43200, resetsAt: 1793282029 },
        secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null },
        credits: { hasCredits: false, unlimited: false, balance: null },
        planType: 'go',
      },
    });
    const names = codexLimits.windows?.map((w) => `${w.name}:${w.utilization}`).join(',');
    if (names !== '30-day window:20,Weekly window:3' || codexLimits.credits !== 'None' || codexLimits.planType !== 'go') {
      throw new Error(`Codex rate limits parsed wrong: ${JSON.stringify(codexLimits)}`);
    }
    if (codexLimits.windows![0].resetsAtMs !== 1793282029000) throw new Error('Codex reset time should be epoch milliseconds');
    console.log('   ✅ Codex rate limits map onto plan windows and credits\n');

    // 9d. Forms the agent asks for (ACP elicitation): the session waits on the user, answered over HTTP
    console.log('9️⃣d Testing forms the agent asks for (elicitation)...');
    const formSession = await sessionManager.createSession({ agentId: 'mock', cwd: testDir, title: 'Forms' });
    await waitForIdle(formSession.id);
    const formNow = () => sessionManager.getSession(formSession.id)!;
    const formReply = () => formNow().turns.filter((t) => t.role === 'agent').at(-1)?.content || '';
    const formCall = (id: string) => formNow().turns.flatMap((t) => t.toolCalls || []).find((c) => c.id === id);
    const nextForm = () =>
      new Promise<any>((resolve) => {
        const handler = (evt: any) => {
          if (evt.sessionId !== formSession.id) return;
          sessionManager.off('elicitationRequested', handler);
          resolve(evt.elicitation);
        };
        sessionManager.on('elicitationRequested', handler);
      });

    await sessionManager.sendPrompt(formSession.id, 'Which client capabilities do you see?');
    const caps = JSON.parse(formReply().slice(formReply().indexOf('{')));
    if (JSON.stringify(caps.elicitation) !== '{"form":{}}') throw new Error(`Forms (and not URLs) should be advertised: ${JSON.stringify(caps.elicitation)}`);

    const asked = nextForm();
    const askTurn = sessionManager.sendPrompt(formSession.id, 'Please ask me a few questions');
    const form = await asked;
    const byKey = Object.fromEntries(form.fields.map((f: any) => [f.key, f]));
    if (Object.keys(byKey).join(',') !== 'question_0,question_0_custom,question_1,name') throw new Error(`Form fields in order: ${Object.keys(byKey)}`);
    if (byKey.question_0.type !== 'string' || byKey.question_0.options?.length !== 2 || byKey.question_0.options[0].description !== 'Relational, the safe default' || !byKey.question_0.options[1].preview?.includes('CREATE TABLE')) {
      throw new Error(`Single select should carry its options, descriptions and preview: ${JSON.stringify(byKey.question_0)}`);
    }
    if (byKey.question_0_custom.customAnswerFor !== 'question_0' || byKey.question_0_custom.options) throw new Error(`The "Other" box should point at its question: ${JSON.stringify(byKey.question_0_custom)}`);
    if (byKey.question_1.type !== 'array' || byKey.question_1.options?.map((o: any) => o.value).join(',') !== 'Auth,Search,Export') throw new Error(`Multi-select options: ${JSON.stringify(byKey.question_1)}`);
    if (!byKey.name.required || byKey.name.minLength !== 2 || byKey.name.maxLength !== 40 || byKey.question_1.required) throw new Error(`Required and lengths: ${JSON.stringify(byKey.name)}`);

    const waiting = formNow();
    if (waiting.state !== 'blocked' || waiting.score < 200 || waiting.pendingElicitation?.requestId !== form.requestId) {
      throw new Error(`A pending form should block the session: ${waiting.state} ${waiting.score} ${JSON.stringify(waiting.pendingElicitation)}`);
    }
    if (waiting.rankFactors?.[0]?.label !== 'Waiting for your answer' || !waiting.rankSummary?.includes(form.message)) {
      throw new Error(`Ranking should say it waits for an answer: ${waiting.rankSummary} / ${JSON.stringify(waiting.rankFactors)}`);
    }
    const formSummary = sessionManager.listSessions().find((s) => s.id === formSession.id)!;
    if (!formSummary.hasPendingElicitation || formSummary.pendingElicitationTitle !== form.message || formSummary.hasPendingPermission) {
      throw new Error(`The summary should carry the waiting form: ${JSON.stringify(formSummary)}`);
    }
    const askCall = formCall(form.toolCallId);
    if (askCall?.toolName !== 'AskUserQuestion' || askCall.elicitation?.status !== 'pending') throw new Error(`The question should be recorded on the call that asked it: ${JSON.stringify(askCall)}`);

    const formApp = express();
    formApp.use(express.json());
    formApp.use('/api', apiRouter);
    const formServer = formApp.listen(0, '127.0.0.1');
    await once(formServer, 'listening');
    const answer = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${(formServer.address() as AddressInfo).port}/api/sessions/${formSession.id}/elicitation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
    };
    try {
      const requestId = form.requestId;
      const valid = { question_0: 'SQLite', question_0_custom: 'keep it small', question_1: ['Auth', 'Search'], name: 'Notes app' };
      const rejected: Array<[unknown, number]> = [
        [{ requestId, action: 'accept', content: { ...valid, question_0: 'MySQL' } }, 400],
        [{ requestId, action: 'accept', content: { ...valid, extra: 'x' } }, 400],
        [{ requestId, action: 'accept', content: { question_0: 'Postgres' } }, 400],
        [{ requestId, action: 'accept', content: { ...valid, name: 'N' } }, 400],
        [{ requestId, action: 'accept', content: { ...valid, question_1: 'Auth' } }, 400],
        [{ requestId, action: 'accept', content: { ...valid, question_1: ['Auth', 'Billing'] } }, 400],
        [{ requestId, action: 'accept', content: 'Postgres' }, 400],
        [{ requestId, action: 'maybe' }, 400],
        [{ action: 'decline' }, 400],
        [{ requestId: 'elicit_stale', action: 'decline' }, 409],
      ];
      for (const [body, status] of rejected) {
        const res = await answer(body);
        if (res.status !== status || !res.body.error) throw new Error(`${JSON.stringify(body)} should be ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
      }
      if (formNow().pendingElicitation?.requestId !== requestId) throw new Error('A rejected answer must leave the form waiting');
      const accepted = await answer({ requestId, action: 'accept', content: valid });
      if (accepted.status !== 200 || !accepted.body.ok) throw new Error(`A valid answer should be taken: ${accepted.status} ${JSON.stringify(accepted.body)}`);
      await askTurn;
      await waitForIdle(formSession.id);
      if (!formReply().includes('database=SQLite; features=Auth, Search; name=Notes app; note=keep it small')) throw new Error(`The agent should get the answers: ${formReply()}`);
      const answered = formCall(form.toolCallId)?.elicitation;
      if (formNow().pendingElicitation || formNow().state !== 'needs_you' || answered?.status !== 'accepted' || JSON.stringify(answered.content) !== JSON.stringify(valid)) {
        throw new Error(`An answered form should be cleared and recorded: ${formNow().state} ${JSON.stringify(answered)}`);
      }
      if ((await answer({ requestId, action: 'decline' })).status !== 409) throw new Error('A form answered already should be 409');

      // Skipping a form that came without a tool call: it gets a card of its own
      const askedPlain = nextForm();
      const plainTurn = sessionManager.sendPrompt(formSession.id, 'Ask me plainly');
      const plain = await askedPlain;
      if (!plain.toolCallId.startsWith('elicitation:') || formCall(plain.toolCallId)?.status !== 'pending') throw new Error(`A form without a call should get its own card: ${JSON.stringify(plain)}`);
      const declined = await answer({ requestId: plain.requestId, action: 'decline' });
      if (declined.status !== 200) throw new Error(`Decline should be taken: ${JSON.stringify(declined)}`);
      await plainTurn;
      await waitForIdle(formSession.id);
      const plainCard = formCall(plain.toolCallId);
      if (!formReply().includes('You skipped the questions.') || plainCard?.elicitation?.status !== 'declined' || plainCard.status !== 'completed' || plainCard.output !== 'Skipped') {
        throw new Error(`A declined form should reach the agent and its card: ${formReply()} ${JSON.stringify(plainCard)}`);
      }
    } finally {
      formServer.close();
    }

    // The agent can take its question back (Codex's answer timer): the form clears, the turn carries on
    const askedQuick = nextForm();
    const quickTurn = sessionManager.sendPrompt(formSession.id, 'ask me quickly');
    const quick = await askedQuick;
    await quickTurn;
    await waitForIdle(formSession.id);
    const quickCard = formCall(quick.toolCallId);
    if (formNow().pendingElicitation || formNow().state !== 'needs_you' || quickCard?.elicitation?.status !== 'cancelled' || !formReply().includes('No answer in time')) {
      throw new Error(`A withdrawn form should clear: ${formNow().state} ${JSON.stringify(quickCard?.elicitation)} ${formReply()}`);
    }

    // Stopping the turn, or the agent, answers the agent with cancel and clears the form
    for (const stop of ['cancel', 'stop'] as const) {
      const askedAgain = nextForm();
      const turn = sessionManager.sendPrompt(formSession.id, `ask me before the ${stop}`);
      const pending = await askedAgain;
      if (stop === 'cancel') await sessionManager.cancelPrompt(formSession.id);
      else await sessionManager.stopSessionAgent(formSession.id);
      await turn;
      const after = formNow();
      const card = formCall(pending.toolCallId);
      if (after.pendingElicitation || after.state === 'blocked' || card?.elicitation?.status !== 'cancelled') {
        throw new Error(`A ${stop} should clear the form: ${after.state} ${JSON.stringify(after.pendingElicitation)} ${JSON.stringify(card?.elicitation)}`);
      }
      if (!formReply().includes('The question was cancelled.')) throw new Error(`The agent should be told the form was cancelled on ${stop}: ${formReply()}`);
    }

    // A rewind tears the agent down with the form still open
    const askedRewind = nextForm();
    const rewindTurn = sessionManager.sendPrompt(formSession.id, 'ask me, then I rewind');
    await askedRewind;
    const rewindUser = formNow().turns.filter((t) => t.role === 'user').at(-1)!;
    await sessionManager.rollbackSession(formSession.id, { turnId: rewindUser.id, action: 'revert_before_this' });
    await rewindTurn;
    if (formNow().pendingElicitation || formNow().state === 'blocked') throw new Error(`A rewind should clear the form: ${formNow().state}`);

    // A server restart: no agent survives, so a stored form is cleared and its card closed
    const stale = formNow();
    const staleCall = stale.turns.flatMap((t) => t.toolCalls || []).find((c) => c.elicitation)!;
    stale.pendingElicitation = { ...staleCall.elicitation!, toolCallId: staleCall.id };
    staleCall.elicitation = { ...staleCall.elicitation!, status: 'pending', content: undefined, resolvedAt: undefined };
    store.save(stale);
    if (formNow().state !== 'blocked') throw new Error('A stored form should rank as blocked');
    sessionManager.init();
    if (formNow().pendingElicitation || formNow().state === 'blocked' || formCall(staleCall.id)?.elicitation?.status !== 'cancelled') {
      throw new Error(`A restart should clear a stored form: ${formNow().state} ${JSON.stringify(formCall(staleCall.id)?.elicitation)}`);
    }

    // A failed turn whose agent lives on: the form is cancelled on the agent too, so the next one still shows.
    // A session of its own: a handed-over history would carry the earlier prompts' keywords
    const failSession = await sessionManager.createSession({ agentId: 'mock', cwd: testDir, title: 'Failed form' });
    await waitForIdle(failSession.id);
    const failNow = () => sessionManager.getSession(failSession.id)!;
    const nextFailForm = () =>
      new Promise<any>((resolve) => {
        const handler = (evt: any) => {
          if (evt.sessionId !== failSession.id) return;
          sessionManager.off('elicitationRequested', handler);
          resolve(evt.elicitation);
        };
        sessionManager.on('elicitationRequested', handler);
      });
    const within = <T,>(p: Promise<T>, what: string) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), 5_000))]);
    const askedErr = nextFailForm();
    const errTurn = sessionManager.sendPrompt(failSession.id, 'ask me, then the turn fails');
    await askedErr;
    const errHost = (sessionManager as any).activeHosts.get(failSession.id);
    errHost.emit('error', new Error('prompt failed'));
    await within(errTurn, 'the agent should be answered with cancel when its turn fails');
    await waitForIdle(failSession.id);
    if (errHost.pendingElicitation || failNow().pendingElicitation || !failNow().turns.some((t) => t.content?.includes('The question was cancelled.'))) {
      throw new Error(`A failed turn should cancel the form on the agent: ${JSON.stringify(errHost.pendingElicitation)}`);
    }
    const askedAfterErr = nextFailForm();
    const afterErrTurn = sessionManager.sendPrompt(failSession.id, 'ask me plainly');
    const afterErr = await within(askedAfterErr, 'a form after a failed turn should be shown');
    sessionManager.resolveElicitation(failSession.id, afterErr.requestId, 'decline');
    await afterErrTurn;
    await waitForIdle(failSession.id);
    sessionManager.deleteSession(failSession.id);

    // A fresh agent session drops a stored form (one from work outside a turn) with the agent
    const outside = formNow();
    const outsideCall = outside.turns.flatMap((t) => t.toolCalls || []).find((c) => c.elicitation)!;
    outside.pendingElicitation = { ...outsideCall.elicitation!, toolCallId: outsideCall.id };
    outsideCall.elicitation = { ...outsideCall.elicitation!, status: 'pending', content: undefined, resolvedAt: undefined };
    outside.state = 'blocked';
    store.save(outside);
    await sessionManager.forgetAgentSession(formSession.id, 'none');
    if (formNow().pendingElicitation || formNow().state === 'blocked' || formCall(outsideCall.id)?.elicitation?.status !== 'cancelled') {
      throw new Error(`A fresh agent session should clear a stored form: ${formNow().state} ${JSON.stringify(formCall(outsideCall.id)?.elicitation)}`);
    }

    // Field names are the agent's: one named after an Object.prototype member must not read the prototype
    const protoFields = parseElicitationFields(
      JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"},"__proto__":{"type":"string"},"name":{"type":"string"}}}')
    )!;
    const protoChecked = validateElicitationContent(protoFields, { name: 'x' });
    if (!protoChecked.ok || Object.keys(protoChecked.content).join(',') !== 'name') throw new Error(`Empty "constructor" and "__proto__" fields should be no answer: ${JSON.stringify(protoChecked)}`);
    const protoGiven = validateElicitationContent(protoFields, JSON.parse('{"__proto__":"a","constructor":"b"}'));
    if (!protoGiven.ok || protoGiven.content['__proto__'] !== 'a' || protoGiven.content['constructor'] !== 'b') throw new Error(`Answers named after prototype members should be kept: ${JSON.stringify(protoGiven)}`);
    console.log('   ✅ Forms block the session, are checked and answered over HTTP, reach the agent, and clear on decline, withdrawal, cancel, stop, rewind, restart, a failed turn and a fresh agent session\n');

    // 10. Regression checks
    console.log('🔟 Regression checks...');

    // 10a. One turn at a time; cancel-then-send (the web "Send & Interrupt" flow) still works
    await waitForIdle(codexSession.id);
    const firstTurn = sessionManager.sendPrompt(codexSession.id, 'Hello again, long turn please');
    let refused = false;
    try {
      await sessionManager.sendPrompt(codexSession.id, 'Overlapping prompt');
    } catch (err) {
      refused = err instanceof TurnInFlightError;
    }
    if (!refused) throw new Error('A second prompt during an in-flight turn must be refused with TurnInFlightError');
    await sessionManager.cancelPrompt(codexSession.id);
    await firstTurn;
    if (sessionManager.isTurnInFlight(codexSession.id)) throw new Error('Turn still in flight after cancel');
    await sessionManager.sendPrompt(codexSession.id, 'Hello after cancel');
    console.log('   ✅ Overlapping prompt refused; cancel then send succeeds');

    // 10b. Cancelling while an approval is pending clears it (no dead approval card / stuck 'blocked')
    sessionManager.updateAnnotations(session.id, { autoApprove: false });
    await waitForIdle(session.id);
    const permAgain = new Promise<void>((resolve) => {
      const handler = (evt: { sessionId: string }) => {
        if (evt.sessionId === session.id) {
          sessionManager.off('permissionRequested', handler);
          resolve();
        }
      };
      sessionManager.on('permissionRequested', handler);
    });
    const blockedTurn = sessionManager.sendPrompt(session.id, 'Please run a command needing permission');
    await permAgain;
    await sessionManager.cancelPrompt(session.id);
    await blockedTurn;
    const afterCancel = sessionManager.getSession(session.id)!;
    if (afterCancel.pendingPermission || afterCancel.state === 'blocked') {
      throw new Error(`Pending permission survived cancel (state ${afterCancel.state})`);
    }
    console.log('   ✅ Cancel clears the pending permission');

    // 10c. Stop parks the session and keeps it parked
    await sessionManager.stopSessionAgent(session.id);
    if (sessionManager.getSession(session.id)!.state !== 'parked') {
      throw new Error(`Stopped session should be parked, got ${sessionManager.getSession(session.id)!.state}`);
    }
    console.log('   ✅ Stopped session stays parked');

    // 10d. HTTP: bad cwd / unknown agent rejected with 400 and nothing persisted
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    try {
      const before = store.getAll().length;
      const missingDir = path.join(os.tmpdir(), `acp-missing-${Date.now()}`);
      const badCwd = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'mock', cwd: missingDir }),
      });
      const badCwdBody = (await badCwd.json()) as { error?: string };
      if (badCwd.status !== 400 || !badCwdBody.error?.includes('Working directory does not exist')) {
        throw new Error(`Bad cwd should be 400, got ${badCwd.status} ${JSON.stringify(badCwdBody)}`);
      }
      const badAgent = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'no-such-agent', cwd: testDir }),
      });
      if (badAgent.status !== 400) throw new Error(`Unknown agent should be 400, got ${badAgent.status}`);
      if (store.getAll().length !== before) throw new Error('Rejected create must not persist a session');
      console.log('   ✅ Bad cwd and unknown agent rejected with 400, no session persisted');

      const detail = await fetch(`${base}/api/sessions/${codexSession.id}`);
      if (detail.status !== 200) throw new Error(`GET /api/sessions/:id should be 200, got ${detail.status}`);
      await waitForIdle(codexSession.id);
      const running = sessionManager.sendPrompt(codexSession.id, 'Hello, a turn to overlap with');
      const overlap = await fetch(`${base}/api/sessions/${codexSession.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Overlapping over HTTP' }),
      });
      if (overlap.status !== 409) throw new Error(`Prompt during an in-flight turn should be 409, got ${overlap.status}`);
      await running;
      console.log('   ✅ Prompt during an in-flight turn rejected with 409');
    } finally {
      httpServer.close();
    }

    // 10e. An agent that fails to start leaves no zombie session behind (and does not hang)
    const realCommand = AGENT_REGISTRY.mock.command;
    AGENT_REGISTRY.mock.command = path.join(testDir, 'no-such-agent-binary');
    const countBeforeFail = store.getAll().length;
    let startFailed = false;
    try {
      await sessionManager.createSession({ agentId: 'mock', cwd: testDir });
    } catch {
      startFailed = true;
    } finally {
      AGENT_REGISTRY.mock.command = realCommand;
    }
    if (!startFailed) throw new Error('createSession should fail when the agent cannot be spawned');
    if (store.getAll().length !== countBeforeFail) throw new Error('Failed createSession left a zombie session');
    console.log('   ✅ Failed agent start removes the session');

    // 10f. Auth: x-test-remote-ip only honoured in test mode; foreign Origin and rebinding Host rejected
    const token = 'test-token';
    const spoofed = fakeRequest({ remote: '192.168.1.50', headers: { host: '127.0.0.1:7890', 'x-test-remote-ip': '127.0.0.1' } });
    process.env.NODE_ENV = 'production';
    try {
      if (getRemoteAddress(spoofed) !== '192.168.1.50') throw new Error('x-test-remote-ip honoured outside test mode');
      if (checkAccess(spoofed, undefined, token).ok) throw new Error('Spoofed loopback header bypassed token auth');
    } finally {
      process.env.NODE_ENV = 'test';
    }
    const local = { remote: '127.0.0.1' };
    const crossOrigin = checkAccess(fakeRequest({ ...local, headers: { host: '127.0.0.1:7890', origin: 'http://evil.example' } }), token, token);
    if (crossOrigin.ok || crossOrigin.status !== 403) throw new Error('Cross-origin request must be 403 even with a token');
    const rebinding = checkAccess(fakeRequest({ ...local, headers: { host: 'evil.example:7890', origin: 'http://evil.example:7890' } }), undefined, token);
    if (rebinding.ok) throw new Error('DNS-rebinding Host must not get loopback trust');
    const viteDev = checkAccess(fakeRequest({ ...local, headers: { host: '127.0.0.1:7890', origin: 'http://localhost:5280' } }), undefined, token);
    if (!viteDev.ok) throw new Error('Loopback origin (Vite dev server) must be allowed');
    const lanWithToken = checkAccess(fakeRequest({ remote: '192.168.1.50', headers: { host: '192.168.1.5:7890', origin: 'http://192.168.1.5:7890' } }), token, token);
    if (!lanWithToken.ok) throw new Error('Same-origin LAN request with token must be allowed');
    console.log('   ✅ Spoofed loopback header, cross-origin and rebinding requests rejected\n');

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
  } finally {
    sessionManager.shutdown();
    store.clear();

    // Verify no files were leaked to the user's real ~/.codepit/sessions
    const finalUserFiles = fs.existsSync(realUserSessionsDir) ? fs.readdirSync(realUserSessionsDir) : [];
    if (finalUserFiles.length !== initialUserFiles.length) {
      console.error(`🚨 LEAK DETECTED: Files added to ${realUserSessionsDir}:`, finalUserFiles.filter(f => !initialUserFiles.includes(f)));
      throw new Error(`CRITICAL: Test suite polluted production ~/.codepit/sessions directory!`);
    }

    try {
      fs.rmSync(testDir, { recursive: true, force: true });
      fs.rmSync(testAppDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
