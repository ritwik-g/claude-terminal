import React from 'react';
import type { AcpSession } from '../types';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { usageMetrics } from '../pricing';

/** The session's Usage tab: context window, token counts, spend and per-turn impact. */
export const UsageTab: React.FC<{
  session: AcpSession;
  onOpenSubscriptionsModal?: () => void;
  onCompact: () => void;
  compacting: boolean;
}> = ({ session, onOpenSubscriptionsModal, onCompact: handleCompactSession, compacting }) => {
  const { pricing, inputTokens, outputTokens, cachedTokens, contextTokens, percentContext, estimatedCost } = usageMetrics(session);
  const currentModelMeta = getModelMeta(session.model || 'sonnet');

  return (
        <div className="session-usage-tab-content">
          {/* Top Context Meter Banner */}
          <div className="context-meter-card">
            <div className="context-meter-header">
              <div>
                <div className="context-meter-title">Context Window Utilization</div>
                <div className="context-meter-sub">
                  Active buffer: <strong>{contextTokens.toLocaleString()}</strong> of <strong>{pricing.contextWindow.toLocaleString()}</strong> tokens ({pricing.contextWindow >= 1000000 ? `${pricing.contextWindow / 1000000}M` : `${pricing.contextWindow / 1000}k`} window)
                </div>
              </div>
              <div
                className="context-meter-percent"
                style={{ color: percentContext > 80 ? '#ef4444' : percentContext > 50 ? '#f59e0b' : '#38bdf8' }}
              >
                {percentContext}%
              </div>
            </div>

            {/* Context Gauge Bar */}
            <div className="context-bar-track">
              <div
                className="context-bar-fill"
                style={{
                  width: `${percentContext}%`,
                  backgroundColor: percentContext > 80 ? '#ef4444' : percentContext > 50 ? '#f59e0b' : '#38bdf8',
                }}
              />
            </div>

            <div className="context-meter-footer">
              <span>{Math.max(0, pricing.contextWindow - contextTokens).toLocaleString()} tokens available</span>
              {percentContext > 60 && (
                <button
                  type="button"
                  className="btn-action"
                  onClick={handleCompactSession}
                  disabled={compacting || session.turns.length <= 1}
                  style={{ color: '#fbbf24', borderColor: '#f59e0b', fontSize: '12px' }}
                >
                  📦 Compact conversation history now
                </button>
              )}
            </div>
          </div>

          {/* Token Breakdown & Cost Grid */}
          <div className="usage-stats-grid">
            <div className="usage-stat-box">
              <div className="usage-stat-label">INPUT TOKENS</div>
              <div className="usage-stat-val">{inputTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Prompt text + tool inputs</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">OUTPUT TOKENS</div>
              <div className="usage-stat-val">{outputTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Agent reasoning + completions</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">CACHED TOKENS</div>
              <div className="usage-stat-val highlight">{cachedTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Prompt caching savings</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">ESTIMATED SPEND</div>
              <div className="usage-stat-val" style={{ color: '#34d399' }}>
                ${estimatedCost.toFixed(4)}
              </div>
              <div className="usage-stat-hint">
                At ${pricing.inputPerMillion}/M in, ${pricing.outputPerMillion}/M out
              </div>
            </div>
          </div>

          {/* Model & Vendor Specs Card */}
          <div className="model-specs-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <VendorIcon agentId={session.agentId} size={20} />
                <span style={{ fontWeight: 700, fontSize: '14px' }}>
                  {session.agentName} · {currentModelMeta.label || session.model}
                </span>
              </div>
              {onOpenSubscriptionsModal && (
                <button
                  type="button"
                  className="btn-action"
                  onClick={onOpenSubscriptionsModal}
                  style={{ fontSize: '12px', padding: '6px 12px' }}
                >
                  💳 Manage Subscriptions & All Vendors →
                </button>
              )}
            </div>
            <div className="model-specs-table">
              <div className="spec-row">
                <span>Model ID:</span>
                <code>{session.model || 'default'}</code>
              </div>
              <div className="spec-row">
                <span>Max Context Window:</span>
                <span>{pricing.contextWindow.toLocaleString()} tokens</span>
              </div>
              <div className="spec-row">
                <span>Standard Pricing:</span>
                <span>${pricing.inputPerMillion.toFixed(2)} / 1M input · ${pricing.outputPerMillion.toFixed(2)} / 1M output</span>
              </div>
              <div className="spec-row">
                <span>Workspace:</span>
                <code title={session.cwd}>{session.cwd}</code>
              </div>
            </div>
          </div>

          {/* Vendor Rate Limits & Rolling Windows Card */}
          {session.rateLimits && (session.rateLimits.fiveHour || session.rateLimits.weeklyAll) && (
            <div
              className="model-specs-card"
              style={{
                marginTop: '16px',
                background: 'rgba(217, 119, 6, 0.08)',
                borderColor: 'rgba(217, 119, 6, 0.28)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>⏱️</span>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-normal)' }}>
                      Anthropic Claude Subscription Limits
                    </span>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      Live 5-hour rolling session limit and weekly capacity for your Claude account
                    </div>
                  </div>
                </div>
                {onOpenSubscriptionsModal && (
                  <button
                    type="button"
                    className="btn-action"
                    onClick={onOpenSubscriptionsModal}
                    style={{ fontSize: '12px', padding: '5px 12px' }}
                  >
                    💳 Manage Subscriptions →
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {session.rateLimits.fiveHour && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>5-Hour Session Limit</span>
                      <span style={{ fontWeight: 700, color: session.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {session.rateLimits.fiveHour.utilization}% used
                        {session.rateLimits.fiveHour.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {session.rateLimits.fiveHour.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, session.rateLimits.fiveHour.utilization)}%`,
                          background: session.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : '#d97706',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}

                {session.rateLimits.weeklyAll && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit (All Models)</span>
                      <span style={{ fontWeight: 700, color: session.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {session.rateLimits.weeklyAll.utilization}% used
                        {session.rateLimits.weeklyAll.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {session.rateLimits.weeklyAll.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, session.rateLimits.weeklyAll.utilization)}%`,
                          background: session.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : '#3b82f6',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}

                {session.rateLimits.weeklyModels?.map((wm: { name: string; utilization: number; resetsAt?: string | null }, idx: number) => (
                  <div key={idx}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit ({wm.name})</span>
                      <span style={{ fontWeight: 700, color: wm.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {wm.utilization}% used
                        {wm.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {wm.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, wm.utilization)}%`,
                          background: wm.utilization > 80 ? '#f59e0b' : '#8b5cf6',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Turn Activity Breakdown */}
          <div className="turns-usage-card">
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px', textTransform: 'uppercase' }}>
              Conversation Turns & Tool Impact ({session.turns.length} turns)
            </div>
            <div className="turns-table-wrapper">
              <table className="turns-usage-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Role</th>
                    <th>Tool Calls</th>
                    <th>Timestamp</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {session.turns.map((t, idx) => (
                    <tr key={t.id}>
                      <td style={{ color: 'var(--text-dim)' }}>{idx + 1}</td>
                      <td>
                        <span className={`turn-role-badge ${t.role}`}>
                          {t.role.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        {t.toolCalls && t.toolCalls.length > 0 ? (
                          <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                            {t.toolCalls.length} tool{t.toolCalls.length > 1 ? 's' : ''}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </td>
                      <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.content ? t.content.slice(0, 80) : t.thoughts ? `💭 ${t.thoughts.slice(0, 80)}` : 'System event'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
  );
};
