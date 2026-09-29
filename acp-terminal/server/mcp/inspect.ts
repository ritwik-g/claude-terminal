import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { onPath } from './presets.js';

const execFileAsync = promisify(execFile);

// Read-only view of what each agent already loads by itself: its plugins,
// skills and its own MCP servers. Only names, versions and descriptions leave
// this module; env values, headers and tokens in those configs never do.

export interface EcosystemPlugin {
  name: string;
  source?: string;
  version?: string;
  /** null when the agent's config doesn't say. */
  enabled: boolean | null;
  description?: string;
}

export interface EcosystemSkill {
  name: string;
  description?: string;
  origin: 'user' | 'plugin' | 'built-in';
  plugin?: string;
}

export interface EcosystemReport {
  agentId: 'claude' | 'codex' | 'antigravity';
  name: string;
  /** Whether the agent's config directory exists on this machine. */
  detected: boolean;
  configPath: string;
  plugins: EcosystemPlugin[];
  skills: EcosystemSkill[];
  mcpServers: Array<{ name: string; transport?: string; enabled?: boolean }>;
  manageHint: string;
  warnings: string[];
}

const HOME = os.homedir();
const CACHE_MS = 30_000;
let cache: { at: number; value: EcosystemReport[] } | null = null;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** name/description from a SKILL.md front matter block. */
function skillMeta(file: string): { name?: string; description?: string } {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? '';
    const field = (key: string) => {
      const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
      if (!m) return undefined;
      const value = m[1].trim();
      // YAML block scalar (`description: >` / `|`): the value is the indented lines that follow
      if (/^[>|][+-]?$/.test(value)) {
        const rest = fm.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
        const lines: string[] = [];
        for (const line of rest) {
          if (line.trim() && !/^\s/.test(line)) break;
          lines.push(line.trim());
        }
        return lines.join(' ').replace(/\s+/g, ' ').trim() || undefined;
      }
      return value ? value.replace(/^["']|["']$/g, '') : undefined;
    };
    const desc = field('description');
    return { name: field('name'), description: desc && desc.length > 240 ? `${desc.slice(0, 237)}…` : desc };
  } catch {
    return {};
  }
}

function skillsIn(dir: string, origin: EcosystemSkill['origin'], plugin?: string): EcosystemSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: EcosystemSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.')) {
      // Codex keeps its bundled skills in skills/.system
      if (e.name === '.system') out.push(...skillsIn(path.join(dir, e.name), 'built-in', plugin));
      continue;
    }
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const meta = skillMeta(file);
    out.push({ name: meta.name || e.name, description: meta.description, origin, plugin });
  }
  return out;
}

/** Marketplace plugins pinned to a commit report the full sha; "unknown" means no version at all. */
const shortVersion = (v?: string) => (!v || v === 'unknown' ? undefined : /^[0-9a-f]{12,40}$/.test(v) ? v.slice(0, 7) : v);

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

function inspectClaude(): EcosystemReport {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const report: EcosystemReport = {
    agentId: 'claude',
    name: 'Claude Code',
    detected: fs.existsSync(dir),
    configPath: dir,
    plugins: [],
    skills: skillsIn(path.join(dir, 'skills'), 'user'),
    mcpServers: [],
    manageHint: 'Manage these with /plugin and /mcp in Claude Code, or `claude plugin` and `claude mcp` in a terminal.',
    warnings: [],
  };
  const enabled: Record<string, boolean> = readJson(path.join(dir, 'settings.json'))?.enabledPlugins ?? {};
  const installed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  for (const [key, installs] of Object.entries<any>(installed)) {
    const install = Array.isArray(installs) ? installs[0] : installs;
    const [name, source] = key.split('@');
    const manifest = install?.installPath ? readJson(path.join(install.installPath, '.claude-plugin', 'plugin.json')) : null;
    // Claude Code loads only the plugins enabledPlugins switches on
    const isEnabled = Boolean(enabled[key]);
    report.plugins.push({ name, source, version: shortVersion(install?.version), enabled: isEnabled, description: manifest?.description });
    if (isEnabled && install?.installPath) report.skills.push(...skillsIn(path.join(install.installPath, 'skills'), 'plugin', name));
  }
  // User-scope servers: ~/.claude.json by default, <dir>/.claude.json under CLAUDE_CONFIG_DIR
  const userConfig = readJson(process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(HOME, '.claude.json'));
  for (const [name, cfg] of Object.entries<any>(userConfig?.mcpServers ?? {})) {
    report.mcpServers.push({ name, transport: cfg?.type || (cfg?.url ? 'http' : 'stdio') });
  }
  report.plugins.sort(byName);
  report.skills.sort(byName);
  report.mcpServers.sort(byName);
  return report;
}

/** The handful of config.toml facts we show; a full TOML parser isn't worth a dependency. */
function parseCodexToml(text: string): { plugins: EcosystemPlugin[]; mcp: EcosystemReport['mcpServers'] } {
  const plugins: EcosystemPlugin[] = [];
  const mcp: EcosystemReport['mcpServers'] = [];
  let current: { kind: 'plugin'; item: EcosystemPlugin } | { kind: 'mcp'; item: EcosystemReport['mcpServers'][number] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line)?.[1];
    if (header) {
      current = null;
      const plugin = /^plugins\."([^"]+)"$/.exec(header)?.[1];
      const server = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(header);
      if (plugin) {
        const [name, source] = plugin.split('@');
        current = { kind: 'plugin', item: { name, source, enabled: null } };
        plugins.push(current.item);
      } else if (server) {
        current = { kind: 'mcp', item: { name: server[1] || server[2], transport: 'stdio' } };
        mcp.push(current.item);
      }
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'enabled') current.item.enabled = kv[2].startsWith('true');
    if (current.kind === 'mcp' && kv[1] === 'url') current.item.transport = 'http';
  }
  return { plugins, mcp };
}

function inspectCodex(): EcosystemReport {
  const dir = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const report: EcosystemReport = {
    agentId: 'codex',
    name: 'Codex',
    detected: fs.existsSync(dir),
    configPath: dir,
    plugins: [],
    skills: skillsIn(path.join(dir, 'skills'), 'user'),
    mcpServers: [],
    manageHint: 'Manage these with /plugins and /mcp in Codex, or edit config.toml.',
    warnings: [],
  };
  try {
    const { plugins, mcp } = parseCodexToml(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'));
    report.plugins = plugins.sort(byName);
    report.mcpServers = mcp.sort(byName);
  } catch (err: any) {
    if (report.detected && err?.code !== 'ENOENT') report.warnings.push(`Could not read config.toml: ${err.message}`);
  }
  report.skills.sort(byName);
  return report;
}

/** Non-empty lines of an `agy … list` answer, minus its "No … configured" placeholder. */
async function agyList(args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('agy', args, { timeout: 10_000, cwd: HOME });
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^no\b/i.test(l));
}

async function inspectAntigravity(): Promise<EcosystemReport> {
  const dir = path.join(HOME, '.gemini');
  const report: EcosystemReport = {
    agentId: 'antigravity',
    name: 'Google Antigravity',
    detected: fs.existsSync(path.join(dir, 'antigravity')) || fs.existsSync(path.join(dir, 'antigravity-cli')),
    configPath: path.join(dir, 'config'),
    plugins: [],
    skills: [],
    mcpServers: [],
    manageHint: 'Manage these with `agy plugin` and `agy mcp` in a terminal.',
    warnings: [],
  };
  const seen = new Set<string>();
  for (const skillsDir of [
    path.join(dir, 'antigravity-cli', 'builtin', 'skills'),
    path.join(dir, 'antigravity', 'builtin', 'skills'),
  ]) {
    for (const s of skillsIn(skillsDir, 'built-in')) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      report.skills.push(s);
    }
  }
  for (const s of skillsIn(path.join(dir, 'skills'), 'user')) report.skills.push(s);

  if (!onPath('agy')) {
    if (report.detected) report.warnings.push('The agy CLI is not on PATH, so plugins and MCP servers could not be listed.');
  } else {
    const [plugins, servers] = await Promise.allSettled([agyList(['plugin', 'list']), agyList(['mcp', 'list'])]);
    if (plugins.status === 'fulfilled') {
      report.plugins = plugins.value.map((line) => ({ name: line.split(/\s+/)[0], enabled: null })).filter((p) => p.name);
    }
    else report.warnings.push(`agy plugin list failed: ${plugins.reason?.message ?? plugins.reason}`);
    // Keep only the leading name: list lines may go on to show a command or URL
    if (servers.status === 'fulfilled') {
      report.mcpServers = servers.value
        .map((line) => line.split(/[\s:]+/)[0])
        .filter(Boolean)
        .map((name) => ({ name }));
    }
    else report.warnings.push(`agy mcp list failed: ${servers.reason?.message ?? servers.reason}`);
  }
  report.skills.sort(byName);
  return report;
}

export async function inspectEcosystems(force = false): Promise<EcosystemReport[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = [inspectClaude(), inspectCodex(), await inspectAntigravity()];
  cache = { at: Date.now(), value };
  return value;
}
