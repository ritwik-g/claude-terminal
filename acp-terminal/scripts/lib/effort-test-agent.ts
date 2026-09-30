#!/usr/bin/env node
/**
 * A scripted ACP agent for scripts/test-effort.ts. It advertises model and effort
 * config options the way Claude's adapter does (a "default" effort row, levels per
 * model, none on the small model) and answers every prompt with its process id,
 * its current model and effort, and how many prompts it has seen, so a test can
 * tell whether a change kept the process and its conversation.
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';

const EFFORTS: Record<string, string[]> = {
  big: ['low', 'medium', 'high', 'xhigh', 'max'],
  'big[1m]': ['low', 'medium', 'high', 'xhigh', 'max'],
  small: [],
};

interface State {
  model: string;
  effort: string;
  prompts: string[];
}

const sessions = new Map<string, State>();

function configOptions(s: State) {
  const options: any[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: s.model,
      options: [
        { value: 'default', name: 'Default (recommended)' },
        { value: 'big', name: 'Big', description: 'The capable one' },
        { value: 'big[1m]', name: 'Big (1M context)', description: 'Big with a 1M window' },
        { value: 'small', name: 'Small', description: 'No effort setting' },
      ],
    },
  ];
  const levels = EFFORTS[s.model];
  if (levels.length > 0) {
    options.push({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: s.effort,
      options: [{ value: 'default', name: 'Default' }, ...levels.map((l) => ({ value: l, name: l }))],
    });
  }
  return options;
}

async function main() {
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  acp
    .agent({ name: 'effort-test-agent' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }))
    .onRequest('session/new', () => {
      const sessionId = crypto.randomUUID();
      const s: State = { model: 'big', effort: 'default', prompts: [] };
      sessions.set(sessionId, s);
      return { sessionId, configOptions: configOptions(s) };
    })
    .onRequest('session/set_config_option', (ctx: any) => {
      const { sessionId, configId, value } = ctx.params;
      const s = sessions.get(sessionId);
      if (!s) throw acp.RequestError.invalidParams();
      if (configId === 'model') {
        if (!(value in EFFORTS)) throw acp.RequestError.invalidParams();
        s.model = value;
        if (!EFFORTS[value].includes(s.effort)) s.effort = 'default';
      } else if (configId === 'effort') {
        if (value !== 'default' && !EFFORTS[s.model].includes(value)) throw acp.RequestError.invalidParams();
        s.effort = value;
      } else {
        throw acp.RequestError.invalidParams();
      }
      return { configOptions: configOptions(s) };
    })
    .onRequest('session/prompt', async (ctx: any) => {
      const { sessionId, prompt } = ctx.params;
      const s = sessions.get(sessionId)!;
      const text = (prompt as any[]).map((b) => b.text || '').join('\n');
      s.prompts.push(text);
      const send = (update: Record<string, unknown>) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
      await send({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `pid=${process.pid} model=${s.model} effort=${s.effort} seen=${s.prompts.length} first=${s.prompts[0]}` },
      });
      await send({ sessionUpdate: 'usage_update', used: 1000 * s.prompts.length, size: s.model.endsWith('[1m]') ? 1_000_000 : 200_000 });
      return { stopReason: 'end_turn' };
    })
    .onNotification('session/cancel', () => {})
    .connect(stream);
}

main().catch((err) => {
  console.error('[effort-test-agent] Fatal error:', err);
  process.exit(1);
});
