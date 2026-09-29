import fs from 'node:fs';
import path from 'node:path';
import { getAppDir } from '../paths.js';
import type { McpServerInput, McpTransport } from '../types.js';
import { McpConfigError, WORKSPACE_VAR } from './config.js';

// One-click MCP servers. `{{KEY}}` in a template is filled from the matching
// input when the preset is added; `${workspace}` stays in the stored config and
// becomes each session's folder when the agent starts.

export interface McpPresetInput {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  /** Used when the input is left empty; omit to make the input required. */
  defaultValue?: string;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  /** Icon name from web/src/components/Icons.tsx. */
  icon: string;
  category: 'Files' | 'Code' | 'Memory' | 'Search' | 'Database';
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  inputs?: McpPresetInput[];
  /** Runtime the command needs on PATH, e.g. npx or uvx. */
  requires?: string;
  docsUrl: string;
}

const PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: "Read, write and search files, limited to each session's folder.",
    icon: 'folder',
    category: 'Files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', WORKSPACE_VAR],
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: "Query repositories, pull requests and issues through GitHub's hosted MCP server.",
    icon: 'branch',
    category: 'Code',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer {{GITHUB_TOKEN}}' },
    inputs: [
      {
        key: 'GITHUB_TOKEN',
        label: 'GitHub personal access token',
        placeholder: 'github_pat_…',
        hint: 'A fine-grained token with read access to the repositories you want the agent to see.',
        secret: true,
      },
    ],
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A knowledge graph the agents can read and write, kept across sessions.',
    icon: 'brain',
    category: 'Memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { MEMORY_FILE_PATH: '{{APP_DIR}}/mcp-memory.jsonl' },
    requires: 'npx',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web, news and image search through the Brave Search API.',
    icon: 'globe',
    category: 'Search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: '{{BRAVE_API_KEY}}' },
    inputs: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API key',
        placeholder: 'BSA…',
        hint: 'Get a free key at brave.com/search/api.',
        secret: true,
      },
    ],
    requires: 'npx',
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and change a local SQLite database file.',
    icon: 'database',
    category: 'Database',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite-npx', '{{DB_PATH}}'],
    inputs: [
      {
        key: 'DB_PATH',
        label: 'Database file',
        placeholder: '/path/to/app.db',
        hint: `An absolute path. Use ${WORKSPACE_VAR}/app.db for a file inside each session's folder.`,
      },
    ],
    requires: 'npx',
    docsUrl: 'https://github.com/johnnyoshika/mcp-server-sqlite-npx',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Explore schemas and run read-only queries against a Postgres database.',
    icon: 'database',
    category: 'Database',
    transport: 'stdio',
    command: 'uvx',
    args: ['postgres-mcp', '--access-mode=restricted'],
    env: { DATABASE_URI: '{{DATABASE_URI}}' },
    inputs: [
      {
        key: 'DATABASE_URI',
        label: 'Connection string',
        placeholder: 'postgresql://user:password@localhost:5432/db',
        secret: true,
      },
    ],
    requires: 'uvx',
    docsUrl: 'https://github.com/crystaldba/postgres-mcp',
  },
];

const pathCache = new Map<string, boolean>();

/** Whether an executable is on this server's PATH (agents inherit the same PATH). */
export function onPath(bin: string): boolean {
  const hit = pathCache.get(bin);
  if (hit !== undefined) return hit;
  const found = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  pathCache.set(bin, found);
  return found;
}

export function listPresets(): Array<McpPreset & { available: boolean }> {
  return PRESETS.map((p) => ({ ...p, available: !p.requires || onPath(p.requires) }));
}

/** Build the server config for a preset, filling `{{KEY}}` placeholders from the inputs. */
export function presetToInput(presetId: string, inputs: Record<string, unknown> = {}, scope = 'all'): McpServerInput {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new McpConfigError(`Unknown preset: ${presetId}`);

  const values: Record<string, string> = { APP_DIR: getAppDir() };
  for (const input of preset.inputs ?? []) {
    const raw = typeof inputs[input.key] === 'string' ? (inputs[input.key] as string).trim() : '';
    const value = raw || input.defaultValue;
    if (!value) throw new McpConfigError(`${input.label} is required`);
    values[input.key] = value;
  }
  const fill = (s: string) => s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => values[key] ?? '');
  const fillRecord = (rec?: Record<string, string>) =>
    rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fill(v)])) : undefined;

  return {
    name: preset.id,
    transport: preset.transport,
    enabled: true,
    scope,
    presetId: preset.id,
    description: preset.description,
    command: preset.command,
    args: preset.args?.map(fill),
    env: fillRecord(preset.env),
    url: preset.url && fill(preset.url),
    headers: fillRecord(preset.headers),
  };
}
