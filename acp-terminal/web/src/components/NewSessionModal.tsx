import React, { useState, useEffect } from 'react';
import type { AgentDescriptor } from '../types';
import { api, isHostMachine } from '../api';
import { AgentModelPicker } from './AgentModelPicker';
import { FolderBrowserModal } from './FolderBrowserModal';

interface NewSessionModalProps {
  agents: AgentDescriptor[];
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  agents,
  onClose,
  onCreated,
}) => {
  const [selectedAgent, setSelectedAgent] = useState<string>(agents[0]?.id || 'claude');
  const currentAgent = agents.find((a) => a.id === selectedAgent) || agents[0];
  const [selectedModel, setSelectedModel] = useState<string>(currentAgent?.defaultModel || '');
  const [cwd, setCwd] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [initialPrompt, setInitialPrompt] = useState<string>('');
  const [suggestedFolders, setSuggestedFolders] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [isNativeBrowsing, setIsNativeBrowsing] = useState(false);

  useEffect(() => {
    if (agents.length > 0 && (!selectedAgent || !agents.some((a) => a.id === selectedAgent))) {
      const first = agents[0];
      setSelectedAgent(first.id);
      setSelectedModel(first.defaultModel || '');
    }
  }, [agents]);

  useEffect(() => {
    if (currentAgent?.defaultModel && (!selectedModel || !currentAgent.availableModels?.includes(selectedModel))) {
      setSelectedModel(currentAgent.defaultModel);
    }
  }, [selectedAgent]);

  useEffect(() => {
    api.getFolders().then((res) => {
      // Prefill with the most recent project rather than $HOME, and never
      // overwrite a path the user already started typing.
      setCwd((prev) => prev || res.recent?.[0] || res.current);
      setSuggestedFolders(res.entries);
      if (res.recent && res.recent.length > 0) {
        setRecentWorkspaces(res.recent);
      }
    }).catch(() => {});
  }, []);

  const handleNativeFinder = async () => {
    setIsNativeBrowsing(true);
    try {
      const res = await api.browseNativeFolder();
      if (res.selected) {
        setCwd(res.selected);
      }
    } catch (err: any) {
      console.warn('Native folder selection error:', err);
    } finally {
      setIsNativeBrowsing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd) {
      setError('Please select a working directory');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await api.createSession({
        agentId: selectedAgent,
        model: selectedModel || undefined,
        cwd,
        title: title.trim() || undefined,
        initialPrompt: initialPrompt.trim() || undefined,
      });
      onCreated(res.session.id);
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
      setLoading(false);
    }
  };

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div role="dialog" aria-modal="true" className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span>Start New ACP Agent Session</span>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {error && (
                <div style={{ color: '#ef4444', fontSize: '13px', padding: '6px 10px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px' }}>
                  {error}
                </div>
              )}

              <AgentModelPicker
                agents={agents}
                selectedAgentId={selectedAgent}
                selectedModel={selectedModel}
                onAgentChange={(id) => setSelectedAgent(id)}
                onModelChange={(model) => setSelectedModel(model)}
                disabled={loading}
              />

              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Working Directory (Project Root)</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 'normal' }}>
                    Absolute path on host machine
                  </span>
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="form-input"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="/Users/username/projects/my-repo"
                    required
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn-action"
                    onClick={() => setShowFolderBrowser(true)}
                    title="Open folder browser"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '0 12px',
                      whiteSpace: 'nowrap',
                      fontSize: '12px',
                      background: 'rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <span>📂</span>
                    <span>Browse...</span>
                  </button>
                  {isHostMachine() && (
                  <button
                    type="button"
                    className="btn-action"
                    onClick={handleNativeFinder}
                    disabled={isNativeBrowsing}
                    title="Open native macOS Finder dialog"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '0 10px',
                      whiteSpace: 'nowrap',
                      fontSize: '12px',
                      background: 'rgba(255, 255, 255, 0.06)',
                    }}
                  >
                    <span>🖥️</span>
                    <span>{isNativeBrowsing ? '...' : 'Finder'}</span>
                  </button>
                  )}
                </div>

                {/* Quick Pick: Recent Workspaces */}
                {recentWorkspaces.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', alignSelf: 'center' }}>Recent:</span>
                    {recentWorkspaces.slice(0, 5).map((ws) => {
                      const name = ws.split('/').filter(Boolean).pop() || ws;
                      const isSelected = cwd === ws;
                      return (
                        <button
                          key={ws}
                          type="button"
                          className={`recent-workspace-pill ${isSelected ? 'active' : ''}`}
                          style={{
                            background: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            borderColor: isSelected ? '#3b82f6' : 'var(--border-subtle)',
                            color: isSelected ? '#93c5fd' : 'var(--text-muted)',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            cursor: 'pointer',
                          }}
                          onClick={() => setCwd(ws)}
                          title={ws}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Quick Pick: Subfolders if recent is empty */}
                {recentWorkspaces.length === 0 && suggestedFolders.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', alignSelf: 'center' }}>Quick pick:</span>
                    {suggestedFolders.slice(0, 4).map((f) => (
                      <button
                        key={f.path}
                        type="button"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-muted)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          cursor: 'pointer',
                        }}
                        onClick={() => setCwd(f.path)}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

            <div className="form-group">
              <label className="form-label">Session Title (Optional)</label>
              <input
                type="text"
                className="form-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Refactor API routes"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Initial Goal / Prompt (Optional)</label>
              <textarea
                className="form-input"
                style={{ height: '70px', resize: 'vertical' }}
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                placeholder="What should the agent start working on?"
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-action" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-new"
              disabled={loading}
              style={{ padding: '8px 18px' }}
            >
              {loading ? 'Starting Agent...' : 'Launch Session'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {showFolderBrowser && (
      <FolderBrowserModal
        initialPath={cwd}
        onSelect={(selectedPath) => setCwd(selectedPath)}
        onClose={() => setShowFolderBrowser(false)}
      />
    )}
  </>
  );
};
