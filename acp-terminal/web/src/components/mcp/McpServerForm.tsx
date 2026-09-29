import React, { useId, useState } from 'react';
import type { AgentDescriptor, McpServer, McpServerInput, McpTransport } from '../../types';
import { MCP_MASK, WORKSPACE_VAR } from '../../types';
import { Badge, Button, Field, Icon, IconButton, Input, Segmented, Switch, Textarea } from '../../ui';
import { VendorIcon } from '../VendorLogos';

// ------------------------------------------------------------------ helpers

export const TRANSPORT_LABEL: Record<McpTransport, string> = { stdio: 'Command', http: 'HTTP', sse: 'SSE' };

/** Agents an MCP server can target; the demo agent only shows up when it's enabled. */
export const scopeAgents = (agents: AgentDescriptor[]) => agents.filter((a) => a.id !== 'mock' || agents.length === 1);

export const shortAgentName = (a: Pick<AgentDescriptor, 'id' | 'name'>) =>
  a.name.replace(/\s*\(ACP\)$/, '').replace(/^Google /, '').replace(/ CLI$/, '');

export interface AgentFit {
  agent: AgentDescriptor;
  ok: boolean;
  reason?: string;
}

/** Which agents get this server, and why the others don't. */
export function agentFit(server: Pick<McpServer, 'transport' | 'scope'>, agents: AgentDescriptor[]): AgentFit[] {
  const targets = server.scope === 'all' ? scopeAgents(agents) : agents.filter((a) => a.id === server.scope);
  return targets.map((agent) => {
    const transports = agent.mcpSupport?.transports;
    if (!transports) return { agent, ok: true };
    if (transports.length === 0) return { agent, ok: false, reason: agent.mcpSupport?.note || 'Takes no MCP servers from this app' };
    if (!transports.includes(server.transport)) {
      return { agent, ok: false, reason: `Takes only ${transports.map((t) => TRANSPORT_LABEL[t]).join(' and ')} servers.` };
    }
    return { agent, ok: true };
  });
}

/** Plain text with `backtick` spans shown as inline code (agent notes use them for commands). */
export const withCode = (text?: string): React.ReactNode =>
  text?.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

const shellQuote = (s: string) => (/^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The `agy mcp add` line that gives Antigravity the same server. Masked secrets
 * become <KEY> placeholders; the browser never has the real values.
 */
export function agyCommand(s: Pick<McpServer, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'>): string | null {
  if (s.transport === 'sse') return null;
  const value = (k: string, v: string) => v.split(MCP_MASK).join(`<${k}>`);
  const parts = ['agy', 'mcp', 'add'];
  for (const [k, v] of Object.entries(s.env ?? {})) parts.push('--env', shellQuote(`${k}=${value(k, v)}`));
  for (const [k, v] of Object.entries(s.headers ?? {})) parts.push('--header', shellQuote(`${k}: ${value(k, v)}`));
  parts.push(shellQuote(s.name));
  if (s.transport === 'stdio') {
    const rest = [s.command ?? '', ...(s.args ?? [])];
    if (rest.some((a) => a.startsWith('-'))) parts.push('--');
    parts.push(...rest.map((a) => shellQuote(value('SECRET', a))));
  } else {
    parts.push(shellQuote(value('SECRET', s.url ?? '')));
  }
  return parts.join(' ');
}

export const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label = 'Copy' }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? 'check' : 'copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
};

// ------------------------------------------------------------------ key/value rows

type Row = { key: string; value: string };
const toRows = (rec?: Record<string, string>): Row[] => Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
const toRecord = (rows: Row[]) =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])) as Record<string, string>;

const SECRET_KEY = /key|token|secret|pass|auth|cred|cookie|session|uri|url|dsn|conn/i;

// Renaming a key whose value is a saved secret clears the value: the server can only
// keep a masked value under its original name.
const KeyValueRows: React.FC<{
  label: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  separator: string;
  /** Treat every value as secret (headers), not just secret-looking keys. */
  allSecret?: boolean;
  addLabel: string;
}> = ({ label, rows, onChange, keyPlaceholder, valuePlaceholder, separator, allSecret, addLabel }) => {
  const set = (i: number, patch: Partial<Row>) =>
    onChange(
      rows.map((r, j) =>
        j !== i ? r : { ...r, ...patch, ...(patch.key !== undefined && r.value === MCP_MASK ? { value: '' } : {}) }
      )
    );
  return (
    <div className="mcp-kv" role="group" aria-label={label}>
      {rows.map((r, i) => {
        const secret = allSecret || SECRET_KEY.test(r.key) || r.value === MCP_MASK;
        return (
          <div className="mcp-kv-row" key={i}>
            <Input
              mono
              value={r.key}
              placeholder={keyPlaceholder}
              aria-label={`${label} ${i + 1} name`}
              onChange={(e) => set(i, { key: e.target.value })}
            />
            <span className="mcp-kv-sep" aria-hidden>
              {separator}
            </span>
            <Input
              mono
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              value={r.value}
              placeholder={valuePlaceholder}
              aria-label={`${label} ${i + 1} value`}
              // A saved secret shows as dots; focusing it clears the field so typing replaces it
              onFocus={(e) => r.value === MCP_MASK && e.currentTarget.select()}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <IconButton icon="x" size="sm" label={`Remove ${r.key || 'row'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        {addLabel}
      </Button>
    </div>
  );
};

// ------------------------------------------------------------------ form

export const McpServerForm: React.FC<{
  agents: AgentDescriptor[];
  initial?: McpServer;
  submitLabel: string;
  onSubmit: (data: McpServerInput) => Promise<void>;
  onCancel?: () => void;
}> = ({ agents, initial, submitLabel, onSubmit, onCancel }) => {
  const uid = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'));
  const [env, setEnv] = useState<Row[]>(toRows(initial?.env));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [headers, setHeaders] = useState<Row[]>(toRows(initial?.headers));
  const [scope, setScope] = useState(initial?.scope ?? 'all');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data: McpServerInput = {
    name: name.trim(),
    transport,
    enabled,
    scope,
    presetId: initial?.presetId,
    description: initial?.description,
    ...(transport === 'stdio'
      ? { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean), env: toRecord(env) }
      : { url: url.trim(), headers: toRecord(headers) }),
  };
  const fits = agentFit(data, agents);
  const blocked = fits.filter((f) => !f.ok);
  const agy = fits.some((f) => f.agent.id === 'antigravity') ? agyCommand(data) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(data);
    } catch (err: any) {
      setError(err?.message || 'Could not save the server');
    } finally {
      setSaving(false);
    }
  };

  const scopeOptions = [
    { value: 'all', label: 'All agents' },
    ...scopeAgents(agents).map((a) => ({ value: a.id, label: shortAgentName(a) })),
  ];

  return (
    <form className="mcp-form" onSubmit={submit} noValidate>
      <div className="mcp-form-grid">
        <Field label="Name" htmlFor={`${uid}-name`} hint="Letters, digits, - and _. Agents list the tools under this name.">
          <Input
            id={`${uid}-name`}
            mono
            value={name}
            placeholder="my-server"
            onChange={(e) => setName(e.target.value)}
            autoFocus={!initial}
            required
          />
        </Field>
        <Field label="Connects over">
          <Segmented<McpTransport>
            label="Transport"
            value={transport}
            onChange={setTransport}
            block
            options={[
              { value: 'stdio', label: 'Command', icon: 'terminal', title: 'Start a local program and talk over stdin/stdout' },
              { value: 'http', label: 'HTTP', icon: 'globe', title: 'Streamable HTTP endpoint' },
              { value: 'sse', label: 'SSE', icon: 'globe', title: 'Older HTTP + server-sent events endpoint' },
            ]}
          />
        </Field>
      </div>

      {transport === 'stdio' ? (
        <>
          <Field label="Command" htmlFor={`${uid}-cmd`} hint="The program to run, e.g. npx, uvx, docker or an absolute path.">
            <Input id={`${uid}-cmd`} mono value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field
            label="Arguments"
            htmlFor={`${uid}-args`}
            hint={
              <>
                One per line. <code>{WORKSPACE_VAR}</code> becomes the session's folder.
              </>
            }
          >
            <Textarea
              id={`${uid}-args`}
              className="mono"
              rows={3}
              value={args}
              placeholder={`-y\n@modelcontextprotocol/server-filesystem\n${WORKSPACE_VAR}`}
              onChange={(e) => setArgs(e.target.value)}
            />
          </Field>
          <Field label="Environment variables" hint={env.some((r) => r.value === MCP_MASK) ? 'Saved secrets show as dots. Leave them to keep the saved value.' : undefined}>
            <KeyValueRows
              label="Environment variable"
              rows={env}
              onChange={setEnv}
              keyPlaceholder="API_KEY"
              valuePlaceholder="value"
              separator="="
              addLabel="Add variable"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" htmlFor={`${uid}-url`}>
            <Input
              id={`${uid}-url`}
              mono
              type="url"
              value={url}
              placeholder={transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Headers" hint={headers.length ? 'Header values are stored privately and never shown again.' : 'For example an Authorization header with a bearer token.'}>
            <KeyValueRows
              label="Header"
              rows={headers}
              onChange={setHeaders}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              separator=":"
              allSecret
              addLabel="Add header"
            />
          </Field>
        </>
      )}

      <Field label="Available to">
        <Segmented label="Agents that get this server" value={scope} onChange={setScope} options={scopeOptions} block />
      </Field>

      {blocked.length > 0 && (
        <div className="mcp-note tone-warn" role="note">
          <Icon name="info" size={14} />
          <div>
            {blocked.map((f) => (
              <div key={f.agent.id}>
                <strong>{shortAgentName(f.agent)}</strong> won't get it. {withCode(f.reason)}
              </div>
            ))}
            {agy && (
              <div className="mcp-agy">
                <code className="mcp-agy-cmd">{agy}</code>
                <CopyButton text={agy} label="Copy command" />
              </div>
            )}
          </div>
        </div>
      )}

      <Switch checked={enabled} onChange={setEnabled} label="On" description="Give it to new agent sessions. Turn off to keep the settings without using them." />

      {error && (
        <div className="mcp-note tone-danger" role="alert">
          <Icon name="alert" size={14} />
          <div>{error}</div>
        </div>
      )}

      <div className="mcp-form-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={saving} disabled={!data.name}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};

/** Vendor marks for the agents a server reaches, with the ones it can't reach struck through. */
export const AgentFitBadges: React.FC<{ fits: AgentFit[] }> = ({ fits }) => (
  <span className="mcp-fit">
    {fits.map((f) => (
      <Badge key={f.agent.id} tone={f.ok ? 'neutral' : 'warn'} title={f.ok ? `${f.agent.name} gets this server` : `${f.agent.name}: ${f.reason?.replace(/`/g, '')}`}>
        <VendorIcon agentId={f.agent.id} size={11} />
        <span className={f.ok ? undefined : 'mcp-fit-off'}>{shortAgentName(f.agent)}</span>
      </Badge>
    ))}
  </span>
);
