import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import type { VendorSubscriptionInfo, StoredCredentials, UsageReport } from '../types';
import { VendorIcon } from './VendorLogos';
import { RateLimitList, hasRateLimits } from './UsageTab';
import { formatCost, formatTokens, levelTone } from '../pricing';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Input,
  Progress,
  Segmented,
  Spinner,
  Stat,
  Tabs,
  type Tone,
} from '../ui';
import '../styles/usage.css';

interface SubscriptionsUsageModalProps {
  onClose: () => void;
  onSelectSession?: (sessionId: string) => void;
  initialTab?: 'subscriptions' | 'usage';
}

type VendorKey = 'anthropic' | 'openai' | 'google';
type Subscriptions = Record<VendorKey, VendorSubscriptionInfo>;
type AuthMode = 'subscription' | 'api_key' | 'desktop';
type TabId = 'subscriptions' | 'usage';

const FORM_ID = 'acct-credentials-form';

interface VendorSpec {
  key: VendorKey;
  agentId: string;
  name: string;
  maker: string;
  /** The sign-in method that doesn't need an API key. */
  accountMode: 'subscription' | 'desktop';
  accountModeLabel: string;
  /** How the hint refers to the account method, e.g. "your Claude subscription". */
  accountModePhrase: string;
  keyLabel: string;
  keyPlaceholder: string;
  envVar: string;
  loginCommand?: string;
  loginHint: string;
  note?: string;
}

const VENDORS: VendorSpec[] = [
  {
    key: 'anthropic',
    agentId: 'claude',
    name: 'Claude Code',
    maker: 'Anthropic',
    accountMode: 'subscription',
    accountModeLabel: 'Claude subscription',
    accountModePhrase: 'your Claude subscription',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-api03-…',
    envVar: 'ANTHROPIC_API_KEY',
    loginCommand: 'claude login',
    loginHint: 'To switch accounts or renew credentials, run',
  },
  {
    key: 'openai',
    agentId: 'codex',
    name: 'Codex',
    maker: 'OpenAI',
    accountMode: 'subscription',
    accountModeLabel: 'ChatGPT subscription',
    accountModePhrase: 'your ChatGPT subscription',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    envVar: 'OPENAI_API_KEY',
    loginCommand: 'codex login',
    loginHint: 'To switch accounts or ChatGPT plans, run',
  },
  {
    key: 'google',
    agentId: 'antigravity',
    name: 'Antigravity and Gemini',
    maker: 'Google',
    accountMode: 'desktop',
    accountModeLabel: 'Antigravity desktop',
    accountModePhrase: 'the Antigravity desktop account',
    keyLabel: 'Gemini API key',
    keyPlaceholder: 'AIzaSy…',
    envVar: 'GEMINI_API_KEY',
    loginHint: 'To switch Google accounts, change the account in the Antigravity desktop app.',
    note: 'Antigravity manages its 5-hour and weekly quotas itself. Its status bar shows what is left.',
  },
];

const STATUS: Record<VendorSubscriptionInfo['status'], { label: string; tone: Tone }> = {
  active: { label: 'Signed in', tone: 'ok' },
  configured: { label: 'API key set', tone: 'info' },
  unconfigured: { label: 'Not set up', tone: 'neutral' },
  expired: { label: 'Sign-in expired', tone: 'warn' },
};

const serverMode = (spec: VendorSpec, sub?: VendorSubscriptionInfo): AuthMode =>
  sub?.authMode === 'api_key' ? 'api_key' : spec.accountMode;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err || 'Unknown error'));

/* ------------------------------------------------------------ Small parts */

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  // Plain-http LAN access has no async clipboard.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const CopyCommand: React.FC<{ command: string }> = ({ command }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onCopy = async () => {
    if (await copyText(command)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <span className="acct-cmd">
      <code>{command}</code>
      <button
        type="button"
        className={`acct-cmd-copy${copied ? ' is-copied' : ''}`}
        onClick={onCopy}
        aria-label={copied ? `Copied ${command}` : `Copy login command: ${command}`}
        title={copied ? 'Copied' : 'Copy login command'}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
      <span className="sr-only" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </span>
  );
};

/** A grey placeholder block; its size comes from the `is-*` class. */
const Skel: React.FC<{ className: string }> = ({ className }) => <span className={`acct-skel ${className}`} />;

/** Announces loading once to screen readers; the skeleton itself is decorative. */
const Loading: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="acct-loading" role="status" aria-busy="true">
    <span className="sr-only">{label}</span>
    <div className="acct-loading-body" aria-hidden="true">
      {children}
    </div>
  </div>
);

const AccountsSkeleton: React.FC = () => (
  <Loading label="Loading your accounts">
    {[0, 1, 2].map((i) => (
      <Card key={i} padding="none" className="acct-card">
        <div className="acct-card-head">
          <Skel className="is-mark" />
          <div className="acct-skel-stack">
            <Skel className="is-title" />
            <Skel className="is-sub" />
          </div>
          <Skel className="is-pill" />
        </div>
        <div className="acct-card-section">
          {[0, 1, 2].map((r) => (
            <div key={r} className="acct-skel-row">
              <Skel className="is-label" />
              <Skel className={r === 1 ? 'is-value-long' : 'is-value'} />
            </div>
          ))}
        </div>
      </Card>
    ))}
  </Loading>
);

const UsageSkeleton: React.FC = () => (
  <Loading label="Loading usage">
    <div className="acct-stats">
      {[0, 1, 2].map((i) => (
        <Card key={i} padding="md" className="acct-skel-stack">
          <Skel className="is-label" />
          <Skel className="is-stat" />
          <Skel className="is-sub" />
        </Card>
      ))}
    </div>
    <Card padding="none">
      <div className="acct-split-wrap">
        <Skel className="is-split" />
      </div>
      <div className="acct-vendor-rows">
        {[0, 1, 2].map((i) => (
          <div key={i} className="acct-vendor-row">
            <div className="acct-vendor-name">
              <Skel className="is-icon" />
              <Skel className="is-name" />
            </div>
            <div className="acct-vendor-bar">
              <Skel className="is-bar" />
            </div>
            <Skel className="is-num" />
            <Skel className="is-num" />
          </div>
        ))}
      </div>
    </Card>
  </Loading>
);

const LoadError: React.FC<{ what: string; message: string; onRetry: () => void }> = ({ what, message, onRetry }) => (
  <Card padding="none">
    <EmptyState
      icon="alert"
      title={`Couldn't load ${what}`}
      description={`${message}. Check that CodePit's server is running, then try again.`}
      action={
        <Button icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  </Card>
);

/* ----------------------------------------------------------- Vendor card */

const VendorCard: React.FC<{
  spec: VendorSpec;
  sub?: VendorSubscriptionInfo;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  refreshingLimits?: boolean;
  refreshError?: string | null;
  onRefreshLimits?: () => void;
}> = ({ spec, sub, mode, onModeChange, apiKey, onApiKeyChange, refreshingLimits, refreshError, onRefreshLimits }) => {
  const status = STATUS[sub?.status || 'unconfigured'];
  const statusLabel = spec.key === 'google' && sub?.status === 'active' ? 'Desktop app connected' : status.label;
  const keyId = `acct-key-${spec.key}`;
  const d = sub?.details || {};

  const rows: Array<[string, React.ReactNode]> = [['Plan', sub?.planName || 'Unknown']];
  if (spec.key === 'anthropic') {
    rows.push(['Account', sub?.accountEmail || sub?.accountName || 'CLI default profile']);
    if (sub?.organization) rows.push(['Organization', sub.organization]);
    rows.push([
      'Credentials',
      <>
        <code className="usg-mono">{d.loginFile || '~/.claude.json'}</code>
        {d.billingType && <span className="usg-muted"> · {String(d.billingType).replace(/_/g, ' ')}</span>}
      </>,
    ]);
  } else if (spec.key === 'openai') {
    rows.push(['Sign-in', d.authMode ? `ChatGPT OAuth (${d.authMode})` : 'ChatGPT OAuth']);
    rows.push(['Credentials', <code className="usg-mono">{d.configPath || '~/.codex/auth.json'}</code>]);
  } else {
    rows.push(['Daemon', <code className="usg-mono">{d.agentApiPath || '~/.gemini/antigravity/bin/agentapi'}</code>]);
    rows.push(['App data', <code className="usg-mono">~/.gemini/antigravity</code>]);
  }

  const showLimits = (spec.key === 'anthropic' || spec.key === 'openai') && (hasRateLimits(sub?.rateLimits) || mode !== 'api_key');

  return (
    <Card className="acct-card" padding="none">
      <div className="acct-card-head">
        <span className="acct-card-mark">
          <VendorIcon agentId={spec.agentId} size={20} />
        </span>
        <div className="acct-card-title">
          <div className="acct-card-name">{spec.name}</div>
          <div className="acct-card-plan">{spec.maker}</div>
        </div>
        <Badge tone={status.tone} dot>
          {statusLabel}
        </Badge>
      </div>

      <div className="acct-card-section">
        <dl className="usg-dl acct-dl-stack">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>

      {showLimits && (
        <div className="acct-card-section">
          <div className="acct-card-section-head">
            <span className="acct-card-section-title">Plan limits</span>
            {onRefreshLimits && (
              <Button size="sm" variant="ghost" icon="refresh" onClick={onRefreshLimits} loading={refreshingLimits}>
                {refreshingLimits ? 'Refreshing' : 'Refresh'}
              </Button>
            )}
          </div>
          {hasRateLimits(sub?.rateLimits) ? (
            <RateLimitList limits={sub!.rateLimits!} />
          ) : (
            <div className="acct-note">
              <Icon name="info" size={13} />
              <span>
                {spec.key === 'openai'
                  ? 'No limit data yet. Refresh to read your usage windows and credits from Codex.'
                  : 'No limit data yet. Refresh to read your 5-hour and weekly windows from Claude Code.'}
              </span>
            </div>
          )}
          {refreshError && <div className="acct-inline-error">Couldn't refresh limits: {refreshError}</div>}
        </div>
      )}

      <div className="acct-card-section">
        <div className="acct-mode">
          <span className="acct-mode-label">Sign in with</span>
          <Segmented<AuthMode>
            size="sm"
            label={`Sign-in method for ${spec.name}`}
            value={mode}
            onChange={onModeChange}
            options={[
              { value: spec.accountMode, label: spec.accountModeLabel },
              { value: 'api_key', label: 'API key' },
            ]}
          />
        </div>
        {mode === 'api_key' && (
          <Field
            label={spec.keyLabel}
            htmlFor={keyId}
            hint={
              sub?.apiKeyMasked ? (
                <span className="acct-key-hint">
                  Saved key <code className="usg-mono">{sub.apiKeyMasked}</code>. Leave blank to keep it.
                </span>
              ) : (
                <>
                  Used instead of {spec.accountModePhrase}, as <code className="usg-mono">{spec.envVar}</code>.
                </>
              )
            }
          >
            <Input
              id={keyId}
              type="password"
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder={sub?.apiKeyMasked ? 'Enter a new key to replace it' : spec.keyPlaceholder}
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
            />
          </Field>
        )}
        {spec.note && (
          <div className="acct-note">
            <Icon name="info" size={13} />
            <span>{spec.note}</span>
          </div>
        )}
      </div>

      <div className="acct-card-section">
        <div className="acct-login">
          <span>{spec.loginHint}</span>
          {spec.loginCommand && <CopyCommand command={sub?.reauthCommand || spec.loginCommand} />}
        </div>
      </div>
    </Card>
  );
};

/* ---------------------------------------------------------- Usage panel */

const VENDOR_LABEL: Record<VendorKey, { name: string; agentId: string }> = {
  anthropic: { name: 'Anthropic', agentId: 'claude' },
  openai: { name: 'OpenAI', agentId: 'codex' },
  google: { name: 'Google', agentId: 'antigravity' },
};

const VENDOR_KEYS: VendorKey[] = ['anthropic', 'openai', 'google'];

const TOP_SESSIONS = 8;

/**
 * A thin decorative bar. Used where the value is already spoken elsewhere, and
 * inside buttons, where the Progress primitive's <div> isn't allowed.
 */
const Bar: React.FC<{ pct: number; fill: string }> = ({ pct, fill }) => (
  <span className="acct-bar" aria-hidden="true">
    <span className={`acct-bar-fill ${fill}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
  </span>
);

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const UsagePanel: React.FC<{
  usage: UsageReport;
  onSelectSession?: (id: string) => void;
  onClose: () => void;
}> = ({ usage, onSelectSession, onClose }) => {
  const [showAll, setShowAll] = useState(false);
  const { overall } = usage;
  const vendorTotal = VENDOR_KEYS.reduce((n, k) => n + (usage.vendors[k]?.totalTokens || 0), 0);
  const share = (n: number) => (vendorTotal > 0 ? (n / vendorTotal) * 100 : 0);
  const splitLabel =
    vendorTotal > 0
      ? `Token share: ${VENDOR_KEYS.map((k) => `${VENDOR_LABEL[k].name} ${Math.round(share(usage.vendors[k]?.totalTokens || 0))}%`).join(', ')}`
      : 'No tokens used yet';

  const sessions = useMemo(
    () =>
      [...(usage.sessionsUsage || [])].sort(
        (a, b) => b.estimatedCost - a.estimatedCost || b.totalTokens - a.totalTokens,
      ),
    [usage.sessionsUsage],
  );
  const visible = showAll ? sessions : sessions.slice(0, TOP_SESSIONS);

  return (
    <>
      <div className="acct-stats">
        <Card padding="md">
          <Stat
            label="Estimated cost"
            value={formatCost(overall.estimatedCost || 0)}
            tone="ok"
            hint="At list API prices"
          />
        </Card>
        <Card padding="md">
          <Stat
            label="Tokens"
            value={formatTokens(overall.totalTokens || 0)}
            hint={`${formatTokens(overall.inputTokens || 0)} in · ${formatTokens(overall.outputTokens || 0)} out`}
          />
        </Card>
        <Card padding="md">
          <Stat
            label="Sessions"
            value={(overall.totalSessions || 0).toLocaleString()}
            hint={
              overall.cachedTokens ? `${formatTokens(overall.cachedTokens)} tokens cached` : 'Across all workspaces'
            }
          />
        </Card>
      </div>

      <section className="acct-section" aria-labelledby="acct-by-vendor">
        <div className="acct-section-head">
          <h3 id="acct-by-vendor" className="usg-section-title">
            By vendor
          </h3>
          <span className="usg-section-meta">Share of tokens</span>
        </div>
        <Card padding="none">
          <div className="acct-split-wrap">
            <div className="acct-split" role="img" aria-label={splitLabel}>
              {VENDOR_KEYS.map((k) => {
                const pct = share(usage.vendors[k]?.totalTokens || 0);
                return pct > 0 ? (
                  <span key={k} className={`acct-split-seg acct-vfill-${k}`} style={{ width: `${pct}%` }} />
                ) : null;
              })}
            </div>
          </div>
          <ul className="acct-vendor-rows">
            {VENDOR_KEYS.map((k) => {
              const v = usage.vendors[k];
              const tokens = v?.totalTokens || 0;
              const pct = Math.round(share(tokens));
              const count = v?.sessionCount || 0;
              return (
                <li key={k} className="acct-vendor-row">
                  <div className="acct-vendor-name">
                    <VendorIcon agentId={VENDOR_LABEL[k].agentId} size={16} />
                    <div className="acct-vendor-text">
                      <div className="acct-vendor-name-text">{VENDOR_LABEL[k].name}</div>
                      <div className="acct-vendor-sub">
                        {count === 0 ? 'No sessions' : plural(count, 'session', 'sessions')}
                      </div>
                    </div>
                  </div>
                  <div className="acct-vendor-bar">
                    <Bar pct={pct} fill={`acct-vfill-${k}`} />
                    <span className="acct-num acct-num-dim acct-share">
                      {pct}%<span className="sr-only"> of tokens</span>
                    </span>
                  </div>
                  <span className="acct-num">
                    {formatTokens(tokens)}
                    <span className="sr-only"> tokens</span>
                  </span>
                  <span className="acct-num">
                    {formatCost(v?.estimatedCost || 0)}
                    <span className="sr-only"> estimated</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section className="acct-section" aria-labelledby="acct-top-sessions">
        <div className="acct-section-head">
          <h3 id="acct-top-sessions" className="usg-section-title">
            Top sessions by spend
          </h3>
          <span className="usg-section-meta">{plural(sessions.length, 'session', 'sessions')}</span>
        </div>
        {sessions.length === 0 ? (
          <Card padding="none">
            <EmptyState
              compact
              icon="chart"
              title="No sessions yet"
              description="Start a session and its usage shows up here."
            />
          </Card>
        ) : (
          <>
            {/* Column labels for sighted users; each row carries its own accessible name. */}
            <div className="acct-list-head" aria-hidden="true">
              <span />
              <span>Session</span>
              <span>Context</span>
              <span>Tokens</span>
              <span>Cost</span>
              <span />
            </div>
            <Card padding="none">
              <ol className="acct-sessions" aria-labelledby="acct-top-sessions">
                {visible.map((s, i) => {
                  const pct = Math.max(0, Math.min(100, Math.round(s.percentContextUsed || 0)));
                  const title = s.title || 'Untitled session';
                  const model = s.model || s.agentId;
                  const summary = `${title}, ${model}. Context ${pct}% full, ${formatTokens(s.totalTokens)} tokens, ${formatCost(s.estimatedCost)} estimated`;
                  const content = (
                    <>
                      <span className="acct-session-rank" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="acct-session-main">
                        <VendorIcon agentId={s.agentId} size={16} />
                        <span className="acct-session-text">
                          <span className="acct-session-title">{title}</span>
                          <span className="acct-session-model">{model}</span>
                        </span>
                      </span>
                      <span className="acct-session-ctx">
                        <Bar pct={pct} fill={`tone-${levelTone(pct)}`} />
                        <span className="acct-session-ctx-pct">{pct}%</span>
                      </span>
                      <span className="acct-num">{formatTokens(s.totalTokens)}</span>
                      <span className="acct-num">{formatCost(s.estimatedCost)}</span>
                      <span className="acct-session-chev">
                        {onSelectSession && <Icon name="chevronRight" size={14} />}
                      </span>
                    </>
                  );
                  return (
                    <li key={s.id}>
                      {onSelectSession ? (
                        <button
                          type="button"
                          className="acct-session"
                          aria-label={`Open ${summary}`}
                          title={title}
                          onClick={() => {
                            onSelectSession(s.id);
                            onClose();
                          }}
                        >
                          {content}
                        </button>
                      ) : (
                        <div className="acct-session" aria-label={summary} role="group">
                          {content}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </Card>
            {sessions.length > TOP_SESSIONS && (
              <Button
                className="acct-more"
                size="sm"
                variant="ghost"
                icon={showAll ? 'chevronUp' : 'chevronDown'}
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? `Show top ${TOP_SESSIONS}` : `Show all ${sessions.length} sessions`}
              </Button>
            )}
          </>
        )}
      </section>
    </>
  );
};

/* ----------------------------------------------------------- The dialog */

export const SubscriptionsUsageModal: React.FC<SubscriptionsUsageModalProps> = ({
  onClose,
  onSelectSession,
  initialTab = 'subscriptions',
}) => {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  const [subscriptions, setSubscriptions] = useState<Subscriptions | null>(null);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsError, setSubsError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [modes, setModes] = useState<Record<VendorKey, AuthMode>>({
    anthropic: 'subscription',
    openai: 'subscription',
    google: 'desktop',
  });
  const [keys, setKeys] = useState<Record<VendorKey, string>>({ anthropic: '', openai: '', google: '' });

  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const savedTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  const applySubscriptions = useCallback((subs: Subscriptions) => {
    setSubscriptions(subs);
    setModes({
      anthropic: serverMode(VENDORS[0], subs.anthropic),
      openai: serverMode(VENDORS[1], subs.openai),
      google: serverMode(VENDORS[2], subs.google),
    });
  }, []);

  const loadSubscriptions = useCallback(async () => {
    setSubsLoading(true);
    setSubsError(null);
    try {
      const res = await api.getSubscriptions();
      applySubscriptions(res.subscriptions);
    } catch (err) {
      console.error('[SubscriptionsUsageModal] Failed to load subscriptions:', err);
      setSubsError(errorText(err));
    } finally {
      setSubsLoading(false);
    }
  }, [applySubscriptions]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const res = await api.getUsageSummary();
      setUsage(res.usage);
    } catch (err) {
      console.error('[SubscriptionsUsageModal] Failed to load usage:', err);
      setUsageError(errorText(err));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSubscriptions();
    loadUsage();
  }, [loadSubscriptions, loadUsage]);

  const handleRefreshLimits = async () => {
    setRefreshingLimits(true);
    setRefreshError(null);
    try {
      const res = await api.refreshRateLimits();
      // Keep unsaved sign-in choices; only the limits and account facts change.
      setSubscriptions(res.subscriptions);
    } catch (err) {
      console.error('Failed to refresh rate limits:', err);
      setRefreshError(errorText(err));
    } finally {
      setRefreshingLimits(false);
    }
  };

  const dirty = useMemo(() => {
    if (!subscriptions) return false;
    return VENDORS.some((v) => modes[v.key] !== serverMode(v, subscriptions[v.key]) || keys[v.key].trim() !== '');
  }, [subscriptions, modes, keys]);

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveState(null);
    try {
      const payload: Partial<StoredCredentials> = {
        preferredAuthMode: {
          anthropic: modes.anthropic as 'subscription' | 'api_key',
          openai: modes.openai as 'subscription' | 'api_key',
          google: modes.google as 'desktop' | 'api_key',
        },
      };
      if (keys.anthropic.trim()) payload.anthropicApiKey = keys.anthropic.trim();
      if (keys.openai.trim()) payload.openaiApiKey = keys.openai.trim();
      if (keys.google.trim()) payload.geminiApiKey = keys.google.trim();

      const res = await api.saveSubscriptionsConfig(payload);
      applySubscriptions(res.subscriptions);
      // The server now holds the keys; show its masked copy instead of the typed value.
      setKeys({ anthropic: '', openai: '', google: '' });
      setSaveState({ tone: 'ok', text: 'Saved. New sessions use these settings.' });
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaveState((s) => (s?.tone === 'ok' ? null : s)), 3500);
    } catch (err) {
      setSaveState({ tone: 'danger', text: `Couldn't save: ${errorText(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const footStatus: { tone: Tone; text: string } | null = saving
    ? { tone: 'neutral', text: 'Saving…' }
    : saveState
      ? saveState
      : dirty
        ? { tone: 'warn', text: 'Unsaved changes' }
        : null;

  const onAccounts = activeTab === 'subscriptions';

  return (
    <Modal
      onClose={onClose}
      size="lg"
      className="acct-dialog"
      bodyClassName="acct-shell"
      icon="gauge"
      heading="Accounts and usage"
      description="Choose how each agent signs in, and see token use and estimated spend across vendors."
      footerStart={
        onAccounts && (
          // Always mounted so screen readers hear each change.
          <span className={`acct-foot-status tone-${footStatus?.tone || 'neutral'}`} role="status">
            {footStatus && (
              <>
                {saving ? (
                  <Spinner size={11} />
                ) : footStatus.tone === 'ok' ? (
                  <Icon name="checkCircle" size={13} />
                ) : footStatus.tone === 'danger' ? (
                  <Icon name="alert" size={13} />
                ) : (
                  <span className="acct-foot-dot" aria-hidden="true" />
                )}
                {footStatus.text}
              </>
            )}
          </span>
        )
      }
      footer={
        onAccounts && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={saving} disabled={!subscriptions || !dirty}>
              Save changes
            </Button>
          </>
        )
      }
    >
      <Tabs<TabId>
        className="acct-tabs"
        label="Accounts and usage"
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { id: 'subscriptions', label: 'Accounts', icon: 'user' },
          { id: 'usage', label: 'Usage', icon: 'chart' },
        ]}
      />

      {onAccounts ? (
        <div className="acct-body" role="tabpanel" aria-label="Accounts">
          <form id={FORM_ID} className="acct-form" onSubmit={handleSaveCredentials}>
            {subsLoading && !subscriptions ? (
              <AccountsSkeleton />
            ) : subsError && !subscriptions ? (
              <LoadError what="your accounts" message={subsError} onRetry={loadSubscriptions} />
            ) : (
              VENDORS.map((spec) => (
                <VendorCard
                  key={spec.key}
                  spec={spec}
                  sub={subscriptions?.[spec.key]}
                  mode={modes[spec.key]}
                  onModeChange={(mode) => setModes((m) => ({ ...m, [spec.key]: mode }))}
                  apiKey={keys[spec.key]}
                  onApiKeyChange={(value) => setKeys((k) => ({ ...k, [spec.key]: value }))}
                  {...(spec.key === 'anthropic'
                    ? { refreshingLimits, refreshError, onRefreshLimits: handleRefreshLimits }
                    : {})}
                />
              ))
            )}
          </form>
        </div>
      ) : (
        <div className="acct-body" role="tabpanel" aria-label="Usage">
          {usageLoading && !usage ? (
            <UsageSkeleton />
          ) : usageError && !usage ? (
            <LoadError what="usage" message={usageError} onRetry={loadUsage} />
          ) : usage ? (
            <UsagePanel usage={usage} onSelectSession={onSelectSession} onClose={onClose} />
          ) : null}
        </div>
      )}
    </Modal>
  );
};
