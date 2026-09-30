import type { AcpSession } from './types';

export interface ModelPricing {
  contextWindow: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
  /** Which price list the estimate uses, e.g. "Claude Sonnet". */
  basis: string;
}

const price = (
  basis: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cachePerMillion: number,
  contextWindow: number,
): ModelPricing => ({ basis, inputPerMillion, outputPerMillion, cachePerMillion, contextWindow });

const FREE = price('Built-in demo agent', 0, 0, 0, 200_000);
// Current Claude models run a 1M window (Haiku 4.5: 200k); a running agent reports the real one
const CLAUDE_OPUS = price('Claude Opus 5.5', 4, 20, 0.2, 1_000_000);
const CLAUDE_OPUS_5 = price('Claude Opus 5 / 4.x', 5, 25, 0.5, 1_000_000);
const CLAUDE_OPUS_45 = price('Claude Opus 4.5', 15, 75, 1.5, 200_000);
const CLAUDE_SONNET = price('Claude Sonnet 5.5', 2, 10, 0.2, 1_000_000);
const CLAUDE_SONNET_46 = price('Claude Sonnet 4.6', 3, 15, 0.3, 1_000_000);
const CLAUDE_HAIKU = price('Claude Haiku 4.5', 1, 5, 0.1, 200_000);
const CLAUDE_FABLE = price('Claude Fable', 10, 50, 1, 1_000_000);
const GEMINI_PRO = price('Gemini Pro', 1.25, 5, 0.3125, 1_000_000);
const GEMINI_FLASH = price('Gemini Flash', 0.15, 0.6, 0.0375, 1_000_000);
const GEMINI_FLASH_LITE = price('Gemini Flash-Lite', 0.075, 0.3, 0.01875, 1_000_000);
const GPT_4O = price('GPT-4o', 2.5, 10, 1.25, 128_000);
const GPT_45 = price('GPT-4.5', 75, 150, 37.5, 128_000);
const O1 = price('OpenAI o1', 15, 60, 7.5, 200_000);
const O3_MINI = price('OpenAI o3-mini', 1.1, 4.4, 0.55, 200_000);
const CODEX = price('OpenAI Codex', 2.5, 10, 1.25, 128_000);

const isGoogleAgent = (agentId: string) => /gemini|antigravity|google/.test(agentId);
const isOpenAiAgent = (agentId: string) => /codex|openai/.test(agentId);

/**
 * Context window and list prices used for the usage estimates. The window is the
 * one the agent reported when known; model ids ending in [1m] or -1m mean 1M.
 */
export function sessionPricing(session: AcpSession): ModelPricing {
  const listed = listPricing(session);
  const hint = /(?:\[(\d+)m\]|-(\d+)m)$/i.exec(session.model || '');
  const contextWindow = session.contextWindow || (hint ? Number(hint[1] ?? hint[2]) * 1_000_000 : listed.contextWindow);
  return contextWindow === listed.contextWindow ? listed : { ...listed, contextWindow };
}

function listPricing(session: AcpSession): ModelPricing {
  const agentId = (session.agentId || '').toLowerCase();
  const m = (session.model || '').toLowerCase();

  // The built-in demo agent runs locally and costs nothing.
  if (agentId === 'mock') return FREE;

  // Anthropic families; the bare aliases (opus, sonnet) are Claude Code's current models.
  if (m.includes('opus-4-5') || m.includes('opus-4.5')) return CLAUDE_OPUS_45;
  if (/opus-(5|4[.-][678])\b/.test(m) && !/opus-5[.-]5/.test(m)) return CLAUDE_OPUS_5;
  if (m.includes('opus')) return CLAUDE_OPUS;
  if (m.includes('fable')) return CLAUDE_FABLE;
  if (m.includes('haiku')) return CLAUDE_HAIKU;
  if (m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return CLAUDE_SONNET_46;
  if (m.includes('sonnet')) return CLAUDE_SONNET;

  // Google. "pro" counts only inside a Gemini model id ("gemini-3.1-pro") or on
  // a Google agent, so unrelated ids containing "pro" don't price as Gemini.
  if (m.includes('flash-lite') || m.includes('flash lite')) return GEMINI_FLASH_LITE;
  if (m.includes('gemini') && m.includes('flash')) return GEMINI_FLASH;
  if (/gemini[\w.-]*pro\b/.test(m)) return GEMINI_PRO;
  if (isGoogleAgent(agentId)) return m.includes('flash') ? GEMINI_FLASH : GEMINI_PRO;

  // OpenAI.
  if (m.includes('gpt-4.5')) return GPT_45;
  if (m.includes('gpt-4o')) return GPT_4O;
  if (m.includes('o3-mini')) return O3_MINI;
  if (/(^|[^\w.])o1($|[^\w.])/.test(m)) return O1;
  if (isOpenAiAgent(agentId)) return CODEX;

  // Claude Code sessions without a recognised model, and anything unknown.
  return CLAUDE_SONNET;
}

export function usageMetrics(session: AcpSession) {
  const pricing = sessionPricing(session);
  const inputTokens = session.usage?.inputTokens || 0;
  const outputTokens = session.usage?.outputTokens || 0;
  const cachedTokens = session.usage?.cachedTokens || 0;
  const contextTokens = session.usage?.contextTokens || inputTokens;
  const percentContext = Math.min(100, Math.round((contextTokens / pricing.contextWindow) * 100));
  const estimatedCost =
    (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return { pricing, inputTokens, outputTokens, cachedTokens, contextTokens, percentContext, estimatedCost };
}

/** "$0.00", "$0.0042", "$1.37", "$1,204.50". */
export function formatCost(usd: number): string {
  if (!usd) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "950", "48.2k", "171k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** "200k", "1M". */
export function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`;
}

/** "$3 in / $15 out per 1M tokens". */
export function formatRate(p: ModelPricing): string {
  return `$${p.inputPerMillion} in / $${p.outputPerMillion} out per 1M tokens`;
}

/** Colour tone for a fill level: warn above 50%, danger above 80%. */
export function levelTone(percent: number): 'accent' | 'warn' | 'danger' {
  return percent > 80 ? 'danger' : percent > 50 ? 'warn' : 'accent';
}
