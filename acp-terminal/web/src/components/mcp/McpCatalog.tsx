import React, { useId, useState } from 'react';
import type { AgentDescriptor, McpPreset, McpServer } from '../../types';
import { Button, Card, EmptyState, Field, Icon, Input, Segmented, Spinner, type IconName } from '../../ui';
import { AgentFitBadges, agentFit, scopeAgents, shortAgentName, withCode } from './McpServerForm';

const PresetCard: React.FC<{
  preset: McpPreset;
  agents: AgentDescriptor[];
  added?: McpServer;
  onAdd: (preset: McpPreset, inputs: Record<string, string>, scope: string) => Promise<void>;
  onManage: () => void;
}> = ({ preset, agents, added, onAdd, onManage }) => {
  const uid = useId();
  const needsSetup = Boolean(preset.inputs?.length);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd(preset, values, scope);
      setOpen(false);
      setValues({});
    } catch (err: any) {
      setError(err?.message || 'Could not add the server');
    } finally {
      setBusy(false);
    }
  };

  const missing = (preset.inputs ?? []).some((i) => !i.defaultValue && !values[i.key]?.trim());

  return (
    <Card className={`mcp-preset ${open ? 'is-open' : ''}`} padding="md">
      <div className="mcp-preset-head">
        <span className="mcp-preset-icon" aria-hidden>
          <Icon name={preset.icon as IconName} size={18} />
        </span>
        <div className="mcp-preset-title">
          <span className="mcp-preset-name">{preset.name}</span>
          <span className="mcp-preset-cat">{preset.category}</span>
        </div>
        {added ? (
          <Button size="sm" variant="ghost" icon="checkCircle" onClick={onManage} title="Show it in Installed">
            Added
          </Button>
        ) : needsSetup ? (
          <Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Cancel' : 'Set up'}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="plus" loading={busy} onClick={add}>
            Add
          </Button>
        )}
      </div>
      <p className="mcp-preset-desc">{preset.description}</p>
      <div className="mcp-preset-foot">
        {/* Antigravity's gap applies to every preset, so the catalog says it once at the top */}
        <AgentFitBadges fits={agentFit({ transport: preset.transport, scope: 'all' }, agents).filter((f) => !f.ok && f.agent.id !== 'antigravity')} />
        <a className="mcp-link" href={preset.docsUrl} target="_blank" rel="noreferrer">
          Docs <Icon name="external" size={11} />
        </a>
      </div>
      {!preset.available && preset.requires && (
        <div className="mcp-note tone-warn">
          <Icon name="alert" size={13} />
          <div>
            Needs <code>{preset.requires}</code> on this computer's PATH.
            {preset.requires === 'uvx' && ' Install uv from docs.astral.sh/uv.'}
            {preset.requires === 'npx' && ' Install Node.js from nodejs.org.'}
          </div>
        </div>
      )}
      {error && !open && (
        <div className="mcp-note tone-danger" role="alert">
          <Icon name="alert" size={13} />
          <div>{error}</div>
        </div>
      )}

      {open && (
        <form
          className="mcp-preset-setup"
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing) void add();
          }}
        >
          {preset.inputs!.map((input, i) => (
            <Field key={input.key} label={input.label} htmlFor={`${uid}-${input.key}`} hint={input.hint}>
              <Input
                id={`${uid}-${input.key}`}
                mono
                type={input.secret ? 'password' : 'text'}
                autoComplete="off"
                autoFocus={i === 0}
                placeholder={input.placeholder}
                value={values[input.key] ?? ''}
                onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}
              />
            </Field>
          ))}
          <Field label="Available to">
            <Segmented
              label="Agents that get this server"
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'all', label: 'All agents' },
                ...scopeAgents(agents).map((a) => ({ value: a.id, label: shortAgentName(a) })),
              ]}
            />
          </Field>
          {error && (
            <div className="mcp-note tone-danger" role="alert">
              <Icon name="alert" size={13} />
              <div>{error}</div>
            </div>
          )}
          <div className="mcp-form-actions">
            <Button type="submit" variant="primary" icon="plus" loading={busy} disabled={missing}>
              Add {preset.name}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
};

export const McpCatalog: React.FC<{
  presets: McpPreset[] | null;
  error: string | null;
  servers: McpServer[];
  agents: AgentDescriptor[];
  onAdd: (preset: McpPreset, inputs: Record<string, string>, scope: string) => Promise<void>;
  onManage: () => void;
}> = ({ presets, error, servers, agents, onAdd, onManage }) => {
  if (error) return <EmptyState icon="alert" title="Couldn't load the catalog" description={error} compact />;
  if (!presets) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Loading the catalog…
      </div>
    );
  }
  const antigravity = agents.find((a) => a.id === 'antigravity' && a.mcpSupport?.transports.length === 0);
  return (
    <>
      {antigravity && (
        <div className="mcp-note tone-info">
          <Icon name="info" size={13} />
          <div>
            Claude Code and Codex get these servers in every new session. {withCode(antigravity.mcpSupport?.note)} Each server you add shows the
            command for it.
          </div>
        </div>
      )}
      <div className="mcp-catalog">
      {presets.map((p) => (
        <PresetCard
          key={p.id}
          preset={p}
          agents={agents}
          added={servers.find((s) => s.presetId === p.id)}
          onAdd={onAdd}
          onManage={onManage}
        />
      ))}
      </div>
    </>
  );
};

