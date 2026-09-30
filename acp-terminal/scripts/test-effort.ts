import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Effort and model choices come from the agent: option parsing, 'auto' mapping,
 * validation, the per-model cache, and (against a scripted agent) live effort and
 * model changes that keep the agent process and its conversation.
 */

// Isolate test storage from the user's real ~/.codepit directory BEFORE any imports
const testAppDir = path.join(os.tmpdir(), `codepit-effort-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
process.env.NODE_ENV = 'test';
process.env.CODEPIT_APP_DIR = testAppDir;

const {
  parseAgentOptions,
  effortToSend,
  effortError,
  effortLabel,
  resolveModelValue,
  contextWindowHint,
  rememberAgentOptions,
  cachedAgentOptions,
  effortChoicesFor,
} = await import('../server/acp/agent-options.js');
const { normalizeClaudeModel } = await import('../server/acp/client-host.js');
const { reconcileEffort, sessionManager } = await import('../server/acp/session-mgr.js');
const { AGENT_REGISTRY } = await import('../server/agents/registry.js');
const { getPricingForModel } = await import('../server/subscriptions.js');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`   ok  ${name}`);
  } else {
    failures++;
    console.log(`   FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}

// What claude-agent-acp 0.81 sends for Opus (trimmed): a "default" row, then low..max
const CLAUDE_OPTIONS = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'opus',
    options: [
      { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
      { value: 'opus', name: 'Opus 5.5', description: 'For complex work' },
      { value: 'claude-fable-5-1', name: 'Fable 5.1' },
      { value: 'haiku', name: 'Haiku 4.5' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, name: v === 'xhigh' ? 'Xhigh' : v })),
  },
  { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'select', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
];

// What codex-acp 1.13 sends: 'reasoning_effort', no default row, a recommended value in AIR meta
const CODEX_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5.6-terra',
    options: [
      { value: 'gpt-6-luna', name: '6 Luna' },
      { value: 'gpt-5.6-terra', name: '5.6 Terra' },
    ],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Xhigh' },
      { value: 'max', name: 'Max' },
      { value: 'ultra', name: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
    ],
    _meta: { jetbrains: { air: { version: 1, recommendedValue: 'medium' } } },
  },
];

function unitTests(): void {
  console.log('1. Parsing advertised options');
  check('no list means nothing advertised', parseAgentOptions(undefined) === null);

  const claude = parseAgentOptions(CLAUDE_OPTIONS)!;
  check('Claude effort option found by category', claude.effortConfigId === 'effort');
  check('Claude levels exclude the default row', claude.efforts.map((e) => e.value).join() === 'low,medium,high,xhigh,max', claude.efforts);
  check('Claude default row kept for auto', claude.effortDefaultValue === 'default');
  check('xhigh reads "Extra high"', claude.efforts.find((e) => e.value === 'xhigh')?.label === 'Extra high');
  check('Claude models exclude the default row', claude.models.map((m) => m.value).join() === 'opus,claude-fable-5-1,haiku');
  check('Claude current model', claude.currentModel === 'opus');

  const codex = parseAgentOptions(CODEX_OPTIONS)!;
  check('Codex effort option found by category', codex.effortConfigId === 'reasoning_effort');
  check('Codex offers ultra', codex.efforts.some((e) => e.value === 'ultra'));
  check('Codex has no default row', codex.effortDefaultValue === undefined);
  check('Codex recommended value read from AIR meta', codex.recommendedEffort === 'medium');

  // Found by id when the agent sets no category; option groups are flattened
  const byId = parseAgentOptions([
    { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ group: 'g', name: 'G', options: [{ value: 'low', name: 'Low' }, { value: 'minimal', name: 'Minimal' }] }] },
  ])!;
  check('effort found by id, groups flattened', byId.effortConfigId === 'reasoning_effort' && byId.efforts.length === 2, byId);

  const haiku = parseAgentOptions(CLAUDE_OPTIONS.filter((o) => o.id !== 'effort'))!;
  check('a model without an effort option has no levels', haiku.efforts.length === 0 && !haiku.effortConfigId);

  console.log('2. Mapping auto and levels onto the agent');
  check('auto -> Claude default row', effortToSend('auto', claude).value === 'default');
  check('auto at start on Codex sends nothing', effortToSend('auto', codex).value === undefined);
  check('auto live on Codex -> recommended level', effortToSend('auto', codex, true).value === 'medium');
  check('xhigh on Claude sent as is', effortToSend('xhigh', claude).value === 'xhigh');
  check('ultra not offered by Claude', effortToSend('ultra', claude).supported === false);
  check('unknown agent options: level passed through', effortToSend('high', null).value === 'high');
  check('auto with no effort option sends nothing', effortToSend('auto', haiku).value === undefined);

  console.log('3. Validation');
  check('auto always valid', effortError('auto', []) === null);
  check('advertised level valid', effortError('xhigh', claude.efforts) === null);
  check('unadvertised level rejected', effortError('ultra', claude.efforts) !== null);
  check('any level rejected when the model has none', /no effort setting/.test(effortError('high', []) || ''));
  check('garbage rejected', effortError('high; rm -rf', claude.efforts) !== null && effortError(42, claude.efforts) !== null);
  check('labels', effortLabel('max') === 'Max' && effortLabel('turbo', 'Turbo mode') === 'Turbo mode');

  console.log('4. Model ids');
  const codexModels = codex.models;
  check('Codex "6-luna" resolves to "gpt-6-luna"', resolveModelValue('6-luna', codexModels) === 'gpt-6-luna');
  check('unknown model resolves to nothing', resolveModelValue('gpt-4o', codexModels) === undefined);
  check('-1m and [1m] are the same variant', resolveModelValue('sonnet-1m', [{ value: 'sonnet[1m]', label: 'Sonnet (1M context)' }]) === 'sonnet[1m]');
  check('[1m] means a 1M window', contextWindowHint('opus[1m]') === 1_000_000 && contextWindowHint('claude-sonnet-5-1m') === 1_000_000);
  check('plain ids have no hint', contextWindowHint('opus') === undefined);
  check('normalize keeps the 1M variant', normalizeClaudeModel('opus[1m]') === 'opus[1m]' && normalizeClaudeModel('claude-sonnet-5-1m') === 'claude-sonnet-5[1m]');
  check('normalize keeps full Claude ids', normalizeClaudeModel('claude-sonnet-5') === 'claude-sonnet-5' && normalizeClaudeModel('claude-fable-5-1') === 'claude-fable-5-1');
  check('normalize still maps legacy UI ids', normalizeClaudeModel('opus-5.5') === 'opus' && normalizeClaudeModel('haiku-4.5') === 'claude-haiku-4-5');
  check('table: Opus 5.5 has a 1M window', getPricingForModel('opus').contextWindow === 1_000_000);
  check('table: Haiku 4.5 has 200k', getPricingForModel('claude-haiku-4-5').contextWindow === 200_000);
  check('price: the "haiku" alias is not taken for Claude 3.5 Haiku', getPricingForModel('haiku').inputPerMillion === 1);
  check('price: "claude-opus-5" is not taken for Opus 5.5', getPricingForModel('claude-opus-5').inputPerMillion === 5);
  check('price: a dated id still finds its row', getPricingForModel('claude-haiku-4-5-20251001').inputPerMillion === 1);

  console.log('5. Options cache and fallbacks');
  check('registry fallback before any report', effortChoicesFor('claude', 'opus').length === 5);
  check('antigravity bridge offers no effort', effortChoicesFor('antigravity', 'gemini-3.8-flash').length === 0);
  rememberAgentOptions('claude', 'haiku', haiku);
  rememberAgentOptions('codex', '6-luna', { ...codex, currentModel: 'gpt-6-luna' });
  check('cached Haiku report wins over the registry', effortChoicesFor('claude', 'haiku').length === 0);
  check('cached under the reported id too', cachedAgentOptions('codex', 'gpt-6-luna') !== undefined);
  check('cache written to the app dir', fs.existsSync(path.join(testAppDir, 'agent-options.json')));
  check('the running session report wins', effortChoicesFor('claude', 'haiku', claude).length === 5);

  console.log('6. Reconciling a stored effort with a new model');
  const s: any = { effort: 'xhigh', model: 'haiku', agentName: 'Claude', turns: [] };
  const note = reconcileEffort(s, { ...haiku, currentModel: 'haiku' });
  check('unsupported level falls back to auto', s.effort === 'auto');
  check('and says so', /Haiku 4.5 has no effort setting, so effort is back to Auto/.test(note?.content || ''), note?.content);
  const s2: any = { effort: 'high', turns: [] };
  check('supported level stands', reconcileEffort(s2, claude) === null && s2.effort === 'high');
}

// ---------------------------------------------------------------------------
// Live changes against the scripted agent
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const TSX_BIN = path.resolve(here, '../node_modules/.bin/tsx');

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

async function liveTests(): Promise<void> {
  AGENT_REGISTRY.efforttest = {
    id: 'efforttest',
    name: 'Effort test agent',
    provider: 'mock',
    description: 'Scripted agent for test-effort',
    command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
    args: [path.join(here, 'lib/effort-test-agent.ts')],
    icon: 'mock',
    defaultModel: 'big',
    availableModels: ['big', 'small'],
    efforts: [],
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-effort-ws-'));
  const session = await sessionManager.createSession({ agentId: 'efforttest', cwd, model: 'big' });
  const id = session.id;

  console.log('7. Live effort change keeps the process and conversation');
  const first = await ask(id, 'remember the word pineapple');
  const s1 = sessionManager.getSession(id)!;
  check('advertised levels stored on the session', s1.agentOptions?.efforts.map((e) => e.value).join() === 'low,medium,high,xhigh,max', s1.agentOptions);
  check('auto started on the agent default', field(first, 'effort') === 'default', first);
  check('reported window stored', s1.contextWindow === 200_000, s1.contextWindow);

  await sessionManager.setSessionEffort(id, 'xhigh');
  const second = await ask(id, 'what was the word?');
  check('effort applied without a restart', field(second, 'effort') === 'xhigh', second);
  check('same agent process', field(second, 'pid') === field(first, 'pid'), { first, second });
  check('conversation kept', field(second, 'seen') === '2' && field(second, 'first') === 'remember', second);

  await sessionManager.setSessionEffort(id, 'auto');
  const third = await ask(id, 'again');
  check('auto maps back to the default row', field(third, 'effort') === 'default', third);

  console.log('8. Live model switch keeps the process; unsupported effort falls back to Auto');
  await sessionManager.setSessionEffort(id, 'max');
  await sessionManager.setSessionAgent(id, 'efforttest', 'big[1m]', 'max');
  const fourth = await ask(id, 'bigger window');
  const s4 = sessionManager.getSession(id)!;
  check('model switched live', field(fourth, 'model') === 'big[1m]' && field(fourth, 'pid') === field(first, 'pid'), fourth);
  check('no handover needed', !s4.contextHandoffPending && field(fourth, 'seen') === '4', fourth);
  check('1M window reported', s4.contextWindow === 1_000_000, s4.contextWindow);
  check('effort carried over', s4.effort === 'max', s4.effort);

  await sessionManager.setSessionAgent(id, 'efforttest', 'small', 'max');
  const s5 = sessionManager.getSession(id)!;
  check('small model has no levels', s5.agentOptions?.efforts.length === 0, s5.agentOptions);
  check('effort back to auto', s5.effort === 'auto', s5.effort);
  check('with a note', s5.turns.some((t) => t.role === 'system' && /Small has no effort setting/.test(t.content || '')));
  let rejected = false;
  try {
    await sessionManager.setSessionAgent(id, 'efforttest', 'nonexistent');
  } catch {
    rejected = true;
  }
  check('a model the agent rejects is an error, not a silent restart', rejected && sessionManager.getSession(id)!.model === 'small');

  console.log('9. Stored for the next start when no agent runs');
  await sessionManager.stopSessionAgent(id);
  await sessionManager.setSessionAgent(id, 'efforttest', 'big');
  await sessionManager.setSessionEffort(id, 'low');
  const sixth = await ask(id, 'after restart');
  check('stored effort applied at start', field(sixth, 'effort') === 'low' && field(sixth, 'model') === 'big', sixth);
  check('new process', field(sixth, 'pid') !== field(first, 'pid'));

  sessionManager.shutdown();
}

try {
  unitTests();
  await liveTests();
} catch (err: any) {
  failures++;
  console.error(err);
} finally {
  sessionManager.shutdown();
  fs.rmSync(testAppDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll effort checks passed');
process.exit(0);
