import React, { useState } from 'react';
import type { EcosystemReport } from '../../types';
import { Badge, Button, Card, EmptyState, Icon, Input, Spinner } from '../../ui';
import { VendorIcon } from '../VendorLogos';
import { withCode } from './McpServerForm';

const PREVIEW = 6;

type Row = { key: string; name: string; meta?: React.ReactNode; description?: string };

const Section: React.FC<{ title: string; rows: Row[]; empty: string; filtering: boolean }> = ({ title, rows, empty, filtering }) => {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded || filtering ? rows : rows.slice(0, PREVIEW);
  return (
    <section className="eco-section" aria-label={title}>
      <div className="eco-section-label">
        {title}
        <span className="eco-section-count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="eco-empty">{empty}</div>
      ) : (
        <ul className="eco-list">
          {shown.map((r) => (
            <li key={r.key} className="eco-item">
              <div className="eco-item-top">
                <span className="eco-item-name mono">{r.name}</span>
                {r.meta}
              </div>
              {r.description && (
                <div className="eco-item-desc" title={r.description}>
                  {r.description}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!filtering && rows.length > PREVIEW && (
        <Button size="sm" variant="ghost" icon={expanded ? 'chevronUp' : 'chevronDown'} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </section>
  );
};

const enabledBadge = (enabled: boolean | null | undefined) =>
  enabled === true ? (
    <Badge tone="ok" dot>
      On
    </Badge>
  ) : enabled === false ? (
    <Badge tone="neutral">Off</Badge>
  ) : null;

const EcosystemCard: React.FC<{ eco: EcosystemReport; query: string }> = ({ eco, query }) => {
  const q = query.trim().toLowerCase();
  const match = (...parts: Array<string | undefined>) => !q || parts.some((p) => p?.toLowerCase().includes(q));

  const plugins: Row[] = eco.plugins
    .filter((p) => match(p.name, p.source, p.description))
    .map((p) => ({
      key: `${p.name}@${p.source}`,
      name: p.name,
      description: p.description,
      meta: (
        <span className="eco-item-meta">
          {p.source && <span className="eco-item-source">{p.source}</span>}
          {p.version && <span className="mono">{p.version}</span>}
          {enabledBadge(p.enabled)}
        </span>
      ),
    }));
  const skills: Row[] = eco.skills
    .filter((s) => match(s.name, s.description, s.plugin))
    .map((s) => ({
      key: `${s.origin}:${s.plugin}:${s.name}`,
      name: s.name,
      description: s.description,
      meta: (
        <span className="eco-item-meta">
          <Badge tone={s.origin === 'user' ? 'accent' : 'neutral'}>{s.origin === 'plugin' ? `from ${s.plugin}` : s.origin === 'user' ? 'Yours' : 'Built in'}</Badge>
        </span>
      ),
    }));
  const servers: Row[] = eco.mcpServers
    .filter((s) => match(s.name))
    .map((s) => ({
      key: s.name,
      name: s.name,
      meta: (
        <span className="eco-item-meta">
          {s.transport && <Badge mono>{s.transport}</Badge>}
          {enabledBadge(s.enabled)}
        </span>
      ),
    }));

  return (
    <Card className="eco-card" padding="none">
      <header className="eco-head">
        <VendorIcon agentId={eco.agentId} size={20} />
        <div className="eco-head-text">
          <div className="eco-name">{eco.name}</div>
          <div className="eco-path mono" title={eco.configPath}>
            {eco.configPath}
          </div>
        </div>
        {eco.detected ? (
          <Badge tone="ok" dot>
            Found
          </Badge>
        ) : (
          <Badge tone="neutral">Not installed</Badge>
        )}
      </header>
      {eco.detected && (
        <div className="eco-body">
          <Section title="Plugins" rows={plugins} empty="No plugins installed." filtering={Boolean(q)} />
          <Section title="Skills" rows={skills} empty="No skills found." filtering={Boolean(q)} />
          <Section title="Its own MCP servers" rows={servers} empty="None configured in the agent itself." filtering={Boolean(q)} />
          {eco.warnings.map((w) => (
            <div key={w} className="mcp-note tone-warn">
              <Icon name="alert" size={13} />
              <div>{w}</div>
            </div>
          ))}
          <p className="eco-hint">{withCode(eco.manageHint)}</p>
        </div>
      )}
    </Card>
  );
};

export const McpEcosystems: React.FC<{
  ecosystems: EcosystemReport[] | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}> = ({ ecosystems, error, refreshing, onRefresh }) => {
  const [query, setQuery] = useState('');
  return (
    <div className="eco">
      <div className="eco-toolbar">
        <p className="eco-intro">
          What each agent loads by itself, on top of the servers above. This view is read-only; change these in the agent.
        </p>
        <div className="eco-toolbar-actions">
          <Input
            type="search"
            value={query}
            placeholder="Filter plugins and skills"
            aria-label="Filter plugins and skills"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button size="md" variant="secondary" icon="refresh" loading={refreshing} onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>
      {error ? (
        <EmptyState icon="alert" title="Couldn't read the agents' settings" description={error} compact />
      ) : !ecosystems ? (
        <div className="mcp-loading">
          <Spinner size={14} /> Reading each agent's plugins and skills…
        </div>
      ) : (
        ecosystems.map((eco) => <EcosystemCard key={eco.agentId} eco={eco} query={query} />)
      )}
    </div>
  );
};
