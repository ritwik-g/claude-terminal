import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { getCredentialsFile, ensurePrivateDir, getAppDir, FILE_MODE } from './paths.js';
import { store } from './store.js';
import type { AcpSession } from './types.js';

export interface VendorRateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
}

export interface VendorRateLimits {
  fiveHour?: VendorRateLimitWindow | null;
  weeklyAll?: VendorRateLimitWindow | null;
  weeklyModels?: Array<{ name: string; utilization: number; resetsAt?: string | null }>;
  updatedAt?: number;
}

export interface VendorSubscriptionInfo {
  vendorId: 'anthropic' | 'openai' | 'google';
  vendorName: string;
  authMode: 'subscription' | 'api_key' | 'desktop';
  accountEmail?: string;
  accountName?: string;
  planName: string;
  organization?: string;
  status: 'active' | 'configured' | 'unconfigured' | 'expired';
  apiKeyConfigured: boolean;
  apiKeyMasked?: string;
  reauthCommand?: string;
  details: Record<string, any>;
  rateLimits?: VendorRateLimits;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
  contextWindow: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachePerMillion: 0.3, contextWindow: 200000 },
  'opus': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachePerMillion: 1.5, contextWindow: 200000 },
  'haiku': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachePerMillion: 0.08, contextWindow: 200000 },
  'claude-opus-4-6': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachePerMillion: 1.5, contextWindow: 200000 },
  'claude-opus-4-5': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachePerMillion: 1.5, contextWindow: 200000 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachePerMillion: 0.08, contextWindow: 200000 },
  'claude-3-7-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachePerMillion: 0.3, contextWindow: 200000 },
  'claude-3-5-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachePerMillion: 0.3, contextWindow: 200000 },
  'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachePerMillion: 0.08, contextWindow: 200000 },
  'opus-5.5': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachePerMillion: 1.5, contextWindow: 200000 },
  'opus-4.6': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachePerMillion: 1.5, contextWindow: 200000 },
  'sonnet-5': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachePerMillion: 0.3, contextWindow: 200000 },
  'fable-5.1': { inputPerMillion: 5.0, outputPerMillion: 25.0, cachePerMillion: 0.5, contextWindow: 200000 },
  'haiku-4.5': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachePerMillion: 0.08, contextWindow: 200000 },

  // OpenAI
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachePerMillion: 1.25, contextWindow: 128000 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cachePerMillion: 0.55, contextWindow: 200000 },
  'o1': { inputPerMillion: 15.0, outputPerMillion: 60.0, cachePerMillion: 7.5, contextWindow: 200000 },
  'gpt-4.5-preview': { inputPerMillion: 75.0, outputPerMillion: 150.0, cachePerMillion: 37.5, contextWindow: 128000 },
  '6-luna': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachePerMillion: 1.25, contextWindow: 128000 },
  '5.6-terra': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachePerMillion: 1.25, contextWindow: 128000 },
  '5.6-luna': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachePerMillion: 1.25, contextWindow: 128000 },

  // Google
  'gemini-3.8-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachePerMillion: 0.0375, contextWindow: 1000000 },
  'gemini-3.7-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachePerMillion: 0.0375, contextWindow: 1000000 },
  'gemini-3.6-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachePerMillion: 0.0375, contextWindow: 1000000 },
  'gemini-3.1-pro': { inputPerMillion: 1.25, outputPerMillion: 5.0, cachePerMillion: 0.3125, contextWindow: 1000000 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.0, cachePerMillion: 0.3125, contextWindow: 1000000 },
  'gemini-flash-lite': { inputPerMillion: 0.075, outputPerMillion: 0.3, cachePerMillion: 0.01875, contextWindow: 1000000 },
};

export const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cachePerMillion: 0.3,
  contextWindow: 200000,
};

export function getPricingForModel(modelId?: string): ModelPricing {
  if (!modelId) return DEFAULT_PRICING;
  const lower = modelId.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.includes(key) || key.includes(lower)) {
      return pricing;
    }
  }
  if (lower.includes('opus')) {
    return MODEL_PRICING['opus-4.6'];
  }
  if (lower.includes('flash')) {
    return MODEL_PRICING['gemini-3.8-flash'];
  }
  if (lower.includes('pro')) {
    return MODEL_PRICING['gemini-3.1-pro'];
  }
  return DEFAULT_PRICING;
}

export function maskApiKey(key?: string): string {
  if (!key || key.length < 8) return '';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export interface StoredCredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  preferredAuthMode?: {
    anthropic?: 'subscription' | 'api_key';
    openai?: 'subscription' | 'api_key';
    google?: 'desktop' | 'api_key';
  };
}

export function loadStoredCredentials(): StoredCredentials {
  const file = getCredentialsFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const creds = JSON.parse(raw);
      if (creds.anthropicApiKey) process.env.ANTHROPIC_API_KEY = creds.anthropicApiKey;
      if (creds.openaiApiKey) process.env.OPENAI_API_KEY = creds.openaiApiKey;
      if (creds.geminiApiKey) {
        process.env.GEMINI_API_KEY = creds.geminiApiKey;
        process.env.GOOGLE_API_KEY = creds.geminiApiKey;
      }
      return creds;
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveStoredCredentials(creds: Partial<StoredCredentials>): StoredCredentials {
  const existing = loadStoredCredentials();
  const updated: StoredCredentials = {
    ...existing,
    ...creds,
    preferredAuthMode: {
      ...existing.preferredAuthMode,
      ...creds.preferredAuthMode,
    },
  };

  if (updated.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = updated.anthropicApiKey;
  } else if (creds.anthropicApiKey === '') {
    delete updated.anthropicApiKey;
    delete process.env.ANTHROPIC_API_KEY;
  }

  if (updated.openaiApiKey) {
    process.env.OPENAI_API_KEY = updated.openaiApiKey;
  } else if (creds.openaiApiKey === '') {
    delete updated.openaiApiKey;
    delete process.env.OPENAI_API_KEY;
  }

  if (updated.geminiApiKey) {
    process.env.GEMINI_API_KEY = updated.geminiApiKey;
    process.env.GOOGLE_API_KEY = updated.geminiApiKey;
  } else if (creds.geminiApiKey === '') {
    delete updated.geminiApiKey;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  }

  ensurePrivateDir(getAppDir());
  fs.writeFileSync(getCredentialsFile(), JSON.stringify(updated, null, 2), {
    mode: FILE_MODE,
    encoding: 'utf8',
  });

  return updated;
}

let cachedClaudeRateLimits: VendorRateLimits = {
  fiveHour: null,
  weeklyAll: null,
  weeklyModels: [],
  updatedAt: 0,
};
let isRefreshingClaudeLimits = false;

// Trigger background refresh on startup
setTimeout(() => {
  refreshClaudeRateLimitsAsync().catch(() => {});
}, 1000);

export function parseClaudeUsageOutput(text: string): VendorRateLimits {
  const result: VendorRateLimits = {
    updatedAt: Date.now(),
    weeklyModels: [],
  };

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sessionMatch = trimmed.match(/Current session:\s*(\d+)%\s*used(?:[^\w]+resets\s+(.+))?/i);
    if (sessionMatch) {
      result.fiveHour = {
        utilization: parseInt(sessionMatch[1], 10),
        resetsAt: sessionMatch[2] ? sessionMatch[2].trim() : null,
      };
      continue;
    }

    const weekAllMatch = trimmed.match(/Current week\s*\(all models\):\s*(\d+)%\s*used(?:[^\w]+resets\s+(.+))?/i);
    if (weekAllMatch) {
      result.weeklyAll = {
        utilization: parseInt(weekAllMatch[1], 10),
        resetsAt: weekAllMatch[2] ? weekAllMatch[2].trim() : null,
      };
      continue;
    }

    const weekModelMatch = trimmed.match(/Current week\s*\(([^)]+)\):\s*(\d+)%\s*used(?:[^\w]+resets\s+(.+))?/i);
    if (weekModelMatch) {
      result.weeklyModels?.push({
        name: weekModelMatch[1].trim(),
        utilization: parseInt(weekModelMatch[2], 10),
        resetsAt: weekModelMatch[3] ? weekModelMatch[3].trim() : null,
      });
      continue;
    }
  }

  return result;
}

export function refreshClaudeRateLimitsAsync(): Promise<VendorRateLimits> {
  return new Promise((resolve) => {
    if (isRefreshingClaudeLimits) {
      return resolve(cachedClaudeRateLimits);
    }
    isRefreshingClaudeLimits = true;
    exec('claude -p "/usage"', { timeout: 15000 }, (error, stdout) => {
      isRefreshingClaudeLimits = false;
      if (!error && stdout) {
        try {
          const parsed = parseClaudeUsageOutput(stdout);
          if (parsed.fiveHour || parsed.weeklyAll) {
            cachedClaudeRateLimits = {
              ...cachedClaudeRateLimits,
              ...parsed,
              updatedAt: Date.now(),
            };
          }
        } catch {
          // ignore
        }
      }
      resolve(cachedClaudeRateLimits);
    });
  });
}

export function updateClaudeRateLimitsFromSdk(info: any): void {
  if (!info || typeof info !== 'object') return;
  const util = typeof info.utilization === 'number'
    ? (info.utilization <= 1.0 ? Math.round(info.utilization * 100) : Math.round(info.utilization))
    : undefined;

  let resetsFormatted: string | null = null;
  if (info.resetsAt) {
    try {
      const ts = typeof info.resetsAt === 'number' ? (info.resetsAt > 1e11 ? info.resetsAt : info.resetsAt * 1000) : Date.parse(info.resetsAt);
      resetsFormatted = new Date(ts).toLocaleString();
    } catch {
      resetsFormatted = String(info.resetsAt);
    }
  }

  if (info.rateLimitType === 'five_hour') {
    cachedClaudeRateLimits.fiveHour = {
      utilization: util !== undefined ? util : (cachedClaudeRateLimits.fiveHour?.utilization ?? 0),
      resetsAt: resetsFormatted || cachedClaudeRateLimits.fiveHour?.resetsAt,
    };
  } else if (info.rateLimitType === 'seven_day') {
    cachedClaudeRateLimits.weeklyAll = {
      utilization: util !== undefined ? util : (cachedClaudeRateLimits.weeklyAll?.utilization ?? 0),
      resetsAt: resetsFormatted || cachedClaudeRateLimits.weeklyAll?.resetsAt,
    };
  } else if (info.rateLimitType?.startsWith('seven_day_')) {
    const modelName = info.rateLimitType.replace('seven_day_', '');
    const existing = (cachedClaudeRateLimits.weeklyModels || []).filter(m => m.name.toLowerCase() !== modelName.toLowerCase());
    existing.push({
      name: modelName.charAt(0).toUpperCase() + modelName.slice(1),
      utilization: util !== undefined ? util : 0,
      resetsAt: resetsFormatted,
    });
    cachedClaudeRateLimits.weeklyModels = existing;
  }
  cachedClaudeRateLimits.updatedAt = Date.now();
}

export function getClaudeRateLimits(): VendorRateLimits {
  const now = Date.now();
  if (now - (cachedClaudeRateLimits.updatedAt || 0) > 180000) {
    refreshClaudeRateLimitsAsync().catch(() => {});
  }
  return cachedClaudeRateLimits;
}

export function getVendorSubscriptions(): Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> {
  const home = os.homedir();
  const creds = loadStoredCredentials();

  // 1. Anthropic / Claude
  let claudeEmail = '';
  let claudePlan = 'Claude Subscription';
  let claudeBilling = '';
  let claudeOrg = '';
  let claudeStatus: VendorSubscriptionInfo['status'] = 'unconfigured';

  try {
    const claudeJsonPath = path.join(home, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      if (claudeJson.oauthAccount) {
        claudeEmail = claudeJson.oauthAccount.emailAddress || claudeJson.oauthAccount.email || '';
        claudeBilling = claudeJson.oauthAccount.billingType || '';
        claudeOrg = claudeJson.oauthAccount.organizationName || '';
        const isMax = claudeJson.claudeMaxTier === 'max' || claudeJson.hasAvailableMaxSubscription;
        claudePlan = isMax ? 'Claude Max Subscription' : 'Claude Pro / Team Subscription';
        claudeStatus = 'active';
      }
    }
  } catch {
    // ignore
  }

  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY || creds.anthropicApiKey);
  const anthropicPreferredMode = creds.preferredAuthMode?.anthropic || (hasAnthropicKey && !claudeEmail ? 'api_key' : 'subscription');

  const anthropicInfo: VendorSubscriptionInfo = {
    vendorId: 'anthropic',
    vendorName: 'Anthropic Claude Code',
    authMode: anthropicPreferredMode,
    accountEmail: claudeEmail || undefined,
    organization: claudeOrg || undefined,
    planName: anthropicPreferredMode === 'api_key' ? 'API Key (Pay-as-you-go)' : (claudePlan || 'Claude Pro'),
    status: claudeEmail ? 'active' : (hasAnthropicKey ? 'configured' : 'unconfigured'),
    apiKeyConfigured: hasAnthropicKey,
    apiKeyMasked: maskApiKey(process.env.ANTHROPIC_API_KEY || creds.anthropicApiKey),
    reauthCommand: 'claude login',
    rateLimits: getClaudeRateLimits(),
    details: {
      billingType: claudeBilling,
      loginFile: '~/.claude.json',
    },
  };

  // 2. OpenAI / Codex
  let codexMode = 'chatgpt';
  let codexStatus: VendorSubscriptionInfo['status'] = 'unconfigured';
  let codexPlan = 'ChatGPT Plus / Pro';

  try {
    const codexAuthPath = path.join(home, '.codex', 'auth.json');
    if (fs.existsSync(codexAuthPath)) {
      const codexAuth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
      codexMode = codexAuth.auth_mode || 'chatgpt';
      if (codexAuth.tokens || codexAuth.last_refresh) {
        codexStatus = 'active';
      }
    }
  } catch {
    // ignore
  }

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY || creds.openaiApiKey);
  const openAiPreferredMode = creds.preferredAuthMode?.openai || (hasOpenAiKey && codexStatus !== 'active' ? 'api_key' : 'subscription');

  const openaiInfo: VendorSubscriptionInfo = {
    vendorId: 'openai',
    vendorName: 'OpenAI Codex',
    authMode: openAiPreferredMode,
    planName: openAiPreferredMode === 'api_key' ? 'OpenAI API Key (Platform)' : (codexPlan || 'ChatGPT Plus/Pro'),
    status: codexStatus === 'active' ? 'active' : (hasOpenAiKey ? 'configured' : 'unconfigured'),
    apiKeyConfigured: hasOpenAiKey,
    apiKeyMasked: maskApiKey(process.env.OPENAI_API_KEY || creds.openaiApiKey),
    reauthCommand: 'codex login',
    details: {
      authMode: codexMode,
      configPath: '~/.codex/auth.json',
    },
  };

  // 3. Google / Antigravity / Gemini
  const hasAgentApi = fs.existsSync(path.join(home, '.gemini', 'antigravity', 'bin', 'agentapi'));
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || creds.geminiApiKey);
  const googlePreferredMode = creds.preferredAuthMode?.google || (hasAgentApi ? 'desktop' : 'api_key');

  const googleInfo: VendorSubscriptionInfo = {
    vendorId: 'google',
    vendorName: 'Google Antigravity & Gemini',
    authMode: googlePreferredMode,
    planName: googlePreferredMode === 'desktop' ? 'Google Antigravity Desktop' : 'Google AI Studio / Vertex AI',
    status: hasAgentApi ? 'active' : (hasGeminiKey ? 'configured' : 'unconfigured'),
    apiKeyConfigured: hasGeminiKey,
    apiKeyMasked: maskApiKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || creds.geminiApiKey),
    reauthCommand: 'Open Antigravity Desktop App (/Applications/Antigravity.app)',
    details: {
      daemonFound: hasAgentApi,
      agentApiPath: '~/.gemini/antigravity/bin/agentapi',
      appDataDir: path.join(home, '.gemini', 'antigravity'),
    },
  };

  return {
    anthropic: anthropicInfo,
    openai: openaiInfo,
    google: googleInfo,
  };
}

export function calculateSessionCost(session: AcpSession): {
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  totalCost: number;
  pricing: ModelPricing;
} {
  const pricing = getPricingForModel(session.model);
  const inputTokens = session.usage?.inputTokens || 0;
  const outputTokens = session.usage?.outputTokens || 0;
  const cachedTokens = session.usage?.cachedTokens || 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cachedCost = (cachedTokens / 1_000_000) * pricing.cachePerMillion;
  const totalCost = inputCost + outputCost + cachedCost;

  return {
    inputCost,
    outputCost,
    cachedCost,
    totalCost,
    pricing,
  };
}

export interface VendorUsageSummary {
  vendorId: 'anthropic' | 'openai' | 'google';
  vendorName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface UsageReport {
  overall: {
    totalSessions: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    estimatedCost: number;
  };
  vendors: Record<'anthropic' | 'openai' | 'google', VendorUsageSummary>;
  sessionsUsage: Array<{
    id: string;
    title: string;
    agentId: string;
    model?: string;
    totalTokens: number;
    contextTokens: number;
    contextLimit: number;
    percentContextUsed: number;
    estimatedCost: number;
  }>;
}

export function getUsageSummary(): UsageReport {
  const sessions = store.getAll();

  const report: UsageReport = {
    overall: {
      totalSessions: sessions.length,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      estimatedCost: 0,
    },
    vendors: {
      anthropic: {
        vendorId: 'anthropic',
        vendorName: 'Anthropic (Claude)',
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      },
      openai: {
        vendorId: 'openai',
        vendorName: 'OpenAI (Codex)',
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      },
      google: {
        vendorId: 'google',
        vendorName: 'Google (Gemini)',
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      },
    },
    sessionsUsage: [],
  };

  for (const s of sessions) {
    const input = s.usage?.inputTokens || 0;
    const output = s.usage?.outputTokens || 0;
    const cached = s.usage?.cachedTokens || 0;
    const total = input + output;

    // Check which vendors actually executed turns in this session
    const vendorChars: Record<'anthropic' | 'openai' | 'google', number> = {
      anthropic: 0,
      openai: 0,
      google: 0,
    };
    const participatingVendors = new Set<'anthropic' | 'openai' | 'google'>();
    const vendorModels: Record<'anthropic' | 'openai' | 'google', Set<string>> = {
      anthropic: new Set(),
      openai: new Set(),
      google: new Set(),
    };

    for (const t of s.turns) {
      if (t.role === 'agent' || t.role === 'user') {
        const turnAid = (t.agentId || s.agentId).toLowerCase();
        let vk: 'anthropic' | 'openai' | 'google' = 'anthropic';
        if (turnAid.includes('codex') || turnAid.includes('openai')) {
          vk = 'openai';
        } else if (turnAid.includes('gemini') || turnAid.includes('antigravity') || turnAid.includes('google')) {
          vk = 'google';
        }
        participatingVendors.add(vk);
        if (t.model) vendorModels[vk].add(t.model);

        const len = (t.content || '').length + (t.thoughts || '').length;
        let toolLen = 0;
        if (t.toolCalls) {
          for (const tc of t.toolCalls) {
            toolLen += (tc.output || '').length;
          }
        }
        vendorChars[vk] += Math.max(10, len + toolLen);
      }
    }

    if (participatingVendors.size === 0) {
      const aid = s.agentId.toLowerCase();
      let vk: 'anthropic' | 'openai' | 'google' = 'anthropic';
      if (aid.includes('codex') || aid.includes('openai')) {
        vk = 'openai';
      } else if (aid.includes('gemini') || aid.includes('antigravity') || aid.includes('google')) {
        vk = 'google';
      }
      participatingVendors.add(vk);
      vendorChars[vk] = 100;
    }

    const totalChars = Object.values(vendorChars).reduce((a, b) => a + b, 0) || 1;
    let sessionCost = 0;

    for (const vk of participatingVendors) {
      const share = vendorChars[vk] / totalChars;
      const vInput = Math.round(input * share);
      const vOutput = Math.round(output * share);
      const vCached = Math.round(cached * share);
      const vTotal = vInput + vOutput;

      const modelName = Array.from(vendorModels[vk])[0] || (vk === 'openai' ? '6-luna' : vk === 'google' ? 'gemini-3.8-flash' : 'opus');
      const pricing = getPricingForModel(modelName);
      const vCost = ((vInput / 1_000_000) * pricing.inputPerMillion) +
                    ((vOutput / 1_000_000) * pricing.outputPerMillion) +
                    ((vCached / 1_000_000) * pricing.cachePerMillion);

      sessionCost += vCost;

      const v = report.vendors[vk];
      v.sessionCount += 1;
      v.inputTokens += vInput;
      v.outputTokens += vOutput;
      v.cachedTokens += vCached;
      v.totalTokens += vTotal;
      v.estimatedCost += vCost;
    }

    // Update Overall
    report.overall.inputTokens += input;
    report.overall.outputTokens += output;
    report.overall.cachedTokens += cached;
    report.overall.totalTokens += total;
    report.overall.estimatedCost += sessionCost;

    const primaryPricing = getPricingForModel(s.model);
    const context = s.usage?.contextTokens || input;
    const percentContext = Math.min(100, Math.round((context / primaryPricing.contextWindow) * 100));

    report.sessionsUsage.push({
      id: s.id,
      title: s.title,
      agentId: s.agentId,
      model: s.model,
      totalTokens: total,
      contextTokens: context,
      contextLimit: primaryPricing.contextWindow,
      percentContextUsed: percentContext,
      estimatedCost: sessionCost,
    });
  }

  // Sort sessions usage descending
  report.sessionsUsage.sort((a, b) => b.totalTokens - a.totalTokens);

  return report;
}
