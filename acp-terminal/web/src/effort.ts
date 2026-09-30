import type { AcpSession, AgentDescriptor, AgentOptions, ConfigChoice } from './types';

/**
 * Effort and model choices as the agent advertised them. The running session's
 * report wins, then what the agent last reported for that model, then the
 * registry's fallback list.
 */

export const AUTO_EFFORT = 'auto';

const EFFORT_LABELS: Record<string, string> = {
  auto: 'Auto',
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

/** "xhigh" reads "Extra high"; unknown levels keep the agent's label. */
export function effortLabel(value: string | undefined, choices: ConfigChoice[] = []): string {
  if (!value) return 'Auto';
  return EFFORT_LABELS[value.toLowerCase()] || choices.find((c) => c.value === value)?.label || value;
}

const canonical = (v: string) => v.trim().toLowerCase().replace(/-(\d+m)$/, '[$1]');

/** The cached report for an agent and model, matching "6-luna" to "gpt-6-luna" loosely. */
export function advertisedFor(agent: AgentDescriptor | undefined, model: string | undefined): AgentOptions | undefined {
  const byModel = agent?.advertised;
  if (!byModel || !model) return undefined;
  if (byModel[model]) return byModel[model];
  const key = Object.keys(byModel).find((k) => canonical(k) === canonical(model));
  return key ? byModel[key] : undefined;
}

/** Effort levels (without Auto) for an agent and model. Empty means the model has no effort setting. */
export function effortChoices(
  agent: AgentDescriptor | undefined,
  model: string | undefined,
  sessionOptions?: AgentOptions
): ConfigChoice[] {
  if (sessionOptions) return sessionOptions.efforts;
  return advertisedFor(agent, model)?.efforts ?? agent?.efforts ?? [];
}

/** Effort levels for the session's current agent and model. */
export function sessionEffortChoices(session: AcpSession, agents: AgentDescriptor[]): ConfigChoice[] {
  const agent = agents.find((a) => a.id === session.agentId);
  return effortChoices(agent, session.model || agent?.defaultModel, session.agentOptions);
}

/**
 * The models to offer for an agent: what the running session's agent reported,
 * then what it last advertised (so 1M-context variants and new models show up),
 * else the registry list.
 */
export function modelChoices(agent: AgentDescriptor, sessionOptions?: AgentOptions): ConfigChoice[] {
  if (sessionOptions && sessionOptions.models.length > 0) return sessionOptions.models;
  const reports = Object.values(agent.advertised || {}).sort((a, b) => b.updatedAt - a.updatedAt);
  const models = reports.find((r) => r.models.length > 0)?.models;
  if (models) return models;
  return (agent.availableModels || []).map((value) => ({ value, label: value }));
}

/** True when `a` and `b` name the same model ("6-luna" and "gpt-6-luna" count as one). */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const squash = (v: string) => canonical(v).replace(/^(claude|gpt)-/, '');
  return squash(a) === squash(b);
}

/** The agent's own name for the running model ("Opus 5.5"), when it reported one. */
export function advertisedModelLabel(session: AcpSession): string | undefined {
  const opts = session.agentOptions;
  if (!opts?.currentModel) return undefined;
  return opts.models.find((m) => m.value === opts.currentModel)?.label;
}

// ------------------------------------------------------------------ Model families

/** "opus[1m]" and "claude-sonnet-5-1m" are the 1M-context variants of "opus" and "claude-sonnet-5". */
const CONTEXT_SUFFIX = /(?:\[(\d+)m\]|-(\d+)m)$/i;

/** The model without its context-size suffix. */
export function baseModel(value: string): string {
  return value.replace(CONTEXT_SUFFIX, '');
}

/** The context window a model id names (1M for "opus[1m]"), if it names one. */
export function contextOfModel(value: string): number | undefined {
  const m = value.match(CONTEXT_SUFFIX);
  return m ? Number(m[1] ?? m[2]) * 1_000_000 : undefined;
}

/** A model's family and version from its label: "Opus 5.5" is opus 5.5, "GPT-5.3 Codex" is gpt codex 5.3. */
function familyOf(choice: ConfigChoice): { family: string; version: number[] } | null {
  const text = (choice.label !== choice.value ? choice.label : choice.value).replace(/(\d)-(\d)/g, '$1.$2');
  const m = text.match(/(\d+(?:\.\d+)*)/);
  if (!m) return null;
  const family = text.replace(m[1], ' ').toLowerCase().replace(/^claude\b/, '').replace(/[^a-z]+/g, ' ').trim();
  return { family, version: m[1].split('.').map(Number) };
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

/**
 * Split an agent's models into current and legacy: a model is legacy when the agent also
 * offers a newer version of the same family (Opus 5 next to Opus 5.5). Context variants
 * ("opus[1m]") are folded into their base model; the effort menu offers the window size.
 */
export function splitModels(models: ConfigChoice[]): { current: ConfigChoice[]; legacy: ConfigChoice[] } {
  const bases = new Map<string, ConfigChoice>();
  for (const m of models) {
    const base = baseModel(m.value);
    // Keep the plain model when both are offered; a lone variant stands in for its base
    if (!bases.has(base) || !contextOfModel(m.value)) {
      if (!bases.has(base) || contextOfModel(bases.get(base)!.value)) bases.set(base, m);
    }
  }
  const list = [...bases.values()];
  const newest = new Map<string, number[]>();
  for (const m of list) {
    const f = familyOf(m);
    if (f && (!newest.has(f.family) || newer(f.version, newest.get(f.family)!))) newest.set(f.family, f.version);
  }
  const current: ConfigChoice[] = [];
  const legacy: ConfigChoice[] = [];
  for (const m of list) {
    const f = familyOf(m);
    (f && newer(newest.get(f.family)!, f.version) ? legacy : current).push(m);
  }
  return { current, legacy };
}

/** The context sizes offered for a model: its base and every "[Nm]" variant the agent lists. */
export function contextChoices(models: ConfigChoice[], model: string | undefined): Array<{ value: string; tokens?: number }> {
  if (!model) return [];
  const base = baseModel(model);
  const variants = models.filter((m) => baseModel(m.value) === base);
  if (variants.length < 2) return [];
  return variants.map((m) => ({ value: m.value, tokens: contextOfModel(m.value) }));
}
