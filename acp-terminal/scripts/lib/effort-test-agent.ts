#!/usr/bin/env node
/**
 * A scripted ACP agent for scripts/test-effort.ts. It advertises model and effort
 * config options the way Claude's adapter does (a "default" effort row, levels per
 * model, none on the small model) and answers every prompt with its process id,
 * its current model and effort, and how many prompts it has seen, so a test can
 * tell whether a change kept the process and its conversation. It also takes
 * `_session/steering`: a "slow-turn" prompt waits for a steered message and answers it.
 * With EFFORT_TEST_STATE_DIR set it keeps each session in a file there and offers
 * session/resume, so a new process can continue it; EFFORT_TEST_NO_STEER=1 turns steering off.
 */
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE_DIR = process.env.EFFORT_TEST_STATE_DIR;
const NO_STEER = process.env.EFFORT_TEST_NO_STEER === '1';

const EFFORTS: Record<string, string[]> = {
  big: ['low', 'medium', 'high', 'xhigh', 'max'],
  'big[1m]': ['low', 'medium', 'high', 'xhigh', 'max'],
  small: [],
};

interface State {
  model: string;
  effort: string;
  mode: string;
  fast: boolean;
  prompts: string[];
  resumed?: boolean;
}

const stateFile = (id: string) => path.join(STATE_DIR!, `${id}.json`);

function persist(id: string, s: State): void {
  if (STATE_DIR) fs.writeFileSync(stateFile(id), JSON.stringify({ ...s, resumed: undefined }));
}

const MODES = [
  { value: 'default', name: 'Manual', description: 'Always ask', _meta: { kind: 'standard' } },
  { value: 'acceptEdits', name: 'Accept edits', description: 'Accept file edits', _meta: { kind: 'standard' } },
  { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Accept everything', _meta: { kind: 'full_access' } },
];

const sessions = new Map<string, State>();
// A running "slow-turn" prompt per session, waiting for a steered message (or a cancel)
const steerWaiters = new Map<string, (text: string) => void>();
const cancelled = new Set<string>();

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
  options.unshift({ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode, options: MODES });
  // Like Claude, fast mode only on the models that offer it
  if (s.model.startsWith('big')) {
    options.push({
      id: 'fast',
      name: 'Fast mode',
      description: 'Faster responses',
      category: 'model_config',
      type: 'select',
      currentValue: s.fast ? 'on' : 'off',
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' },
      ],
    });
  }
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
    .onRequest('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, ...(STATE_DIR ? { sessionCapabilities: { resume: {} } } : {}) },
      _meta: NO_STEER ? {} : { steering: { supported: true } },
    }))
    .onRequest('session/resume', (ctx: any) => {
      const { sessionId } = ctx.params;
      if (!STATE_DIR || !fs.existsSync(stateFile(sessionId))) throw acp.RequestError.resourceNotFound(sessionId);
      const saved = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8')) as State;
      // Like both real adapters: the conversation comes back, the approval mode and fast mode do not
      const s: State = { ...saved, mode: 'default', fast: false, resumed: true };
      sessions.set(sessionId, s);
      return { configOptions: configOptions(s) };
    })
    .onRequest('_session/steering', { parse: (p: unknown) => p as any }, (ctx: any) => {
      const { sessionId, prompt } = ctx.params;
      const waiter = steerWaiters.get(sessionId);
      if (!waiter) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
      steerWaiters.delete(sessionId);
      waiter((prompt as any[]).map((b) => b.text || '').join('\n'));
      return { outcome: 'injected' };
    })
    .onRequest('session/new', (ctx: any) => {
      const sessionId = crypto.randomUUID();
      const s: State = { model: 'big', effort: 'default', mode: 'default', fast: false, prompts: [] };
      sessions.set(sessionId, s);
      // Like Claude: the command list (skills included, plugin ones prefixed) follows the new session
      setTimeout(() => {
        void ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'review', description: 'Review the changes', input: { hint: '[pr-number]' } },
              { name: 'unstract:review-deep', description: 'Run the standard review', input: null },
            ],
          },
        });
      }, 50);
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
      } else if (configId === 'mode') {
        if (!MODES.some((m) => m.value === value)) throw acp.RequestError.invalidParams();
        s.mode = value;
      } else if (configId === 'fast') {
        if (value !== 'on' && value !== 'off') throw acp.RequestError.invalidParams();
        s.fast = value === 'on';
      } else if (configId === 'effort') {
        if (value !== 'default' && !EFFORTS[s.model].includes(value)) throw acp.RequestError.invalidParams();
        s.effort = value;
      } else {
        throw acp.RequestError.invalidParams();
      }
      persist(sessionId, s);
      return { configOptions: configOptions(s) };
    })
    .onRequest('session/prompt', async (ctx: any) => {
      const { sessionId, prompt } = ctx.params;
      const s = sessions.get(sessionId)!;
      const text = (prompt as any[]).map((b) => b.text || '').join('\n');
      s.prompts.push(text);
      persist(sessionId, s);
      const send = (update: Record<string, unknown>) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
      await send({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `pid=${process.pid} model=${s.model} effort=${s.effort} mode=${s.mode} fast=${s.fast} seen=${s.prompts.length} resumed=${Boolean(s.resumed)} history=${text.includes('[Prior Conversation Context')} first=${s.prompts[0]} keywords=${(text.match(/\bultra(?:think|code)\b/g) || ['none']).join(',')}`,
        },
      });
      await send({ sessionUpdate: 'usage_update', used: 1000 * s.prompts.length, size: s.model.endsWith('[1m]') ? 1_000_000 : 200_000 });
      // A turn too far along to take a message: steering is refused as if it had ended
      if (text.includes('slow-refuse')) await new Promise((r) => setTimeout(r, 600));
      if (text.includes('slow-turn')) {
        const steered = await new Promise<string>((resolve) => {
          steerWaiters.set(sessionId, resolve);
          setTimeout(() => resolve(''), 5_000);
        });
        steerWaiters.delete(sessionId);
        if (cancelled.delete(sessionId)) return { stopReason: 'cancelled' };
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: steered ? `steered: ${steered}` : 'no steer' } });
      }
      // Like Claude reporting a finished background task: a reply with no prompt behind it
      if (text.includes('report-later')) {
        setTimeout(() => {
          void send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'background report' } });
        }, 100);
      }
      return { stopReason: 'end_turn' };
    })
    // A cancel ends a waiting slow turn at once, as Claude does
    .onNotification('session/cancel', (ctx: any) => {
      const waiter = steerWaiters.get(ctx.params?.sessionId);
      if (!waiter) return;
      cancelled.add(ctx.params.sessionId);
      steerWaiters.delete(ctx.params.sessionId);
      waiter('');
    })
    .connect(stream);
}

main().catch((err) => {
  console.error('[effort-test-agent] Fatal error:', err);
  process.exit(1);
});
