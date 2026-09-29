import type { AcpSession } from './types';

export interface ModelPricing {
  contextWindow: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
}

/** Context window and list prices used for the usage estimates. */
export function sessionPricing(session: AcpSession): ModelPricing {
  const m = (session.model || '').toLowerCase();
  if (session.agentId === 'mock') {
    // The built-in demo agent runs locally and costs nothing.
    return { contextWindow: 200_000, inputPerMillion: 0, outputPerMillion: 0, cachePerMillion: 0 };
  }
  if (m.includes('gemini') || m.includes('flash') || m.includes('pro')) {
    const isPro = m.includes('pro');
    return {
      contextWindow: 1_000_000,
      inputPerMillion: isPro ? 1.25 : 0.15,
      outputPerMillion: isPro ? 5.0 : 0.6,
      cachePerMillion: isPro ? 0.3125 : 0.0375,
    };
  }
  if (m.includes('opus')) {
    return {
      contextWindow: 200_000,
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cachePerMillion: 1.5,
    };
  }
  if (m.includes('haiku')) {
    return {
      contextWindow: 200_000,
      inputPerMillion: 0.8,
      outputPerMillion: 4.0,
      cachePerMillion: 0.08,
    };
  }
  // Sonnet / GPT-4o / default
  return {
    contextWindow: 200_000,
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cachePerMillion: 0.3,
  };

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
