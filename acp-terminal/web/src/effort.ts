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
