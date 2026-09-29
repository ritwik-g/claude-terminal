import React, { useMemo } from 'react';
import type { AcpSession, TurnMessage, VendorRateLimits } from '../types';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { usageMetrics, formatCost, formatTokens, formatWindow, formatRate, levelTone } from '../pricing';
import { Badge, Button, Card, EmptyState, Icon, Progress, SectionHeader, Stat, type Tone } from '../ui';
import '../styles/usage.css';

/* ------------------------------------------------------------ Shared parts */

const limitTone = (pct: number) => levelTone(pct);

/** One rate-limit window: label, "42% used · Resets 3pm", and a bar. */
export const LimitMeter: React.FC<{ label: string; utilization: number; resetsAt?: string | null }> = ({
  label,
  utilization,
  resetsAt,
}) => {
  const pct = Math.max(0, Math.min(100, Math.round(utilization)));
  const tone = limitTone(pct);
  return (
    <div className="usg-limit">
      <div className="usg-limit-head">
        <span className="usg-limit-label">{label}</span>
        <span className="usg-limit-value">
          <span className={`usg-limit-pct tone-${tone}`}>{pct}% used</span>
          {resetsAt && <span className="usg-limit-reset">Resets {resetsAt}</span>}
        </span>
      </div>
      <Progress value={pct} tone={tone} label={`${label}: ${pct}% used`} />
    </div>
  );
};

/** The 5-hour, weekly and per-model windows a vendor reports. */
export const RateLimitList: React.FC<{ limits: VendorRateLimits }> = ({ limits }) => (
  <div className="usg-limits">
    {limits.fiveHour && <LimitMeter label="5-hour window" {...limits.fiveHour} />}
    {limits.weeklyAll && <LimitMeter label="Weekly, all models" {...limits.weeklyAll} />}
    {limits.weeklyModels?.map((wm) => (
      <LimitMeter key={wm.name} label={`Weekly, ${wm.name}`} utilization={wm.utilization} resetsAt={wm.resetsAt} />
    ))}
  </div>
);

export const hasRateLimits = (limits?: VendorRateLimits | null): limits is VendorRateLimits =>
  Boolean(limits && (limits.fiveHour || limits.weeklyAll || limits.weeklyModels?.length));

/* --------------------------------------------------------------- Turn rows */

/** Flatten markdown to one plain line for the per-turn summary. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<usage>[\s\S]*?<\/usage>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function turnSummary(t: TurnMessage): { text: string; kind: 'text' | 'thinking' | 'tools' | 'empty' } {
  const text = t.content ? stripMarkdown(t.content) : '';
  if (text) return { text, kind: 'text' };
  const tools = t.toolCalls || [];
  if (tools.length > 0) {
    const titles = tools
      .slice(0, 3)
      .map((tc) => tc.title)
      .join(', ');
    return { text: tools.length > 3 ? `${titles} and ${tools.length - 3} more` : titles, kind: 'tools' };
  }
  const thoughts = t.thoughts ? stripMarkdown(t.thoughts) : '';
  if (thoughts) return { text: thoughts, kind: 'thinking' };
  return { text: t.role === 'system' ? 'System event' : 'No text', kind: 'empty' };
}

const ROLE: Record<TurnMessage['role'], { label: string; tone: Tone }> = {
  user: { label: 'You', tone: 'accent' },
  agent: { label: 'Agent', tone: 'neutral' },
  system: { label: 'System', tone: 'info' },
};

function formatTurnTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

const TurnList: React.FC<{ turns: TurnMessage[] }> = ({ turns }) => (
  <div className="usg-turns-wrap">
    <table className="usg-turns">
      <colgroup>
        <col className="usg-col-idx" />
        <col className="usg-col-role" />
        <col />
        <col className="usg-col-tools" />
        <col className="usg-col-time" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="usg-num">
            #
          </th>
          <th scope="col">Role</th>
          <th scope="col">Summary</th>
          <th scope="col" className="usg-num">
            Tools
          </th>
          <th scope="col" className="usg-num usg-col-time-cell">
            Time
          </th>
        </tr>
      </thead>
      <tbody>
        {turns.map((t, idx) => {
          const summary = turnSummary(t);
          const tools = t.toolCalls?.length || 0;
          const role = ROLE[t.role] || ROLE.system;
          return (
            <tr key={t.id}>
              <td className="usg-num usg-idx">{idx + 1}</td>
              <td>
                <Badge tone={role.tone}>{role.label}</Badge>
              </td>
              <td className={`usg-summary is-${summary.kind}`} title={summary.text}>
                {summary.kind === 'thinking' && <Icon name="brain" size={12} />}
                {summary.kind === 'tools' && <Icon name="tool" size={12} />}
                <span>{summary.text}</span>
              </td>
              <td className="usg-num">
                {tools > 0 ? (
                  <span className="usg-tools">{tools}</span>
                ) : (
                  <>
                    <span className="usg-muted" aria-hidden="true">
                      –
                    </span>
                    <span className="sr-only">None</span>
                  </>
                )}
              </td>
              <td className="usg-num usg-time usg-col-time-cell">
                <time dateTime={new Date(t.timestamp).toISOString()}>{formatTurnTime(t.timestamp)}</time>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

/* ---------------------------------------------------------------- The tab */

/** The session's Usage tab: context window, token counts, spend and per-turn impact. */
export const UsageTab: React.FC<{
  session: AcpSession;
  onOpenSubscriptionsModal?: () => void;
  onCompact: () => void;
  compacting: boolean;
}> = ({ session, onOpenSubscriptionsModal, onCompact, compacting }) => {
  const { pricing, inputTokens, outputTokens, cachedTokens, contextTokens, percentContext, estimatedCost } =
    usageMetrics(session);
  const modelMeta = getModelMeta(session.model || 'sonnet');
  const isFree = pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0;
  const hasUsage = inputTokens + outputTokens + contextTokens > 0;
  const tone = levelTone(percentContext);
  const tokensLeft = Math.max(0, pricing.contextWindow - contextTokens);
  const toolTotal = useMemo(() => session.turns.reduce((n, t) => n + (t.toolCalls?.length || 0), 0), [session.turns]);

  return (
    <div className="usg-tab">
      <div className="usg-col">
        {hasUsage ? (
          <>
            <Card className={`usg-context tone-${tone}`} padding="lg">
              <div className="usg-context-head">
                <div>
                  <div className="usg-eyebrow">Context window</div>
                  <div className="usg-context-sub">
                    <span className="usg-strong">{contextTokens.toLocaleString()}</span> of{' '}
                    {pricing.contextWindow.toLocaleString()} tokens in use
                  </div>
                </div>
                <div className={`usg-context-pct tone-${tone}`}>
                  {percentContext}
                  <span className="usg-context-pct-sign">%</span>
                </div>
              </div>
              <div className="usg-context-bar">
                <Progress value={percentContext} tone={tone} label="Context window used" />
              </div>
              <div className="usg-context-foot">
                <span className="usg-context-left">
                  {tokensLeft.toLocaleString()} tokens left
                  {tone === 'danger' && (
                    <span className="usg-context-warning"> · the agent may start losing early turns</span>
                  )}
                </span>
                {percentContext > 50 && (
                  <Button
                    size="sm"
                    variant={tone === 'danger' ? 'primary' : 'secondary'}
                    icon="layers"
                    onClick={onCompact}
                    loading={compacting}
                    disabled={session.turns.length <= 1}
                    title="Summarise earlier turns to free up context"
                  >
                    {compacting ? 'Compacting' : 'Compact conversation'}
                  </Button>
                )}
              </div>
            </Card>

            <div className="usg-stats">
              <Card className="usg-stat" padding="md">
                <Stat label="Input" value={formatTokens(inputTokens)} hint="Prompts and tool results" />
              </Card>
              <Card className="usg-stat" padding="md">
                <Stat label="Output" value={formatTokens(outputTokens)} hint="Replies and reasoning" />
              </Card>
              <Card className="usg-stat" padding="md">
                <Stat label="Cached" value={formatTokens(cachedTokens)} hint="From the prompt cache" />
              </Card>
              <Card className="usg-stat" padding="md">
                <Stat
                  label="Estimated cost"
                  value={formatCost(estimatedCost)}
                  tone={isFree ? undefined : 'ok'}
                  hint={isFree ? 'Runs locally, no charge' : `${pricing.basis} list price`}
                />
              </Card>
            </div>
          </>
        ) : (
          <Card padding="none">
            <EmptyState
              icon="gauge"
              title="No usage yet"
              description="Context, token counts and cost appear here after the agent's first reply."
            />
          </Card>
        )}

        <Card className="usg-model" padding="lg">
          <div className="usg-model-head">
            <span className="usg-model-mark">
              <VendorIcon agentId={session.agentId} size={20} />
            </span>
            <div className="usg-model-title">
              <div className="usg-model-name">{modelMeta.label || session.model || 'Default model'}</div>
              <div className="usg-model-agent">{session.agentName}</div>
            </div>
            {onOpenSubscriptionsModal && (
              <Button
                className="usg-model-link"
                size="sm"
                variant="ghost"
                iconRight="arrowRight"
                onClick={onOpenSubscriptionsModal}
              >
                Accounts and usage
              </Button>
            )}
          </div>
          <dl className="usg-dl">
            <dt>Model id</dt>
            <dd>
              <code className="usg-mono">{session.model || 'default'}</code>
            </dd>
            <dt>Context window</dt>
            <dd>{formatWindow(pricing.contextWindow)} tokens</dd>
            <dt>Pricing</dt>
            <dd>{isFree ? 'Free' : formatRate(pricing)}</dd>
            <dt>Workspace</dt>
            <dd>
              <code className="usg-mono usg-ellipsis" title={session.cwd}>
                {session.cwd}
              </code>
            </dd>
          </dl>
        </Card>

        {hasRateLimits(session.rateLimits) && (
          <Card className="usg-plan" padding="lg">
            <SectionHeader
              title="Plan limits"
              description="Rolling usage windows on your subscription"
              actions={
                onOpenSubscriptionsModal && (
                  <Button size="sm" variant="ghost" onClick={onOpenSubscriptionsModal}>
                    Manage
                  </Button>
                )
              }
            />
            <RateLimitList limits={session.rateLimits} />
          </Card>
        )}

        {session.turns.length > 0 && (
          <section className="usg-turns-section" aria-labelledby="usg-turns-title">
            <div className="usg-turns-title-row">
              <h3 id="usg-turns-title" className="usg-section-title">
                Turns
              </h3>
              <span className="usg-section-meta">
                {session.turns.length} {session.turns.length === 1 ? 'turn' : 'turns'} · {toolTotal}{' '}
                {toolTotal === 1 ? 'tool call' : 'tool calls'}
              </span>
            </div>
            <TurnList turns={session.turns} />
          </section>
        )}
      </div>
    </div>
  );
};
