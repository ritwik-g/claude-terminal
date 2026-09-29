import { sessionManager } from '../server/acp/session-mgr.js';
import { store } from '../server/store.js';

async function testClaude() {
  console.log('Testing Claude ACP agent...');
  const session = await sessionManager.createSession({
    agentId: 'claude',
    cwd: process.cwd(),
    title: 'Claude Test',
    // Let's test with no model or default model
  });

  console.log('Created Claude session:', session.id, 'with model:', session.model);

  sessionManager.on('sessionStream', (ev) => {
    if (ev.sessionId === session.id) {
      console.log(`[Stream ${ev.type}]`, ev.text || (ev.turn ? `Turn len ${ev.turn.content?.length}` : ''));
    }
  });

  console.log('Sending prompt to Claude...');
  try {
    await sessionManager.sendPrompt(session.id, 'Say hello in 3 words');
    console.log('sendPrompt completed.');
  } catch (err) {
    console.error('sendPrompt threw:', err);
  }

  const updated = store.get(session.id);
  console.log('Session state:', updated?.state);
  console.log('Turns:', updated?.turns.map(t => ({ role: t.role, content: t.content?.slice(0, 100) })));
  
  // Clean up
  sessionManager.deleteSession(session.id);
  process.exit(0);
}

testClaude().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
