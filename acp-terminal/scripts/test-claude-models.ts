import { sessionManager } from '../server/acp/session-mgr.js';
import { store } from '../server/store.js';

async function testModels() {
  const modelsToTest = ['default', 'sonnet', 'opus', 'haiku'];

  for (const model of modelsToTest) {
    console.log(`\n================ Testing Claude model: "${model}" ================`);
    const session = await sessionManager.createSession({
      agentId: 'claude',
      cwd: process.cwd(),
      title: `Claude Test ${model}`,
      model: model === 'default' ? undefined : model,
    });

    console.log(`Created session ${session.id} (model: ${session.model})`);

    let responseText = '';
    const listener = (ev: any) => {
      if (ev.sessionId === session.id && ev.type === 'message') {
        responseText += ev.text || '';
      }
    };
    sessionManager.on('sessionStream', listener);

    try {
      await sessionManager.sendPrompt(session.id, 'Say: Model test passed!');
      console.log(`✅ Success for model "${model}":`, responseText.slice(0, 100));
    } catch (err: any) {
      console.error(`❌ Failed for model "${model}":`, err.message);
    } finally {
      sessionManager.off('sessionStream', listener);
      sessionManager.deleteSession(session.id);
    }
  }
  process.exit(0);
}

testModels().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
