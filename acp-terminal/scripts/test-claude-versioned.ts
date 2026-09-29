import { sessionManager } from '../server/acp/session-mgr.js';

async function testAdditional() {
  const models = ['claude-opus-4-6', 'claude-opus-4-5', 'claude-haiku-4-5'];
  for (const m of models) {
    console.log(`Testing ${m}...`);
    try {
      const s = await sessionManager.createSession({ agentId: 'claude', cwd: process.cwd(), model: m });
      let text = '';
      sessionManager.on('sessionStream', (e) => { if (e.sessionId === s.id && e.type === 'message') text += e.text || ''; });
      await sessionManager.sendPrompt(s.id, 'Respond with: "OK"');
      console.log(`✅ ${m}:`, text.slice(0, 80));
      sessionManager.deleteSession(s.id);
    } catch (err: any) {
      console.log(`❌ ${m}:`, err.message);
    }
  }
  process.exit(0);
}
testAdditional();
