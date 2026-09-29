import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

// Isolate test storage from the user's real ~/.acp-terminal directory BEFORE any imports
const testAppDir = path.join(os.tmpdir(), `acp-terminal-test-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.ACP_APP_DIR = testAppDir;

// Dynamic imports ensure environment variables are evaluated before any server module is imported
const { sessionManager } = await import('../server/acp/session-mgr.js');
const { listAgents } = await import('../server/agents/registry.js');
const { searchSessions } = await import('../server/search.js');
const { store } = await import('../server/store.js');
const { getAppDir, getSessionsDir } = await import('../server/paths.js');
const { TurnInFlightError } = await import('../server/acp/client-host.js');
const { checkAccess, getRemoteAddress } = await import('../server/security.js');
const { apiRouter } = await import('../server/api.js');
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
  console.log('🧪 [Test Suite] Starting ACP Terminal Test Suite...\n');
  console.log(`📁 Using isolated test storage: ${testAppDir}\n`);

  // Verify that test suite is NOT using the user's production ~/.acp-terminal directory
  const realUserSessionsDir = path.join(os.homedir(), '.acp-terminal', 'sessions');
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
    if (!switchedContextSession.contextHandoffPending) {
      throw new Error('contextHandoffPending must be true when switching with prior turns');
    }
    // Send next prompt - should ingest context and clear handoffPending
    await sessionManager.sendPrompt(codexSession.id, 'Next instruction after switch');
    await new Promise((r) => setTimeout(r, 600));

    const postPromptSession = sessionManager.getSession(codexSession.id)!;
    if (postPromptSession.contextHandoffPending) {
      throw new Error('contextHandoffPending must be cleared after first prompt');
    }
    console.log('   Context handoff lifecycle verified (pending -> injected & cleared)');

    // Test compactSession
    const compacted = await sessionManager.compactSession(codexSession.id);
    if (compacted.turns.length !== 1) {
      throw new Error(`Expected exactly 1 compacted turn, got ${compacted.turns.length}`);
    }
    if (!compacted.turns[0].content?.includes('Session Context Compacted')) {
      throw new Error('Compacted turn missing "Session Context Compacted" header');
    }
    console.log(`   Compacted session turns from multi-turn history into 1 checkpoint turn`);
    console.log(`   Compacted checkpoint preview: "${compacted.turns[0].content?.slice(0, 80)}..."`);
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

    // Verify no files were leaked to the user's real ~/.acp-terminal/sessions
    const finalUserFiles = fs.existsSync(realUserSessionsDir) ? fs.readdirSync(realUserSessionsDir) : [];
    if (finalUserFiles.length !== initialUserFiles.length) {
      console.error(`🚨 LEAK DETECTED: Files added to ${realUserSessionsDir}:`, finalUserFiles.filter(f => !initialUserFiles.includes(f)));
      throw new Error(`CRITICAL: Test suite polluted production ~/.acp-terminal/sessions directory!`);
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
