import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentDescriptor, ConfigChoice } from '../types.js';
import { appEnv } from '../env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_AGENT_PATH = path.join(__dirname, 'mock-agent.ts');

const BIN_DIR = path.resolve(__dirname, '../../node_modules/.bin');
const TSX_BIN = path.join(BIN_DIR, 'tsx');
const CLAUDE_ACP_BIN = path.join(BIN_DIR, 'claude-agent-acp');
const CODEX_ACP_BIN = path.join(BIN_DIR, 'codex-acp');

const defaultClaudeModels = [
  'sonnet',
  'opus',
  'haiku',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-haiku-4-5',
];

const defaultCodexModels = [
  '6-luna',
  '5.6-terra',
  '5.6-luna',
  '5.5',
  'gpt-4o',
  'o3-mini',
  'o1',
  'gpt-4.5-preview',
];

const defaultGeminiModels = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.1-pro',
  'gemini-flash-lite',
  'gemini-2.5-pro',
];

// Effort levels shown before an agent has reported its own (the agent's report wins:
// it varies per model, e.g. Claude Haiku has none and some Codex models add Ultra)
const levels = (...values: Array<[string, string]>): ConfigChoice[] => values.map(([value, label]) => ({ value, label }));
const claudeEfforts = levels(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']);
const codexEfforts = levels(['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']);

const parseEnvModels = (envVal?: string, defaults: string[] = []): string[] => {
  if (!envVal) return defaults;
  return envVal.split(',').map((s) => s.trim()).filter(Boolean);
};

export const AGENT_REGISTRY: Record<string, AgentDescriptor> = {
  claude: {
    id: 'claude',
    name: 'Claude Code (ACP)',
    provider: 'anthropic',
    description: 'Anthropic Claude Code connected via Agent Client Protocol (uses Claude Max/Pro subscription)',
    command: process.env.CLAUDE_ACP_CMD || (fs.existsSync(CLAUDE_ACP_BIN) ? CLAUDE_ACP_BIN : 'npx'),
    args: process.env.CLAUDE_ACP_ARGS
      ? JSON.parse(process.env.CLAUDE_ACP_ARGS)
      : fs.existsSync(CLAUDE_ACP_BIN)
      ? []
      : ['-y', '@agentclientprotocol/claude-agent-acp'],
    icon: 'claude',
    mcpSupport: { transports: ['stdio', 'http', 'sse'] },
    defaultModel: 'sonnet',
    availableModels: parseEnvModels(process.env.CLAUDE_MODELS, defaultClaudeModels),
    efforts: claudeEfforts,
    slashCommands: [
      { command: '/compact', label: 'Compact Context', description: 'Summarize past conversation turns into a lean checkpoint to free context', category: 'agent', icon: '📦' },
      { command: '/review', label: 'Review Code / PR', description: 'Inspect git diff and review pending changes against best practices', category: 'agent', icon: '🔍' },
      { command: '/pr', label: 'Create Pull Request', description: 'Draft PR summary and submit a pull request for branch changes', category: 'agent', icon: '🚀' },
      { command: '/cost', label: 'Token Usage & Cost', description: 'Display token consumption metrics and estimated API spend', category: 'agent', icon: '📊' },
      { command: '/doctor', label: 'Health & Diagnostics', description: 'Check environment health, verify tool paths, and validate config', category: 'agent', icon: '🩺' },
      { command: '/init', label: 'Initialize CLAUDE.md', description: 'Scan repository and generate or refresh project guidelines (CLAUDE.md)', category: 'agent', icon: '📝' },
      { command: '/bug', label: 'Report a Bug', description: 'Report an issue or unexpected behavior directly to Anthropic', category: 'agent', icon: '🐛' },
      { command: '/clear', label: 'Clear Conversation', description: 'Reset conversation context and start a clean slate', category: 'agent', icon: '🧹' },
      { command: '/terminal-setup', label: 'Terminal Keybindings', description: 'Configure shell completion, shortcuts, and terminal integration', category: 'agent', icon: '⚙️' },
      { command: '/help', label: 'Claude Help', description: 'Show Claude Code documentation and command reference', category: 'agent', icon: '❓' },
    ],
  },
  codex: {
    id: 'codex',
    name: 'Codex CLI (ACP)',
    provider: 'openai',
    description: 'OpenAI Codex agent connected via Agent Client Protocol (supports ChatGPT Plus/Pro subscription)',
    command: process.env.CODEX_ACP_CMD || (fs.existsSync(CODEX_ACP_BIN) ? CODEX_ACP_BIN : 'npx'),
    args: process.env.CODEX_ACP_ARGS
      ? JSON.parse(process.env.CODEX_ACP_ARGS)
      : fs.existsSync(CODEX_ACP_BIN)
      ? []
      : ['-y', '@agentclientprotocol/codex-acp'],
    icon: 'codex',
    mcpSupport: { transports: ['stdio', 'http'] },
    defaultModel: '6-luna',
    availableModels: parseEnvModels(process.env.CODEX_MODELS, defaultCodexModels),
    efforts: codexEfforts,
    slashCommands: [
      { command: '/compact', label: 'Compact Context', description: 'Compact active conversation turns into a summary to conserve context tokens', category: 'agent', icon: '📦' },
      { command: '/diff', label: 'View Git Diff', description: 'Review git modifications and unstaged changes generated by Codex', category: 'agent', icon: '📄' },
      { command: '/approval', label: 'Approval Mode', description: 'Toggle auto-approval for command execution and filesystem edits', category: 'agent', icon: '⚡' },
      { command: '/model', label: 'Switch Model', description: 'Switch between Codex models (e.g. 6-luna, 5.6-terra, o3-mini)', category: 'agent', icon: '🧠' },
      { command: '/undo', label: 'Undo Last Turn', description: 'Revert the last prompt or tool modification in this session', category: 'agent', icon: '↩️' },
      { command: '/clear', label: 'Clear Session Memory', description: 'Wipe current context window and restart cleanly', category: 'agent', icon: '🧹' },
      { command: '/help', label: 'Codex CLI Reference', description: 'View Codex keyboard shortcuts, execution flags, and command reference', category: 'agent', icon: '❓' },
    ],
  },
  antigravity: {
    id: 'antigravity',
    name: 'Google Antigravity (ACP)',
    provider: 'google',
    description: 'Google Antigravity agent (uses your active Google Antigravity desktop account)',
    command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
    args: [path.join(__dirname, 'antigravity-agent.ts')],
    icon: 'gemini',
    mcpSupport: {
      transports: [],
      note: 'Antigravity runs through its desktop app, which reads MCP servers from its own settings. Add them there with `agy mcp add`.',
    },
    defaultModel: 'gemini-3.8-flash',
    availableModels: parseEnvModels(process.env.GEMINI_MODELS, defaultGeminiModels),
    // The bridge drives agentapi, which takes a model tier but no effort
    efforts: [],
    slashCommands: [
      { command: '/goal', label: 'Autonomous Goal Mode', description: 'Run extra-thorough autonomous execution that continues until verified', category: 'agent', icon: '🎯' },
      { command: '/plan', label: 'Architecture Plan', description: 'Create an interactive step-by-step implementation plan before modifying code', category: 'agent', icon: '📋' },
      { command: '/grill-me', label: 'Alignment Interview', description: 'Interactive interview to probe requirements, edge cases, and design trade-offs', category: 'agent', icon: '🎙️' },
      { command: '/browser', label: 'Web & Docs Browser', description: 'Delegate live web browsing, documentation scraping, or web testing', category: 'agent', icon: '🌐' },
      { command: '/learn', label: 'Save Skill / Rule', description: 'Save corrected behavior or reusable skill into persistent rules', category: 'agent', icon: '💡' },
      { command: '/boost', label: 'Boosted Reasoning', description: 'Engage multi-perspective strategic reasoning and plan critique', category: 'agent', icon: '🚀' },
      { command: '/compact', label: 'Compact Context', description: 'Distill earlier verbose tool outputs into a clean checkpoint', category: 'agent', icon: '📦' },
      { command: '/clear', label: 'Clear Memory', description: 'Reset conversational context and start afresh', category: 'agent', icon: '🧹' },
      { command: '/help', label: 'Antigravity Guide', description: 'Browse Antigravity skills, SDK methods, and slash commands', category: 'agent', icon: '❓' },
    ],
  },
  mock: {
    id: 'mock',
    name: 'Built-in ACP Demo Agent',
    provider: 'mock',
    description: 'Built-in protocol-compliant ACP agent for instant testing, permissions demos, and offline usage',
    command: fs.existsSync(TSX_BIN) ? TSX_BIN : 'tsx',
    args: [MOCK_AGENT_PATH],
    icon: 'mock',
    mcpSupport: { transports: ['stdio', 'http', 'sse'] },
    defaultModel: 'mock-model-v1',
    availableModels: ['mock-model-v1'],
    efforts: [],
    slashCommands: [
      { command: '/compact', label: 'Compact Context', description: 'Compact earlier verbose turns into a clean summary checkpoint', category: 'agent', icon: '📦' },
      { command: '/clear', label: 'Clear Memory', description: 'Reset context window', category: 'agent', icon: '🧹' },
      { command: '/help', label: 'ACP Agent Reference', description: 'Show agent capabilities and supported tools', category: 'agent', icon: '❓' },
    ],
  },
};

/**
 * How agents are started when the server runs inside the CodePit desktop app. There is
 * no tsx or npx there, and nothing inside app.asar can be executed, so each agent's
 * JS entry runs on the app's own executable in Node mode, from real files.
 */
export interface BundledAgentRuntime {
  /** The app's executable (process.execPath in Electron's main process). */
  execPath: string;
  /** Prebuilt agent-launcher.mjs, which keeps Node mode from leaking to the agent's children. */
  launcher: string;
  /** node_modules holding the agent packages, unpacked from the asar. */
  modulesDir: string;
  /** Directory with the prebuilt antigravity-agent.mjs and mock-agent.mjs. */
  scriptsDir: string;
}

/**
 * Points the registry at a bundled runtime. The *_ACP_CMD overrides still win, and
 * *_ACP_ARGS still become the agent's arguments.
 */
export function useBundledAgentRuntime(rt: BundledAgentRuntime): void {
  const viaApp = (agent: AgentDescriptor, entry: string, extraArgs: string[] = []) => {
    agent.command = rt.execPath;
    agent.args = [rt.launcher, entry, ...extraArgs];
    agent.env = { ...agent.env, ELECTRON_RUN_AS_NODE: '1' };
  };
  const pkgEntry = (pkg: string) => path.join(rt.modulesDir, '@agentclientprotocol', pkg, 'dist', 'index.js');
  const envArgs = (v?: string): string[] => (v ? JSON.parse(v) : []);

  if (!process.env.CLAUDE_ACP_CMD) viaApp(AGENT_REGISTRY.claude, pkgEntry('claude-agent-acp'), envArgs(process.env.CLAUDE_ACP_ARGS));
  if (!process.env.CODEX_ACP_CMD) viaApp(AGENT_REGISTRY.codex, pkgEntry('codex-acp'), envArgs(process.env.CODEX_ACP_ARGS));
  viaApp(AGENT_REGISTRY.antigravity, path.join(rt.scriptsDir, 'antigravity-agent.mjs'));
  viaApp(AGENT_REGISTRY.mock, path.join(rt.scriptsDir, 'mock-agent.mjs'));
}

// Falls back to Claude so legacy stored sessions with a retired agentId still load;
// validate new ids with hasAgent() before creating or switching.
export function getAgent(id: string): AgentDescriptor {
  return AGENT_REGISTRY[id] || AGENT_REGISTRY.claude || AGENT_REGISTRY.antigravity || AGENT_REGISTRY.mock;
}

export function hasAgent(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(AGENT_REGISTRY, id);
}

export function listAgents(includeMock?: boolean): AgentDescriptor[] {
  const shouldInclude = includeMock ?? (process.env.NODE_ENV === 'test' || appEnv('ENABLE_MOCK') === '1');
  const all = Object.values(AGENT_REGISTRY);
  if (shouldInclude) {
    return all;
  }
  return all.filter((a) => a.id !== 'mock');
}

