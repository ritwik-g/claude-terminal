import React, { useState, useEffect } from 'react';
import type { AcpSession, AgentDescriptor } from '../types';
import { api } from '../api';
import { AgentModelPicker } from './AgentModelPicker';

interface SwitchAgentModalProps {
  currentSession: AcpSession;
  agents: AgentDescriptor[];
  onClose: () => void;
  onSwitched: (newSessionId: string) => void;
}

export const SwitchAgentModal: React.FC<SwitchAgentModalProps> = ({
  currentSession,
  agents,
  onClose,
  onSwitched,
}) => {
  const availableTargets = agents.filter((a) => a.id !== currentSession.agentId);
  const preferredTarget = currentSession.agentId === 'claude'
    ? (availableTargets.some((a) => a.id === 'antigravity') ? 'antigravity' : 'codex')
    : 'claude';
  const defaultTarget = availableTargets.some((a) => a.id === preferredTarget)
    ? preferredTarget
    : (availableTargets[0]?.id || 'claude');
  const [targetAgentId, setTargetAgentId] = useState<string>(defaultTarget);
  const currentTargetAgent = availableTargets.find((a) => a.id === targetAgentId) || availableTargets[0];
  const [targetModel, setTargetModel] = useState<string>(currentTargetAgent?.defaultModel || '');
  const defaultPrompt = currentSession.lastPrompt
    ? `Continue work on this repository. Active goal: "${currentSession.lastPrompt}". Proceed directly with this goal without unnecessary repository scans.`
    : `Continue work on this repository. Context: ${currentSession.recap || 'pick up from current workspace state'}.`;

  const [sendInitialPrompt, setSendInitialPrompt] = useState(true);
  const [customPrompt, setCustomPrompt] = useState(defaultPrompt);
  const [archivePrevious, setArchivePrevious] = useState<boolean>(true);
  const [inPlace, setInPlace] = useState<boolean>(true);
  const [contextMode, setContextMode] = useState<'compact' | 'full' | 'none'>('compact');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (availableTargets.length > 0 && !availableTargets.some((a) => a.id === targetAgentId)) {
      const first = availableTargets[0];
      setTargetAgentId(first.id);
      setTargetModel(first.defaultModel || '');
    }
  }, [agents, currentSession.agentId]);

  useEffect(() => {
    if (currentTargetAgent?.defaultModel && (!targetModel || !currentTargetAgent.availableModels?.includes(targetModel))) {
      setTargetModel(currentTargetAgent.defaultModel);
    }
  }, [targetAgentId]);

  const handleSwitch = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.switchAgent(currentSession.id, targetAgentId, {
        model: targetModel || undefined,
        archivePrevious: inPlace ? false : archivePrevious,
        inPlace,
        customPrompt: sendInitialPrompt ? customPrompt : undefined,
        skipInitialPrompt: !sendInitialPrompt,
        contextMode,
      });
      onSwitched(res.session.id);
    } catch (err: any) {
      setError(err.message || 'Failed to switch agent');
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>🔄 Failover / Switch Coding Agent</span>
        </div>

        <div className="modal-body">
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            Seamlessly switch from <strong>{currentSession.agentName}</strong> to another ACP-compatible agent.
            Your working repository, uncommitted git changes, and recent goal context will be automatically transferred!
          </p>

          {error && (
            <div style={{ color: '#ef4444', fontSize: '13px', padding: '6px 10px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px' }}>
              {error}
            </div>
          )}

          <AgentModelPicker
            agents={availableTargets}
            selectedAgentId={targetAgentId}
            selectedModel={targetModel}
            onAgentChange={(id) => setTargetAgentId(id)}
            onModelChange={(model) => setTargetModel(model)}
            disabled={loading}
          />

          <div style={{ margin: '8px 0', padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Switch Mode
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-main)' }}>
                <input
                  type="radio"
                  name="switchMode"
                  checked={inPlace}
                  onChange={() => setInPlace(true)}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>
                  <strong>Switch in-place (Same session)</strong> — Recommended, continues current thread seamlessly
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-muted)' }}>
                <input
                  type="radio"
                  name="switchMode"
                  checked={!inPlace}
                  onChange={() => setInPlace(false)}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>
                  Fork to a new separate session
                </span>
              </label>
            </div>

            {!inPlace && (
              <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-dim)' }}>
                  <input
                    type="checkbox"
                    checked={archivePrevious}
                    onChange={(e) => setArchivePrevious(e.target.checked)}
                    style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                  />
                  <span>Archive previous session from active queue</span>
                </label>
              </div>
            )}

            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-main)', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={sendInitialPrompt}
                  onChange={(e) => setSendInitialPrompt(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>⚡ Immediately send continuation prompt to new agent</span>
              </label>
              {sendInitialPrompt && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Prompt sent immediately to new agent to continue where previous agent left off:
                  </div>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    rows={3}
                    style={{
                      width: '100%',
                      background: '#0e1015',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '6px',
                      color: 'var(--text-main)',
                      fontSize: '12px',
                      padding: '8px',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <div style={{ margin: '8px 0', padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Conversation Context Handover
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-main)' }}>
                <input
                  type="radio"
                  name="modalContextMode"
                  checked={contextMode === 'compact'}
                  onChange={() => setContextMode('compact')}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>
                  <strong>📦 Compact History (Recommended)</strong> — Summarizes prior turns, decisions, & file edits to optimize token context
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-muted)' }}>
                <input
                  type="radio"
                  name="modalContextMode"
                  checked={contextMode === 'full'}
                  onChange={() => setContextMode('full')}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>
                  <strong>📜 Full Recent Turns</strong> — Transfers verbatim recent user and agent messages
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-muted)' }}>
                <input
                  type="radio"
                  name="modalContextMode"
                  checked={contextMode === 'none'}
                  onChange={() => setContextMode('none')}
                  style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
                />
                <span>
                  <strong>🚫 Clean Slate</strong> — No prior conversation transferred; agent only inspects repo files & git state
                </span>
              </label>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', fontSize: '12px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontWeight: 600, marginBottom: '6px', color: 'var(--text-main)' }}>Context Transferred:</div>
            <div style={{ color: 'var(--text-muted)' }}>• Repository: <code>{currentSession.cwd}</code></div>
            <div style={{ color: 'var(--text-muted)' }}>• Git branch: <code>{currentSession.git?.branch || 'main'}</code> ({currentSession.git?.uncommittedFiles || 0} uncommitted files)</div>
            <div style={{ color: 'var(--text-muted)' }}>• Active goal: "{currentSession.lastPrompt || currentSession.recap}"</div>
            <div style={{ color: 'var(--text-muted)' }}>• History mode: <strong>{contextMode === 'compact' ? 'Compact summary of prior turns' : contextMode === 'full' ? 'Full recent turns' : 'Clean slate (None)'}</strong></div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-new btn-failover"
            disabled={loading}
            onClick={handleSwitch}
            style={{ padding: '8px 18px' }}
          >
            {loading ? 'Switching Agent...' : inPlace ? 'Switch Engine (In-Place)' : 'Fork & Launch Session'}
          </button>
        </div>
      </div>
    </div>
  );
};
