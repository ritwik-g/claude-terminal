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
  markNewModels,
  launchModelValue,
} = await import('../server/acp/agent-options.js');
const { normalizeClaudeModel } = await import('../server/acp/client-host.js');
const { groupModels } = await import('../server/agents/antigravity-models.js');
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

  // Like claude-agent-acp after resuming a session on a pinned id it does not list
  const pinned = parseAgentOptions([{ id: 'model', category: 'model', type: 'select', currentValue: 'claude-opus-4-6-20251101', options: [{ value: 'opus', name: 'Opus' }] }])!;
  check('an unlisted current model is not added to the list', pinned.currentModel === 'claude-opus-4-6-20251101' && pinned.models.map((m) => m.value).join() === 'opus', pinned.models);

  console.log('1b. Approval modes, fast mode and new models');
  const withModes = parseAgentOptions([
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Manual', _meta: { kind: 'standard' } },
      { value: 'auto', name: 'Auto', description: 'Claude decides', _meta: { kind: 'auto_review' } },
    ] },
    { id: 'fast', category: 'model_config', type: 'select', currentValue: 'on', description: 'Faster', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
  ])!;
  check('modes read with their kind', withModes.modeConfigId === 'mode' && withModes.modes?.map((m) => `${m.value}/${m.kind}`).join() === 'default/standard,auto/auto_review', withModes.modes);
  check('current mode read', withModes.currentMode === 'default');
  check('fast mode read from an on/off select', withModes.fast?.enabled === true && withModes.fast.configId === 'fast', withModes.fast);
  check("Claude's fast option read as off", parseAgentOptions(CLAUDE_OPTIONS)!.fast?.enabled === false);
  check('no fast option, no fast mode', parseAgentOptions(CODEX_OPTIONS)!.fast === undefined);
  const day = 24 * 60 * 60 * 1000;
  const listed = (values: string[]) => ({ efforts: [], models: values.map((value) => ({ value, label: value })), updatedAt: 0 });
  const baseline = markNewModels('newtest', listed(['a', 'b']), 1_000 * day);
  check('the first list seen is the baseline, nothing new', baseline.models.every((m) => !m.isNew));
  const later = markNewModels('newtest', listed(['a', 'b', 'c']), 1_001 * day);
  check('a model added later is new', later.models.find((m) => m.value === 'c')?.isNew === true && !later.models.find((m) => m.value === 'a')?.isNew);
  check('and stops being new after two weeks', !markNewModels('newtest', listed(['a', 'b', 'c']), 1_016 * day).models.some((m) => m.isNew));

  console.log('2. Mapping auto and levels onto the agent');
  check('auto -> Claude default row', effortToSend('auto', claude).value === 'default');
  check('auto at start on Codex sends nothing', effortToSend('auto', codex).value === undefined);
  check('auto live on Codex -> recommended level', effortToSend('auto', codex, true).value === 'medium');
  check('xhigh on Claude sent as is', effortToSend('xhigh', claude).value === 'xhigh');
  check('ultra not offered by Claude', effortToSend('ultra', claude).supported === false);
  check('unknown agent options: level passed through', effortToSend('high', null).value === 'high');
  check('auto with no effort option sends nothing', effortToSend('auto', haiku).value === undefined);

  console.log('2b. Antigravity (agy) models: effort levels are separate models there');
  const agy = groupModels(
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nFetching available models...\n'
  );
  check('agy: one model per family, levels in order', JSON.stringify(agy[0]) === JSON.stringify({ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }));
  check('agy: a model without levels keeps its name', agy[1].value === 'claude-sonnet-4-6' && agy[1].name === 'Claude Sonnet 4.6 (Thinking)' && agy[1].efforts.length === 0);
  check('agy: a single level still counts as one', agy[2].value === 'gpt-oss-120b' && agy[2].efforts.join() === 'medium');
  check('agy: progress lines are skipped', agy.length === 3);

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
  check('antigravity offers agy\'s levels before it reports its own', effortChoicesFor('antigravity', 'gemini-3.8-flash').map((e) => e.value).join() === 'low,medium,high');
  rememberAgentOptions('claude', 'haiku', haiku);
  rememberAgentOptions('codex', '6-luna', { ...codex, currentModel: 'gpt-6-luna' });
  check('cached Haiku report wins over the registry', effortChoicesFor('claude', 'haiku').length === 0);
  check('cached under the reported id too', cachedAgentOptions('codex', 'gpt-6-luna') !== undefined);
  check('cache written to the app dir', fs.existsSync(path.join(testAppDir, 'agent-options.json')));
  check('the running session report wins', effortChoicesFor('claude', 'haiku', claude).length === 5);

  console.log('5b. Which models go in through the launch config');
  AGENT_REGISTRY.launchtest = { ...AGENT_REGISTRY.codex, id: 'launchtest', availableModels: ['6-luna'] };
  const report = (current: string, values: string[]) => ({ efforts: [], models: values.map((value) => ({ value, label: value })), currentModel: current, updatedAt: 0 });
  // An old report still lists gpt-6-luna; the agent has retired it since
  rememberAgentOptions('launchtest', 'gpt-6-mini', report('gpt-6-mini', ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-mini']));
  rememberAgentOptions('launchtest', 'gpt-6-sol', report('gpt-6-sol', ['gpt-6-sol', 'gpt-6-mini']));
  // Like Codex: a custom model it ran is listed as its current one
  rememberAgentOptions('launchtest', 'my-custom', report('my-custom', ['my-custom', 'gpt-6-sol', 'gpt-6-mini']));
  check('a listed model is left to set_config_option', launchModelValue('launchtest', 'gpt-6-sol') === undefined);
  check('so is one listed before and retired since', launchModelValue('launchtest', 'gpt-6-luna') === undefined);
  check('and a registry id', launchModelValue('launchtest', '6-luna') === undefined);
  check('a custom model it ran before goes in at launch', launchModelValue('launchtest', 'my-custom') === 'my-custom');
  check('so does one it never ran', launchModelValue('launchtest', 'brand-new') === 'brand-new');

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

  console.log('9. A reply the agent starts on its own does not swallow the next one');
  await ask(id, 'start work, report-later');
  const deadline = Date.now() + 5_000;
  const hasReport = () => sessionManager.getSession(id)!.turns.some((t) => t.role === 'agent' && t.content?.includes('background report'));
  while (!hasReport() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check('the agent-initiated reply is recorded', hasReport());
  await ask(id, 'next question');
  const turns = sessionManager.getSession(id)!.turns;
  const report = turns.find((t) => t.role === 'agent' && t.content?.includes('background report'))!;
  const question = turns.map((t) => t.role === 'user' && t.content === 'next question').lastIndexOf(true);
  const answer = turns.findIndex((t, i) => i > question && t.role === 'agent');
  check('the reply to the next message is its own turn, after the message', answer > question, turns.map((t) => [t.role, t.content?.slice(0, 30)]));
  check('the earlier reply is left as it was', !report.content!.includes('pid='), report.content);

  console.log('9b. Send now adds a queued message to the running turn instead of stopping it');
  check('steering support read from initialize', sessionManager.getSession(id)!.canSteer === true);
  const slow = sessionManager.sendPrompt(id, 'slow-turn please');
  for (let i = 0; i < 100 && !sessionManager.isTurnInFlight(id); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200)); // let the agent reach its wait
  await sessionManager.queuePrompt(id, 'also check the tests');
  const queuedItem = sessionManager.getSession(id)!.queuedPrompts![0];
  await sessionManager.sendQueuedNow(id, queuedItem.id);
  await slow;
  await waitForIdle(id);
  const after = sessionManager.getSession(id)!;
  const steerAt = after.turns.findIndex((t) => t.role === 'user' && t.content === 'also check the tests');
  const steeredReply = after.turns.findIndex((t) => t.role === 'agent' && t.content?.includes('steered: also check the tests'));
  check('the queue is empty', !after.queuedPrompts?.length, after.queuedPrompts);
  check('the message is in the transcript', steerAt > 0);
  check('the agent answered it within the same turn, below it', steeredReply > steerAt, after.turns.map((t) => [t.role, t.content?.slice(0, 40)]));
  check('the turn was not stopped', !after.turns.some((t) => t.role === 'agent' && /cancel/i.test(t.content || '')) && after.state === 'needs_you', after.state);

  console.log('9c. A message the agent could not take goes back to the queue and is sent next');
  const refusing = sessionManager.sendPrompt(id, 'slow-refuse please');
  for (let i = 0; i < 100 && !sessionManager.isTurnInFlight(id); i++) await new Promise((r) => setTimeout(r, 20));
  await sessionManager.queuePrompt(id, 'send me after');
  await sessionManager.sendQueuedNow(id, sessionManager.getSession(id)!.queuedPrompts![0].id);
  const mid = sessionManager.getSession(id)!;
  check('back at the front of the queue', mid.queuedPrompts?.[0]?.text === 'send me after', mid.queuedPrompts);
  check('not left in the transcript', !mid.turns.some((t) => t.role === 'user' && t.content === 'send me after'));
  await refusing;
  const sentDeadline = Date.now() + 5_000;
  const sentAfter = () => sessionManager.getSession(id)!.turns.some((t) => t.role === 'user' && t.content === 'send me after');
  while (!sentAfter() && Date.now() < sentDeadline) await new Promise((r) => setTimeout(r, 50));
  await waitForIdle(id);
  check('sent as the next prompt once the turn ended', sentAfter() && !sessionManager.getSession(id)!.queuedPrompts?.length);

  console.log('9d. Approval mode, fast mode and the agent\'s commands');
  const live = sessionManager.getSession(id)!;
  check('commands reported by the agent kept on the session', live.agentCommands?.map((c) => c.name).join() === 'review,unstract:review-deep', live.agentCommands);
  check('with their argument hint', live.agentCommands?.[0].hint === '[pr-number]');
  check('modes advertised', live.agentOptions?.modes?.length === 3 && live.agentOptions.currentMode === 'default');
  await sessionManager.setSessionAgent(id, 'efforttest', 'big'); // the small model has no fast mode
  sessionManager.updateAnnotations(id, { autoApprove: true });
  await sessionManager.setSessionMode(id, 'acceptEdits');
  await sessionManager.setSessionFastMode(id, true);
  const moded = await ask(id, 'which mode?');
  check('mode applied to the running agent', field(moded, 'mode') === 'acceptEdits', moded);
  check('fast mode applied to the running agent', field(moded, 'fast') === 'true', moded);
  check('choosing a mode turns off auto-approve', sessionManager.getSession(id)!.user.autoApprove === false);
  check('the agent reports the new mode', sessionManager.getSession(id)!.agentOptions?.currentMode === 'acceptEdits');
  let badMode = false;
  await sessionManager.setSessionMode(id, 'nonsense').catch(() => (badMode = true));
  check('a mode the agent lacks is refused', badMode && sessionManager.getSession(id)!.mode === 'acceptEdits');

  console.log('10. Stored for the next start when no agent runs');
  await sessionManager.stopSessionAgent(id);
  await sessionManager.setSessionAgent(id, 'efforttest', 'big');
  await sessionManager.setSessionEffort(id, 'low');
  const sixth = await ask(id, 'after restart');
  check('stored effort applied at start', field(sixth, 'effort') === 'low' && field(sixth, 'model') === 'big', sixth);
  check('stored mode and fast mode applied at start', field(sixth, 'mode') === 'acceptEdits' && field(sixth, 'fast') === 'true', sixth);
  check('new process', field(sixth, 'pid') !== field(first, 'pid'));

  await customModelTests(cwd);
  sessionManager.shutdown();
}

/** A model id the agent does not list: run through its launch config, or refused and said so. */
async function customModelTests(cwd: string): Promise<void> {
  const lastAgentTurn = (id: string) => [...sessionManager.getSession(id)!.turns].reverse().find((t) => t.role === 'agent');
  const refusedNotes = (id: string) => sessionManager.getSession(id)!.turns.filter((t) => t.role === 'system' && /did not accept model/.test(t.content || ''));

  console.log('11. A custom model the agent takes at launch sticks');
  // Like Codex: unlisted models go in through the launch config env
  AGENT_REGISTRY.efforttestcfg = { ...AGENT_REGISTRY.efforttest, id: 'efforttestcfg', name: 'Config test agent', modelConfigEnv: 'EFFORT_TEST_CONFIG' };
  const cfg = await sessionManager.createSession({ agentId: 'efforttestcfg', cwd, model: 'custom-sol' });
  const c1 = await ask(cfg.id, 'hello custom');
  const cs1 = sessionManager.getSession(cfg.id)!;
  check('the agent runs the custom model', field(c1, 'model') === 'custom-sol', c1);
  check('reported as the current model', cs1.agentOptions?.currentModel === 'custom-sol' && cs1.agentOptions.models.some((m) => m.value === 'custom-sol'), cs1.agentOptions);
  check('the turn is stamped with it', lastAgentTurn(cfg.id)?.model === 'custom-sol', lastAgentTurn(cfg.id)?.model);
  check('no refusal note', refusedNotes(cfg.id).length === 0);
  check('cached under the custom id', cachedAgentOptions('efforttestcfg', 'custom-sol')?.currentModel === 'custom-sol');
  const c2 = await ask(cfg.id, 'second prompt');
  check('still on it for the next prompt', field(c2, 'model') === 'custom-sol' && field(c2, 'pid') === field(c1, 'pid'), c2);
  await sessionManager.stopSessionAgent(cfg.id);
  const c3 = await ask(cfg.id, 'after restart');
  check('and after a restart', field(c3, 'model') === 'custom-sol' && field(c3, 'pid') !== field(c1, 'pid'), c3);
  check('the session keeps it', sessionManager.getSession(cfg.id)!.model === 'custom-sol' && sessionManager.getSession(cfg.id)!.agentOptions?.currentModel === 'custom-sol');
  // A live switch the agent refuses restarts it with the model in its launch config
  await sessionManager.setSessionAgent(cfg.id, 'efforttestcfg', 'big');
  await sessionManager.setSessionAgent(cfg.id, 'efforttestcfg', 'custom-luna');
  const c4 = await ask(cfg.id, 'switched to another custom one');
  check('a live switch to an unlisted model goes through a restart', field(c4, 'model') === 'custom-luna', c4);
  await sessionManager.setSessionAgent(cfg.id, 'efforttestcfg', 'big');
  const c5 = await ask(cfg.id, 'back to a listed one');
  check('a switch back to a listed one stays live', field(c5, 'model') === 'big' && field(c5, 'pid') === field(c4, 'pid'), { c4, c5 });
  // That restart would cut off a running turn: refused until it ends
  const slowCfg = sessionManager.sendPrompt(cfg.id, 'slow-turn please');
  for (let i = 0; i < 100 && !sessionManager.isTurnInFlight(cfg.id); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  let busyError = '';
  await sessionManager.setSessionAgent(cfg.id, 'efforttestcfg', 'custom-mid').catch((err) => (busyError = err.message));
  check('a switch that needs a restart is refused while a turn runs', /current turn/.test(busyError) && sessionManager.isTurnInFlight(cfg.id), busyError);
  check('the session keeps its model', sessionManager.getSession(cfg.id)!.model === 'big', sessionManager.getSession(cfg.id)!.model);
  await sessionManager.cancelPrompt(cfg.id);
  await slowCfg;
  await waitForIdle(cfg.id);
  const c6 = await ask(cfg.id, 'after the refused switch');
  check('the turn was not cut off by a restart', field(c6, 'pid') === field(c5, 'pid') && field(c6, 'model') === 'big', c6);

  console.log('12. A custom model the agent refuses is said once, and turns show what runs');
  const ref = await sessionManager.createSession({ agentId: 'efforttest', cwd, model: 'custom-sol' });
  const r1 = await ask(ref.id, 'hello refused');
  const rs1 = sessionManager.getSession(ref.id)!;
  check('the agent runs its own model', field(r1, 'model') === 'big', r1);
  check('a note says so', refusedNotes(ref.id).length === 1 && /custom-sol.*running Big/.test(refusedNotes(ref.id)[0].content || ''), refusedNotes(ref.id));
  check('the turn is stamped with the model that ran', lastAgentTurn(ref.id)?.model === 'big', lastAgentTurn(ref.id)?.model);
  check('the choice is kept as the requested model', rs1.model === 'custom-sol', rs1.model);
  await ask(ref.id, 'again');
  await sessionManager.stopSessionAgent(ref.id);
  await ask(ref.id, 'after restart');
  check('the note is not repeated', refusedNotes(ref.id).length === 1, refusedNotes(ref.id).length);
  check('later turns stamped with it too', lastAgentTurn(ref.id)?.model === 'big', lastAgentTurn(ref.id)?.model);
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
