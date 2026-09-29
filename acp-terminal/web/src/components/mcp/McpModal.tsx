import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { AgentDescriptor, EcosystemReport, McpPreset, McpProbeResult, McpServer, McpServerInput } from '../../types';
import { Badge, Button, EmptyState, Icon, Segmented, Spinner, Switch, Tabs, type IconName } from '../../ui';
import { Modal } from '../Modal';
import { Menu } from '../Menu';
import { AgentFitBadges, CopyButton, McpServerForm, TRANSPORT_LABEL, agentFit, agyCommand } from './McpServerForm';
import { McpCatalog } from './McpCatalog';
import { McpEcosystems } from './McpEcosystems';
import '../../styles/mcp.css';

export type McpTab = 'installed' | 'add' | 'plugins';

const TAB_LABEL: Record<McpTab, string> = {
  installed: 'Installed',
  add: 'Add a server',
  plugins: 'Agent plugins and skills',
};

type Probe = { running: boolean; result?: McpProbeResult; cwd?: string };

/** The line under a server's name: its command line or URL. */
const target = (s: McpServer) => (s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url ?? '');

const PRESET_ICON: Record<string, IconName> = {
  filesystem: 'folder',
  github: 'branch',
  memory: 'brain',
  'brave-search': 'globe',
  sqlite: 'database',
  postgres: 'database',
};

const ProbeStatus: React.FC<{ probe?: Probe }> = ({ probe }) => {
  const [showTools, setShowTools] = useState(false);
  if (!probe) return null;
  if (probe.running) {
    return (
      <div className="mcp-probe" role="status">
        <Spinner size={11} /> Connecting… the first run of npx or uvx can take a minute while it downloads.
      </div>
    );
  }
  const r = probe.result!;
  if (!r.ok) {
    return (
      <div className="mcp-probe tone-danger" role="status">
        <Icon name="xCircle" size={13} />
        <pre className="mcp-probe-error">{r.error}</pre>
      </div>
    );
  }
  const tools = r.tools ?? [];
  return (
    <div className="mcp-probe tone-ok">
      <Icon name="checkCircle" size={13} />
      <span role="status">
        Connected{r.server?.name ? ` to ${r.server.name}${r.server.version ? ` ${r.server.version}` : ''}` : ''} in{' '}
        {(r.durationMs / 1000).toFixed(1)}s.{' '}
        <button type="button" className="mcp-linkbtn" onClick={() => setShowTools(!showTools)} aria-expanded={showTools}>
          {tools.length} tool{tools.length === 1 ? '' : 's'}
        </button>
        {r.error && <span className="mcp-probe-warn"> {r.error}</span>}
      </span>
      {showTools && tools.length > 0 && (
        <ul className="mcp-tools">
          {tools.map((t) => (
            <li key={t.name} title={t.description}>
              <code>{t.name}</code>
              {t.description && <span className="mcp-tools-desc">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ServerRow: React.FC<{
  server: McpServer;
  agents: AgentDescriptor[];
  probe?: Probe;
  /** Agents that already configure an MCP server with this name themselves. */
  clashes: string[];
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ server, agents, probe, clashes, onToggle, onTest, onEdit, onDelete }) => {
  const fits = agentFit(server, agents);
  const agy = fits.some((f) => f.agent.id === 'antigravity') ? agyCommand(server) : null;
  const [showAgy, setShowAgy] = useState(false);
  return (
    <li className={`mcp-server ${server.enabled ? '' : 'is-off'}`}>
      <span className="mcp-server-icon" aria-hidden>
        <Icon name={PRESET_ICON[server.presetId ?? ''] ?? (server.transport === 'stdio' ? 'terminal' : 'globe')} size={16} />
      </span>
      <div className="mcp-server-main">
        <div className="mcp-server-top">
          <span className="mcp-server-name mono">{server.name}</span>
          <Badge mono>{TRANSPORT_LABEL[server.transport]}</Badge>
          {!server.enabled && <Badge>Off</Badge>}
        </div>
        <div className="mcp-server-target mono" title={target(server)}>
          {target(server)}
        </div>
        <div className="mcp-server-fit">
          <AgentFitBadges fits={fits} />
          {agy && (
            <button type="button" className="mcp-linkbtn" onClick={() => setShowAgy(!showAgy)} aria-expanded={showAgy}>
              Use with Antigravity
            </button>
          )}
        </div>
        {showAgy && agy && (
          <div className="mcp-note tone-info">
            <Icon name="info" size={13} />
            <div>
              Antigravity reads MCP servers from its own settings. Run this once in a terminal to add it there
              {agy.includes('<') ? ', after replacing the <PLACEHOLDERS> with the real values' : ''}:
              <div className="mcp-agy">
                <code className="mcp-agy-cmd">{agy}</code>
                <CopyButton text={agy} label="Copy command" />
              </div>
            </div>
          </div>
        )}
        {clashes.length > 0 && (
          <div className="mcp-note tone-warn">
            <Icon name="alert" size={13} />
            <div>
              {clashes.join(' and ')} already {clashes.length === 1 ? 'has' : 'have'} its own MCP server called <code>{server.name}</code>, so
              the tool names would collide. Rename this one, for example to <code>{server.name}-2</code>.
            </div>
          </div>
        )}
        <ProbeStatus probe={probe} />
      </div>
      <div className="mcp-server-actions">
        <Switch checked={server.enabled} onChange={onToggle} label={<span className="sr-only">Use {server.name}</span>} />
        <Button size="sm" variant="ghost" icon="zap" onClick={onTest} loading={probe?.running}>
          Test
        </Button>
        <Menu
          label={`More actions for ${server.name}`}
          size="sm"
          items={[
            { label: 'Edit', icon: 'edit', onSelect: onEdit },
            { label: 'Test connection', icon: 'zap', onSelect: onTest, disabled: probe?.running },
            'divider',
            { label: 'Remove', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </li>
  );
};

export const McpModal: React.FC<{
  agents: AgentDescriptor[];
  /** Folder the Test button uses for ${workspace}: the open session's, if any. */
  workspace?: string;
  initialTab?: McpTab;
  onClose: () => void;
  /** Called whenever the saved server list changes, so the sidebar count stays right. */
  onServersChange: (servers: McpServer[]) => void;
}> = ({ agents, workspace, initialTab = 'installed', onClose, onServersChange }) => {
  const [tab, setTab] = useState<McpTab>(initialTab);
  const [addMode, setAddMode] = useState<'catalog' | 'custom'>('catalog');
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presets, setPresets] = useState<McpPreset[] | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [ecosystems, setEcosystems] = useState<EcosystemReport[] | null>(null);
  const [ecoError, setEcoError] = useState<string | null>(null);
  const [ecoRefreshing, setEcoRefreshing] = useState(false);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Every change derives from the latest list, so overlapping requests can't undo each other
  const update = (fn: (prev: McpServer[]) => McpServer[]) => setServers((prev) => fn(prev ?? []));
  const replace = (server: McpServer) => update((prev) => prev.map((x) => (x.id === server.id ? server : x)));

  const reportServers = useRef(onServersChange);
  reportServers.current = onServersChange;
  useEffect(() => {
    if (servers) reportServers.current(servers);
  }, [servers]);

  useEffect(() => {
    api
      .getMcpServers()
      .then((r) => setServers(r.servers))
      .catch((err) => setLoadError(err.message));
    api
      .getMcpPresets()
      .then((r) => setPresets(r.presets))
      .catch((err) => setPresetError(err.message));
  }, []);

  const loadEcosystems = useCallback((refresh: boolean) => {
    setEcoRefreshing(true);
    setEcoError(null);
    api
      .getEcosystems(refresh)
      .then((r) => setEcosystems(r.ecosystems))
      .catch((err) => setEcoError(err.message))
      .finally(() => setEcoRefreshing(false));
  }, []);

  // Loaded up front too: the Installed tab uses it to spot name clashes with the agents' own servers
  useEffect(() => {
    loadEcosystems(false);
  }, [loadEcosystems]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };

  const run = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err: any) {
      setActionError(err?.message || 'Something went wrong');
    }
  };

  // Latest test run per server; an edit or removal bumps it so an older answer is dropped
  const probeRuns = useRef<Record<string, number>>({});
  const forgetProbe = (id: string) => {
    probeRuns.current[id] = (probeRuns.current[id] ?? 0) + 1;
    setProbes(({ [id]: _drop, ...rest }) => rest);
  };

  const test = (s: McpServer) => {
    const runId = (probeRuns.current[s.id] ?? 0) + 1;
    probeRuns.current[s.id] = runId;
    const settle = (probe: Probe) => {
      if (probeRuns.current[s.id] === runId) setProbes((p) => ({ ...p, [s.id]: probe }));
    };
    setProbes((p) => ({ ...p, [s.id]: { running: true } }));
    api
      .testMcpServer(s.id, workspace)
      .then((r) => settle({ running: false, result: r.result, cwd: r.cwd }))
      .catch((err) => settle({ running: false, result: { ok: false, error: err.message, durationMs: 0 } }));
  };

  const added = (server: McpServer) => {
    update((prev) => [...prev, server]);
    setTab('installed');
    flash(`Added ${server.name}. New agent sessions get it from now on.`);
    test(server);
  };

  const list = servers ?? [];
  const activeCount = list.filter((s) => s.enabled).length;

  return (
    <Modal
      onClose={onClose}
      size="lg"
      className="mcp-dialog"
      bodyClassName="mcp-shell"
      icon="plug"
      heading="MCP and plugins"
      description="Tools your agents can use. Servers added here are given to every new session of the agents they're set for."
      footerStart={
        <span className={`mcp-foot ${notice ? '' : 'is-hint'}`} role="status">
          {notice ? (
            <>
              <Icon name="checkCircle" size={13} /> {notice}
            </>
          ) : (
            'Changes apply when an agent starts. Stop and start a running agent to pick them up.'
          )}
        </span>
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Tabs<McpTab>
        className="mcp-tabs"
        label="MCP and plugins"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'installed', label: TAB_LABEL.installed, icon: 'plug', count: list.length },
          { id: 'add', label: TAB_LABEL.add, icon: 'plus' },
          { id: 'plugins', label: TAB_LABEL.plugins, icon: 'package' },
        ]}
      />

      <div className="mcp-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {actionError && (
          <div className="mcp-note tone-danger" role="alert">
            <Icon name="alert" size={14} />
            <div>{actionError}</div>
          </div>
        )}

        {tab === 'installed' &&
          (loadError ? (
            <EmptyState icon="alert" title="Couldn't load your MCP servers" description={loadError} compact />
          ) : !servers ? (
            <div className="mcp-loading">
              <Spinner size={14} /> Loading…
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon="plug"
              title="No MCP servers yet"
              description="Add one from the catalog, like Filesystem or GitHub, or connect your own."
              action={
                <Button variant="primary" icon="plus" onClick={() => setTab('add')}>
                  Add a server
                </Button>
              }
            />
          ) : (
            <>
              <div className="mcp-summary">
                <span>
                  <strong>{activeCount}</strong> of {list.length} on
                </span>
                <Button size="sm" variant="secondary" icon="plus" onClick={() => setTab('add')}>
                  Add a server
                </Button>
              </div>
              <ul className="mcp-servers">
                {list.map((s) => (
                  <ServerRow
                    key={s.id}
                    server={s}
                    agents={agents}
                    probe={probes[s.id]}
                    clashes={(ecosystems ?? [])
                      .filter((e) => agentFit(s, agents).some((f) => f.ok && f.agent.id === e.agentId))
                      .filter((e) => e.mcpServers.some((m) => m.name.toLowerCase() === s.name.toLowerCase()))
                      .map((e) => e.name)}
                    onToggle={(enabled) =>
                      run(async () => {
                        const r = await api.setMcpServerEnabled(s.id, enabled);
                        replace(r.server);
                      })
                    }
                    onTest={() => test(s)}
                    onEdit={() => setEditing(s)}
                    onDelete={() => setConfirmDelete(s)}
                  />
                ))}
              </ul>
            </>
          ))}

        {tab === 'add' && (
          <>
            <Segmented<'catalog' | 'custom'>
              label="How to add"
              value={addMode}
              onChange={setAddMode}
              options={[
                { value: 'catalog', label: 'Catalog', icon: 'grid' },
                { value: 'custom', label: 'Custom server', icon: 'settings' },
              ]}
            />
            {addMode === 'catalog' ? (
              <McpCatalog
                presets={presets}
                error={presetError}
                servers={list}
                agents={agents}
                onManage={() => setTab('installed')}
                onAdd={async (preset, inputs, scope) => added((await api.addMcpPreset(preset.id, inputs, scope)).server)}
              />
            ) : (
              <McpServerForm
                agents={agents}
                submitLabel="Add server"
                onSubmit={async (data: McpServerInput) => added((await api.createMcpServer(data)).server)}
              />
            )}
          </>
        )}

        {tab === 'plugins' && (
          <McpEcosystems ecosystems={ecosystems} error={ecoError} refreshing={ecoRefreshing} onRefresh={() => loadEcosystems(true)} />
        )}
      </div>

      {editing && (
        <Modal nested onClose={() => setEditing(null)} size="md" icon="edit" heading={`Edit ${editing.name}`}>
          <McpServerForm
            agents={agents}
            initial={editing}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (data) => {
              const r = await api.updateMcpServer(editing.id, data);
              replace(r.server);
              forgetProbe(editing.id);
              setEditing(null);
              flash(`Saved ${r.server.name}.`);
            }}
          />
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          nested
          onClose={() => setConfirmDelete(null)}
          size="sm"
          icon="trash"
          heading={`Remove ${confirmDelete.name}?`}
          description="New agent sessions stop getting its tools. Running agents keep them until they restart."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={() =>
                  run(async () => {
                    await api.deleteMcpServer(confirmDelete.id);
                    const gone = confirmDelete.id;
                    update((prev) => prev.filter((x) => x.id !== gone));
                    forgetProbe(gone);
                    flash(`Removed ${confirmDelete.name}.`);
                    setConfirmDelete(null);
                  })
                }
              >
                Remove
              </Button>
            </>
          }
        >
          {null}
        </Modal>
      )}
    </Modal>
  );
};
