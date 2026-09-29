import React, { useState, useEffect } from 'react';
import { api } from '../api';
import type { VendorSubscriptionInfo, StoredCredentials, UsageReport } from '../types';
import { VendorIcon } from './VendorLogos';

interface SubscriptionsUsageModalProps {
  onClose: () => void;
  onSelectSession?: (sessionId: string) => void;
  initialTab?: 'subscriptions' | 'usage';
}

export const SubscriptionsUsageModal: React.FC<SubscriptionsUsageModalProps> = ({
  onClose,
  onSelectSession,
  initialTab = 'subscriptions',
}) => {
  const [activeTab, setActiveTab] = useState<'subscriptions' | 'usage'>(initialTab);
  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState<Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);

  // Form states for API key overrides
  const [anthropicMode, setAnthropicMode] = useState<'subscription' | 'api_key'>('subscription');
  const [openaiMode, setOpenaiMode] = useState<'subscription' | 'api_key'>('subscription');
  const [googleMode, setGoogleMode] = useState<'desktop' | 'api_key'>('desktop');

  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [refreshingLimits, setRefreshingLimits] = useState(false);

  const handleRefreshLimits = async () => {
    setRefreshingLimits(true);
    try {
      const res = await api.refreshRateLimits();
      setSubscriptions(res.subscriptions);
    } catch (err) {
      console.error('Failed to refresh rate limits:', err);
    } finally {
      setRefreshingLimits(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [subRes, usageRes] = await Promise.all([
        api.getSubscriptions(),
        api.getUsageSummary(),
      ]);
      setSubscriptions(subRes.subscriptions);
      setUsage(usageRes.usage);

      if (subRes.subscriptions.anthropic) {
        setAnthropicMode(subRes.subscriptions.anthropic.authMode === 'api_key' ? 'api_key' : 'subscription');
      }
      if (subRes.subscriptions.openai) {
        setOpenaiMode(subRes.subscriptions.openai.authMode === 'api_key' ? 'api_key' : 'subscription');
      }
      if (subRes.subscriptions.google) {
        setGoogleMode(subRes.subscriptions.google.authMode === 'api_key' ? 'api_key' : 'desktop');
      }
    } catch (err) {
      console.error('[SubscriptionsUsageModal] Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCopy = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2500);
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveSuccess(false);

    try {
      const payload: Partial<StoredCredentials> = {
        preferredAuthMode: {
          anthropic: anthropicMode,
          openai: openaiMode,
          google: googleMode,
        },
      };

      if (anthropicKey.trim()) payload.anthropicApiKey = anthropicKey.trim();
      if (openaiKey.trim()) payload.openaiApiKey = openaiKey.trim();
      if (geminiKey.trim()) payload.geminiApiKey = geminiKey.trim();

      const res = await api.saveSubscriptionsConfig(payload);
      setSubscriptions(res.subscriptions);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3500);
    } catch (err: any) {
      alert(`Failed to save settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '880px', width: '95%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Modal Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>💳</span> Subscriptions & Vendor Usage
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Inspect and switch active provider subscriptions, configure API keys, and monitor cross-vendor token consumption.
            </div>
          </div>
          <button className="btn-close" onClick={onClose} title="Close modal (Esc)">
            ✕
          </button>
        </div>

        {/* Tab Switcher */}
        <div style={{ display: 'flex', gap: '8px', padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.15)' }}>
          <button
            type="button"
            className={`filter-tab ${activeTab === 'subscriptions' ? 'active' : ''}`}
            onClick={() => setActiveTab('subscriptions')}
            style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600 }}
          >
            📋 Subscriptions & Accounts
          </button>
          <button
            type="button"
            className={`filter-tab ${activeTab === 'usage' ? 'active' : ''}`}
            onClick={() => setActiveTab('usage')}
            style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600 }}
          >
            📊 Vendor Usage & Costs
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {loading ? (
            <div style={{ padding: '50px 20px', textAlign: 'center', color: 'var(--text-dim)' }}>
              <div style={{ fontSize: '24px', marginBottom: '10px' }}>⏳</div>
              <div>Loading subscription and usage data...</div>
            </div>
          ) : activeTab === 'subscriptions' ? (
            /* TAB 1: Subscriptions & Accounts */
            <div>
              <form onSubmit={handleSaveCredentials}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* 1. Anthropic Claude Code */}
                  <div className="subscription-card claude">
                    <div className="sub-card-header">
                      <div className="sub-card-title">
                        <VendorIcon agentId="claude" size={24} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '15px' }}>Anthropic Claude Code</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            Official Claude Agent SDK · Connected via ACP
                          </div>
                        </div>
                      </div>
                      <span className={`sub-status-badge ${subscriptions?.anthropic?.status || 'unconfigured'}`}>
                        {subscriptions?.anthropic?.status === 'active' ? '● ACTIVE SUBSCRIPTION' : 'CONFIGURED'}
                      </span>
                    </div>

                    <div className="sub-card-body">
                      <div className="sub-meta-grid">
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Active Plan:</span>
                          <span className="sub-meta-value highlight">{subscriptions?.anthropic?.planName}</span>
                        </div>
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Account Email:</span>
                          <span className="sub-meta-value">{subscriptions?.anthropic?.accountEmail || 'CLI Default Profile'}</span>
                        </div>
                        {subscriptions?.anthropic?.organization && (
                          <div className="sub-meta-item">
                            <span className="sub-meta-label">Organization:</span>
                            <span className="sub-meta-value">{subscriptions?.anthropic?.organization}</span>
                          </div>
                        )}
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Auth Source:</span>
                          <span className="sub-meta-value">~/.claude.json ({subscriptions?.anthropic?.details?.billingType || 'subscription'})</span>
                        </div>
                      </div>

                      {/* Live Vendor Rate Limits & Rolling Resets */}
                      {subscriptions?.anthropic?.rateLimits && (
                        <div
                          className="sub-rate-limits-box"
                          style={{
                            marginTop: '14px',
                            padding: '12px 14px',
                            background: 'rgba(0, 0, 0, 0.25)',
                            borderRadius: '10px',
                            border: '1px solid rgba(217, 119, 6, 0.25)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-normal)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>⏱️</span> Vendor Session & Weekly Limits
                            </div>
                            <button
                              type="button"
                              onClick={handleRefreshLimits}
                              disabled={refreshingLimits}
                              style={{
                                fontSize: '11px',
                                background: 'transparent',
                                border: '1px solid var(--border-subtle)',
                                color: 'var(--text-muted)',
                                padding: '3px 8px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                              }}
                            >
                              {refreshingLimits ? '⏳ Refreshing...' : '🔄 Refresh Limits'}
                            </button>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {subscriptions.anthropic.rateLimits.fiveHour && (
                              <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>5-Hour Session Limit</span>
                                  <span style={{ fontWeight: 700, color: subscriptions.anthropic.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : 'var(--text-normal)' }}>
                                    {subscriptions.anthropic.rateLimits.fiveHour.utilization}% used
                                    {subscriptions.anthropic.rateLimits.fiveHour.resetsAt && (
                                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                                        · resets {subscriptions.anthropic.rateLimits.fiveHour.resetsAt}
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255, 255, 255, 0.1)', overflow: 'hidden' }}>
                                  <div
                                    style={{
                                      height: '100%',
                                      width: `${Math.min(100, subscriptions.anthropic.rateLimits.fiveHour.utilization)}%`,
                                      background: subscriptions.anthropic.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : '#d97706',
                                      borderRadius: '3px',
                                      transition: 'width 0.3s ease',
                                    }}
                                  />
                                </div>
                              </div>
                            )}

                            {subscriptions.anthropic.rateLimits.weeklyAll && (
                              <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit (All Models)</span>
                                  <span style={{ fontWeight: 700, color: subscriptions.anthropic.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : 'var(--text-normal)' }}>
                                    {subscriptions.anthropic.rateLimits.weeklyAll.utilization}% used
                                    {subscriptions.anthropic.rateLimits.weeklyAll.resetsAt && (
                                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                                        · resets {subscriptions.anthropic.rateLimits.weeklyAll.resetsAt}
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255, 255, 255, 0.1)', overflow: 'hidden' }}>
                                  <div
                                    style={{
                                      height: '100%',
                                      width: `${Math.min(100, subscriptions.anthropic.rateLimits.weeklyAll.utilization)}%`,
                                      background: subscriptions.anthropic.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : '#3b82f6',
                                      borderRadius: '3px',
                                      transition: 'width 0.3s ease',
                                    }}
                                  />
                                </div>
                              </div>
                            )}

                            {subscriptions.anthropic.rateLimits.weeklyModels?.map((wm: { name: string; utilization: number; resetsAt?: string | null }, idx: number) => (
                              <div key={idx}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit ({wm.name})</span>
                                  <span style={{ fontWeight: 700, color: wm.utilization > 80 ? '#f59e0b' : 'var(--text-normal)' }}>
                                    {wm.utilization}% used
                                    {wm.resetsAt && (
                                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                                        · resets {wm.resetsAt}
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255, 255, 255, 0.1)', overflow: 'hidden' }}>
                                  <div
                                    style={{
                                      height: '100%',
                                      width: `${Math.min(100, wm.utilization)}%`,
                                      background: wm.utilization > 80 ? '#f59e0b' : '#8b5cf6',
                                      borderRadius: '3px',
                                      transition: 'width 0.3s ease',
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Mode Switcher */}
                      <div className="auth-mode-selector">
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
                          Authentication Mode:
                        </div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="anthropicMode"
                              value="subscription"
                              checked={anthropicMode === 'subscription'}
                              onChange={() => setAnthropicMode('subscription')}
                            />
                            <span>Use Claude Max / Pro Subscription (Recommended)</span>
                          </label>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="anthropicMode"
                              value="api_key"
                              checked={anthropicMode === 'api_key'}
                              onChange={() => setAnthropicMode('api_key')}
                            />
                            <span>Custom ANTHROPIC_API_KEY</span>
                          </label>
                        </div>
                      </div>

                      {/* Optional Custom API Key input */}
                      {anthropicMode === 'api_key' && (
                        <div style={{ marginTop: '12px' }}>
                          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                            Anthropic API Key: {subscriptions?.anthropic?.apiKeyMasked && `(Currently: ${subscriptions.anthropic.apiKeyMasked})`}
                          </label>
                          <input
                            type="password"
                            className="input-text"
                            placeholder="sk-ant-api03-..."
                            value={anthropicKey}
                            onChange={(e) => setAnthropicKey(e.target.value)}
                            style={{ width: '100%', fontSize: '13px' }}
                          />
                        </div>
                      )}

                      {/* Re-auth hint */}
                      <div className="sub-card-footer">
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          To switch Anthropic user accounts or renew CLI credentials:
                        </span>
                        <button
                          type="button"
                          className="btn-copy-cmd"
                          onClick={() => handleCopy('claude login')}
                        >
                          {copiedCmd === 'claude login' ? '✓ Copied' : '📋 claude login'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 2. OpenAI Codex */}
                  <div className="subscription-card codex">
                    <div className="sub-card-header">
                      <div className="sub-card-title">
                        <VendorIcon agentId="codex" size={24} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '15px' }}>OpenAI Codex CLI</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            Codex ACP Adapter · Connected via ACP
                          </div>
                        </div>
                      </div>
                      <span className={`sub-status-badge ${subscriptions?.openai?.status || 'unconfigured'}`}>
                        {subscriptions?.openai?.status === 'active' ? '● ACTIVE SUBSCRIPTION' : 'CONFIGURED'}
                      </span>
                    </div>

                    <div className="sub-card-body">
                      <div className="sub-meta-grid">
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Active Plan:</span>
                          <span className="sub-meta-value highlight">{subscriptions?.openai?.planName}</span>
                        </div>
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Auth Mode:</span>
                          <span className="sub-meta-value">ChatGPT OAuth ({subscriptions?.openai?.details?.authMode})</span>
                        </div>
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Config Location:</span>
                          <span className="sub-meta-value">{subscriptions?.openai?.details?.configPath || '~/.codex/auth.json'}</span>
                        </div>
                      </div>

                      {/* Mode Switcher */}
                      <div className="auth-mode-selector">
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
                          Authentication Mode:
                        </div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="openaiMode"
                              value="subscription"
                              checked={openaiMode === 'subscription'}
                              onChange={() => setOpenaiMode('subscription')}
                            />
                            <span>Use ChatGPT Plus / Pro Subscription (Recommended)</span>
                          </label>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="openaiMode"
                              value="api_key"
                              checked={openaiMode === 'api_key'}
                              onChange={() => setOpenaiMode('api_key')}
                            />
                            <span>Custom OPENAI_API_KEY</span>
                          </label>
                        </div>
                      </div>

                      {/* Optional Custom API Key input */}
                      {openaiMode === 'api_key' && (
                        <div style={{ marginTop: '12px' }}>
                          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                            OpenAI API Key: {subscriptions?.openai?.apiKeyMasked && `(Currently: ${subscriptions.openai.apiKeyMasked})`}
                          </label>
                          <input
                            type="password"
                            className="input-text"
                            placeholder="sk-..."
                            value={openaiKey}
                            onChange={(e) => setOpenaiKey(e.target.value)}
                            style={{ width: '100%', fontSize: '13px' }}
                          />
                        </div>
                      )}

                      {/* OpenAI Rate Limits & Session Quota Information */}
                      <div
                        style={{
                          marginTop: '14px',
                          padding: '10px 14px',
                          background: 'rgba(0, 0, 0, 0.25)',
                          borderRadius: '8px',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                        }}
                      >
                        <span style={{ fontSize: '15px', marginTop: '1px' }}>⏱️</span>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-normal)' }}>
                            Rolling Usage Limits & Resets
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>
                            OpenAI enforces dynamic sliding windows on ChatGPT subscription tiers (e.g. ~80 messages every 3 hours for ChatGPT Plus/Pro on flagship reasoning models like <code>o3-mini</code> / <code>gpt-4o</code>). Unlike Anthropic's <code>/usage</code>, OpenAI does not expose an on-demand API to query your remaining percentage; limits are enforced dynamically server-side when sending prompts.
                          </div>
                        </div>
                      </div>

                      {/* Re-auth hint */}
                      <div className="sub-card-footer">
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          To switch OpenAI accounts or log in to a different ChatGPT subscription:
                        </span>
                        <button
                          type="button"
                          className="btn-copy-cmd"
                          onClick={() => handleCopy('codex login')}
                        >
                          {copiedCmd === 'codex login' ? '✓ Copied' : '📋 codex login'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 3. Google Antigravity & Gemini */}
                  <div className="subscription-card gemini">
                    <div className="sub-card-header">
                      <div className="sub-card-title">
                        <VendorIcon agentId="antigravity" size={24} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '15px' }}>Google Antigravity & Gemini</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            Google Language Server Daemon · Gemini 3.8 / 3.7 / 3.1 Pro
                          </div>
                        </div>
                      </div>
                      <span className={`sub-status-badge ${subscriptions?.google?.status || 'unconfigured'}`}>
                        {subscriptions?.google?.status === 'active' ? '● DESKTOP DAEMON CONNECTED' : 'CONFIGURED'}
                      </span>
                    </div>

                    <div className="sub-card-body">
                      <div className="sub-meta-grid">
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Active Engine:</span>
                          <span className="sub-meta-value highlight">{subscriptions?.google?.planName}</span>
                        </div>
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">Daemon Bridge:</span>
                          <span className="sub-meta-value">{subscriptions?.google?.details?.agentApiPath}</span>
                        </div>
                        <div className="sub-meta-item">
                          <span className="sub-meta-label">App Data Dir:</span>
                          <span className="sub-meta-value">~/.gemini/antigravity</span>
                        </div>
                      </div>

                      {/* Mode Switcher */}
                      <div className="auth-mode-selector">
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
                          Authentication Mode:
                        </div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="googleMode"
                              value="desktop"
                              checked={googleMode === 'desktop'}
                              onChange={() => setGoogleMode('desktop')}
                            />
                            <span>Use Active Antigravity Desktop Account (No API Key Required)</span>
                          </label>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="googleMode"
                              value="api_key"
                              checked={googleMode === 'api_key'}
                              onChange={() => setGoogleMode('api_key')}
                            />
                            <span>Custom GEMINI_API_KEY</span>
                          </label>
                        </div>
                      </div>

                      {/* Optional Custom API Key input */}
                      {googleMode === 'api_key' && (
                        <div style={{ marginTop: '12px' }}>
                          <label style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                            Gemini API Key: {subscriptions?.google?.apiKeyMasked && `(Currently: ${subscriptions.google.apiKeyMasked})`}
                          </label>
                          <input
                            type="password"
                            className="input-text"
                            placeholder="AIzaSy..."
                            value={geminiKey}
                            onChange={(e) => setGeminiKey(e.target.value)}
                            style={{ width: '100%', fontSize: '13px' }}
                          />
                        </div>
                      )}

                      {/* Google Antigravity Context & Quotas */}
                      <div
                        style={{
                          marginTop: '14px',
                          padding: '10px 14px',
                          background: 'rgba(0, 0, 0, 0.25)',
                          borderRadius: '8px',
                          border: '1px solid var(--border-subtle)',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                        }}
                      >
                        <span style={{ fontSize: '15px', marginTop: '1px' }}>⚡</span>
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-normal)' }}>
                            Context Capacity & Usage Quotas
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>
                            • <strong>1,000,000 Token Context Window</strong>: Gemini models support massive input history per prompt.<br />
                            • <strong>5-Hour & Weekly Rolling Limits</strong>: Antigravity Desktop manages rolling quotas (94% weekly / 97% 5h) directly via its desktop language server daemon. Check the Antigravity desktop status bar for real-time remaining quotas.
                          </div>
                        </div>
                      </div>

                      {/* Re-auth hint */}
                      <div className="sub-card-footer">
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          To switch Google accounts: switch account inside the Antigravity desktop app.
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Save button and feedback */}
                <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px' }}>
                  {saveSuccess && (
                    <span style={{ color: '#34d399', fontSize: '13px', fontWeight: 600 }}>
                      ✓ Settings & credentials saved successfully!
                    </span>
                  )}
                  <button type="submit" className="btn-save" disabled={saving}>
                    {saving ? 'Saving...' : 'Save & Apply Credentials'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* TAB 2: Vendor Usage & Costs */
            <div>
              {/* Overall Stat Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginBottom: '20px' }}>
                <div className="usage-metric-card">
                  <div className="metric-label">TOTAL SESSIONS</div>
                  <div className="metric-value">{usage?.overall.totalSessions || 0}</div>
                  <div className="metric-hint">Across all active workspaces</div>
                </div>
                <div className="usage-metric-card">
                  <div className="metric-label">TOTAL TOKENS CONSUMED</div>
                  <div className="metric-value highlight">{((usage?.overall.totalTokens || 0) / 1000).toFixed(1)}k</div>
                  <div className="metric-hint">
                    {((usage?.overall.inputTokens || 0) / 1000).toFixed(1)}k input · {((usage?.overall.outputTokens || 0) / 1000).toFixed(1)}k output
                  </div>
                </div>
                <div className="usage-metric-card">
                  <div className="metric-label">ESTIMATED SPEND (EQUIVALENT)</div>
                  <div className="metric-value" style={{ color: '#34d399' }}>
                    ${(usage?.overall.estimatedCost || 0).toFixed(4)}
                  </div>
                  <div className="metric-hint">Calculated using standard model API pricing</div>
                </div>
              </div>

              {/* Vendor Breakdown Cards */}
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Usage Breakdown By Vendor
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
                  {/* Anthropic */}
                  <div className="vendor-usage-card claude">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <VendorIcon agentId="claude" size={20} />
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>Anthropic (Claude)</span>
                    </div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--agent-claude)' }}>
                      {((usage?.vendors.anthropic.totalTokens || 0) / 1000).toFixed(1)}k <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)' }}>tokens</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      {usage?.vendors.anthropic.sessionCount || 0} active sessions · Est. ${(usage?.vendors.anthropic.estimatedCost || 0).toFixed(4)}
                    </div>
                  </div>

                  {/* OpenAI */}
                  <div className="vendor-usage-card codex">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <VendorIcon agentId="codex" size={20} />
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>OpenAI (Codex)</span>
                    </div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--agent-codex)' }}>
                      {((usage?.vendors.openai.totalTokens || 0) / 1000).toFixed(1)}k <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)' }}>tokens</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      {usage?.vendors.openai.sessionCount || 0} active sessions · Est. ${(usage?.vendors.openai.estimatedCost || 0).toFixed(4)}
                    </div>
                  </div>

                  {/* Google */}
                  <div className="vendor-usage-card gemini">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <VendorIcon agentId="antigravity" size={20} />
                      <span style={{ fontWeight: 700, fontSize: '14px' }}>Google (Gemini)</span>
                    </div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--agent-gemini)' }}>
                      {((usage?.vendors.google.totalTokens || 0) / 1000).toFixed(1)}k <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)' }}>tokens</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      {usage?.vendors.google.sessionCount || 0} active sessions · Est. ${(usage?.vendors.google.estimatedCost || 0).toFixed(4)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Sessions Usage Table */}
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px', textTransform: 'uppercase' }}>
                  Per-Session Usage & Context Gauge
                </div>
                {usage?.sessionsUsage && usage.sessionsUsage.length > 0 ? (
                  <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '8px', overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: '#181920', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>
                          <th style={{ padding: '10px 14px' }}>Session / Title</th>
                          <th style={{ padding: '10px 14px' }}>Engine & Model</th>
                          <th style={{ padding: '10px 14px' }}>Tokens Used</th>
                          <th style={{ padding: '10px 14px' }}>Context Window</th>
                          <th style={{ padding: '10px 14px' }}>Est. Cost</th>
                          <th style={{ padding: '10px 14px', textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.sessionsUsage.map((s) => {
                          const percent = s.percentContextUsed;
                          const barColor = percent > 80 ? '#ef4444' : percent > 50 ? '#f59e0b' : '#38bdf8';
                          return (
                            <tr key={s.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                              <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                                <div style={{ color: 'var(--text-main)' }}>{s.title}</div>
                                <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'monospace' }}>{s.id}</div>
                              </td>
                              <td style={{ padding: '10px 14px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <VendorIcon agentId={s.agentId} size={14} />
                                  <span style={{ fontSize: '12px' }}>{s.model || s.agentId}</span>
                                </div>
                              </td>
                              <td style={{ padding: '10px 14px', fontWeight: 700 }}>
                                {s.totalTokens.toLocaleString()}
                              </td>
                              <td style={{ padding: '10px 14px', minWidth: '150px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <div style={{ flex: 1, height: '6px', background: '#252630', borderRadius: '3px', overflow: 'hidden' }}>
                                    <div style={{ width: `${percent}%`, height: '100%', background: barColor }} />
                                  </div>
                                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '32px' }}>{percent}%</span>
                                </div>
                              </td>
                              <td style={{ padding: '10px 14px', color: '#34d399', fontWeight: 600 }}>
                                ${s.estimatedCost.toFixed(4)}
                              </td>
                              <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                                {onSelectSession && (
                                  <button
                                    type="button"
                                    className="btn-action"
                                    onClick={() => {
                                      onSelectSession(s.id);
                                      onClose();
                                    }}
                                    style={{ fontSize: '11px', padding: '4px 10px' }}
                                  >
                                    Open →
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-dim)' }}>
                    No sessions recorded yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
