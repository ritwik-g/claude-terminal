import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, FILE_MODE, getAppDir, getSettingsFile } from '../paths.js';
import { getAgent } from '../agents/registry.js';
import { AUTO_EFFORT, type AgentOptions, type ConfigChoice } from '../types.js';

/**
 * Effort and model choices come from the agent (ACP `configOptions`), not from a
 * fixed list: Claude offers low..max per model (none on Haiku), Codex adds
 * `ultra` on some models. This module reads those options, maps the app's
 * 'auto' onto them, and remembers the last-seen set per agent and model so the
 * picker has real choices before a session starts.
 */

// Option ids agents use for effort when they don't set the thought_level category
const EFFORT_OPTION_IDS = ['effort', 'reasoning_effort', 'thinking_effort', 'thought_level', 'reasoning'];
// Rows that mean "the agent's own default" rather than a level
const DEFAULT_EFFORT_VALUES = ['default', 'auto'];

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** "xhigh" becomes "Extra high"; unknown levels keep the agent's own name. */
export function effortLabel(value: string, agentName?: string): string {
  const known = EFFORT_LABELS[value.toLowerCase()];
  if (known) return known;
  if (agentName && agentName.trim()) return agentName.trim();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Values of a select option, flattening ACP option groups. */
function selectChoices(option: any): ConfigChoice[] {
  if (!Array.isArray(option?.options)) return [];
  const flat: any[] = option.options.flatMap((o: any) => (Array.isArray(o?.options) ? o.options : [o]));
  return flat
    .filter((o) => typeof o?.value === 'string' && o.value)
    .map((o) => ({
      value: o.value,
      label: typeof o.name === 'string' && o.name ? o.name : o.value,
      ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
      ...(typeof o._meta?.kind === 'string' ? { kind: o._meta.kind } : {}),
    }));
}

function findOption(options: any[], category: string, ids: string[]): any | undefined {
  const selects = options.filter((o) => o && typeof o.id === 'string' && (o.type === 'select' || Array.isArray(o.options)));
  return selects.find((o) => o.category === category) ?? selects.find((o) => ids.includes(o.id));
}

/** AIR extension: the value the agent recommends, at `_meta.jetbrains.air.recommendedValue`. */
function recommendedValue(option: any): string | undefined {
  const v = option?._meta?.jetbrains?.air?.recommendedValue;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Read the effort and model options out of an ACP `configOptions` list. Null when
 * the agent sent no list at all; an empty result when it sent one without them
 * (the model has no effort setting, e.g. Claude Haiku).
 */
export function parseAgentOptions(configOptions: unknown, now = Date.now()): AgentOptions | null {
  if (!Array.isArray(configOptions)) return null;
  const opts: AgentOptions = { efforts: [], models: [], updatedAt: now };

  const effort = findOption(configOptions, 'thought_level', EFFORT_OPTION_IDS);
  if (effort) {
    opts.effortConfigId = effort.id;
    for (const choice of selectChoices(effort)) {
      if (DEFAULT_EFFORT_VALUES.includes(choice.value.toLowerCase())) {
        opts.effortDefaultValue = choice.value;
      } else {
        opts.efforts.push({ ...choice, label: effortLabel(choice.value, choice.label) });
      }
    }
    if (typeof effort.currentValue === 'string') opts.currentEffort = effort.currentValue;
    const recommended = recommendedValue(effort);
    if (recommended && opts.efforts.some((e) => e.value === recommended)) opts.recommendedEffort = recommended;
  }

  const model = findOption(configOptions, 'model', ['model']);
  if (model) {
    opts.modelConfigId = model.id;
    opts.models = selectChoices(model).filter((m) => m.value !== 'default');
    if (typeof model.currentValue === 'string') opts.currentModel = model.currentValue;
  }

  const mode = findOption(configOptions, 'mode', ['mode']);
  if (mode) {
    opts.modeConfigId = mode.id;
    opts.modes = selectChoices(mode);
    if (typeof mode.currentValue === 'string') opts.currentMode = mode.currentValue;
  }

  // Claude's Fast mode: an on/off select (a boolean option only goes to clients that ask for one)
  const fast = configOptions.find((o: any) => o?.id === 'fast' && Array.isArray(o.options));
  const fastValues = fast ? selectChoices(fast).map((c) => c.value) : [];
  if (fast && fastValues.includes('on') && fastValues.includes('off')) {
    opts.fast = {
      configId: fast.id,
      enabled: fast.currentValue === 'on',
      onValue: 'on',
      offValue: 'off',
      ...(typeof fast.description === 'string' && fast.description ? { description: fast.description } : {}),
    };
  }
  return opts;
}

/**
 * The effort value to send to the agent, or none. 'auto' maps to the agent's own
 * "default" row; with `live` (undoing an explicit level on a running agent) it
 * falls back to the level the agent recommends, since sending nothing would keep
 * the old level. `supported` is false for a level this model does not offer.
 */
export function effortToSend(
  effort: string | undefined,
  opts: AgentOptions | null | undefined,
  live = false
): { value?: string; supported: boolean } {
  if (!effort || effort === AUTO_EFFORT) {
    if (!opts?.effortConfigId) return { supported: true };
    const value = opts.effortDefaultValue ?? (live ? opts.recommendedEffort : undefined);
    return { value, supported: true };
  }
  if (!opts) return { value: effort, supported: true };
  const supported = opts.efforts.some((e) => e.value === effort);
  return { value: supported ? effort : undefined, supported };
}

// "claude-opus-4-6", "Opus 4.6" and "opus-4.6" all reduce to "opus46"
const squash = (v: string) => v.toLowerCase().replace(/^(claude|gpt)[-\s]+/, '').replace(/[^a-z0-9[\]]/g, '');

/** Canonical context hint: "sonnet-1m" and "sonnet[1m]" are the same model. */
const canonicalModel = (v: string) => v.trim().toLowerCase().replace(/-(\d+m)$/, '[$1]');

/**
 * The advertised model value matching a stored model id, or undefined. Stored ids
 * can be older spellings ("6-luna" for Codex's "gpt-6-luna").
 */
export function resolveModelValue(model: string | undefined, choices: ConfigChoice[]): string | undefined {
  if (!model || choices.length === 0) return undefined;
  const exact = choices.find((c) => c.value === model);
  if (exact) return exact.value;
  const canon = canonicalModel(model);
  const canonical = choices.find((c) => canonicalModel(c.value) === canon);
  if (canonical) return canonical.value;
  const squashed = squash(canon);
  return choices.find((c) => squash(canonicalModel(c.value)) === squashed || squash(c.label) === squashed)?.value;
}

/** Model ids that name a 1M-token context variant: "opus[1m]", "claude-sonnet-5-1m". */
export function contextWindowHint(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase().match(/(?:\[(\d+)m\]|-(\d+)m)$/);
  if (!m) return undefined;
  return Number(m[1] ?? m[2]) * 1_000_000;
}

// Effort values are short identifiers; anything else is a client bug, not a level
const EFFORT_VALUE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function isEffortValue(v: unknown): v is string {
  return typeof v === 'string' && EFFORT_VALUE.test(v);
}

/** Null when `effort` may be used with these choices, else the reason it can't. */
export function effortError(effort: unknown, choices: ConfigChoice[]): string | null {
  if (!isEffortValue(effort)) return 'effort must be a short level name such as auto, low or high';
  if (effort === AUTO_EFFORT) return null;
  if (choices.some((c) => c.value === effort)) return null;
  if (choices.length === 0) return 'this model has no effort setting; use auto';
  return `effort must be one of ${[AUTO_EFFORT, ...choices.map((c) => c.value)].join(', ')}`;
}

// ---------------------------------------------------------------------------
// Last-seen options per agent and model, kept in the app dir
// ---------------------------------------------------------------------------

type OptionsCache = Record<string, Record<string, AgentOptions>>;
let cache: OptionsCache | null = null;
let cacheDir: string | null = null;

const cacheFile = () => path.join(getAppDir(), 'agent-options.json');

function loadCache(): OptionsCache {
  // Tests switch CODEPIT_APP_DIR between runs; reload when it moves
  if (cache && cacheDir === getAppDir()) return cache;
  cacheDir = getAppDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache!;
}

/** Remember what the agent advertised, under the stored model id and the one the agent reports. */
export function rememberAgentOptions(agentId: string, model: string | undefined, opts: AgentOptions): void {
  const all = loadCache();
  const byModel = (all[agentId] = all[agentId] || {});
  for (const key of new Set([model, opts.currentModel].filter((k): k is string => Boolean(k)))) {
    byModel[key] = opts;
  }
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[agent-options] Could not save ${cacheFile()}: ${err.message}`);
  }
}

// A model the agent started offering this recently gets a "New" badge
const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;
type FirstSeen = Record<string, Record<string, number>>;
const firstSeenFile = () => path.join(getAppDir(), 'models-first-seen.json');

/**
 * Mark the models first seen in the last two weeks as new. The first list ever seen from
 * an agent is the baseline, so only models added after it count (stored as 0 otherwise).
 */
export function markNewModels(agentId: string, opts: AgentOptions, now = Date.now()): AgentOptions {
  let seen: FirstSeen = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(firstSeenFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) seen = parsed;
  } catch {
    // no record yet
  }
  const baseline = !seen[agentId];
  const byModel = (seen[agentId] ??= {});
  let changed = baseline;
  for (const m of opts.models) {
    if (byModel[m.value] === undefined) {
      byModel[m.value] = baseline ? 0 : now;
      changed = true;
    }
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(firstSeenFile()), { recursive: true });
      fs.writeFileSync(firstSeenFile(), JSON.stringify(seen, null, 2), { mode: 0o600 });
    } catch (err: any) {
      console.warn(`[agent-options] Could not save ${firstSeenFile()}: ${err.message}`);
    }
  }
  return {
    ...opts,
    models: opts.models.map((m) => {
      const { isNew: _stale, ...rest } = m;
      return byModel[m.value] > 0 && now - byModel[m.value] < NEW_FOR_MS ? { ...rest, isNew: true } : rest;
    }),
  };
}

/** Everything the agent advertised, keyed by model id (for the /agents listing). */
export function advertisedOptions(agentId: string): Record<string, AgentOptions> | undefined {
  const byModel = loadCache()[agentId];
  return byModel && Object.keys(byModel).length > 0 ? byModel : undefined;
}

export function cachedAgentOptions(agentId: string, model: string | undefined): AgentOptions | undefined {
  const byModel = loadCache()[agentId];
  if (!byModel) return undefined;
  if (model && byModel[model]) return byModel[model];
  const key = resolveModelValue(model, Object.keys(byModel).map((value) => ({ value, label: value })));
  return key ? byModel[key] : undefined;
}

/**
 * The effort levels to offer for an agent and model: what the running session
 * reported, else the cached report for that model, else the registry's fallback.
 */
export function effortChoicesFor(agentId: string, model: string | undefined, sessionOptions?: AgentOptions): ConfigChoice[] {
  if (sessionOptions) return sessionOptions.efforts;
  const cached = cachedAgentOptions(agentId, model);
  if (cached) return cached.efforts;
  return getAgent(agentId).efforts ?? [];
}

// ---------------------------------------------------------------------------
// Favourite models, as "<agentId>:<model>", kept in settings.json so every device shares them
// ---------------------------------------------------------------------------

const FAVORITE = /^[a-z0-9._-]{1,64}:[^\s]{1,128}$/i;

export function isFavoriteList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && FAVORITE.test(x));
}

export function readFavoriteModels(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return isFavoriteList(parsed?.favoriteModels) ? parsed.favoriteModels : [];
  } catch {
    return [];
  }
}

export function writeFavoriteModels(list: string[]): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed;
  } catch {
    // no settings yet
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, favoriteModels: [...new Set(list)] }, null, 2), { mode: FILE_MODE });
}
