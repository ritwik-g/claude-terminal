import React, { useState, useEffect } from 'react';
import { useEscapeLayer } from '../hooks';
import { api, isHostMachine } from '../api';

interface FolderEntry {
  name: string;
  path: string;
  isGit: boolean;
}

interface FolderBrowserModalProps {
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onClose: () => void;
}

export const FolderBrowserModal: React.FC<FolderBrowserModalProps> = ({
  initialPath,
  onSelect,
  onClose,
}) => {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isGit, setIsGit] = useState<boolean>(false);
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [pathInput, setPathInput] = useState<string>('');
  const [nativeBrowsing, setNativeBrowsing] = useState<boolean>(false);

  // Esc closes only this browser, not the New Session dialog underneath.
  useEscapeLayer(true, onClose);

  const fetchDirectory = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    setFilterQuery('');
    try {
      const res = await api.getFolders(targetPath);
      setCurrentPath(res.current);
      setParentPath(res.parent);
      setIsGit(res.isGit);
      setEntries(res.entries);
      if (res.recent && res.recent.length > 0) {
        setRecentWorkspaces(res.recent);
      }
      setPathInput(res.current);
    } catch (err: any) {
      setError(err.message || 'Failed to read directory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDirectory(initialPath);
  }, []);

  const handleNativeBrowse = async () => {
    setNativeBrowsing(true);
    try {
      const res = await api.browseNativeFolder();
      if (res.selected) {
        onSelect(res.selected);
        onClose();
      }
    } catch (err: any) {
      console.warn('Native folder browse error:', err);
    } finally {
      setNativeBrowsing(false);
    }
  };

  const handleSelect = (path: string) => {
    onSelect(path);
    onClose();
  };

  const handleBreadcrumbClick = (targetPath: string) => {
    fetchDirectory(targetPath);
  };

  const handleManualPathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) {
      fetchDirectory(pathInput.trim());
      setIsEditingPath(false);
    }
  };

  // Build breadcrumb segments from currentPath
  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = pathParts.map((part, index) => {
    const segPath = '/' + pathParts.slice(0, index + 1).join('/');
    return { name: part, path: segPath };
  });

  const filteredEntries = entries.filter((e) =>
    e.name.toLowerCase().includes(filterQuery.toLowerCase())
  );

  const currentFolderBasename = currentPath.split('/').filter(Boolean).pop() || currentPath;

  return (
    <div className="modal-overlay folder-browser-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        role="dialog"
        aria-modal="true"
        className="modal-card folder-browser-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '640px', maxWidth: '95vw', maxHeight: '88vh' }}
      >
        {/* Header */}
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>📂</span>
            <span style={{ fontWeight: 700 }}>Select Project Folder</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isHostMachine() && (
            <button
              type="button"
              className="btn-action"
              onClick={handleNativeBrowse}
              disabled={nativeBrowsing}
              title="Open macOS Finder to pick folder"
              style={{ padding: '4px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <span>🖥️</span>
              <span>{nativeBrowsing ? 'Opening...' : 'Finder'}</span>
            </button>
            )}
            <button
              type="button"
              className="close-button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                fontSize: '18px',
                cursor: 'pointer',
                padding: '2px 6px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="modal-body folder-browser-body" style={{ padding: '16px', gap: '12px', display: 'flex', flexDirection: 'column' }}>
          {error && (
            <div style={{ color: '#ef4444', fontSize: '12.5px', padding: '6px 10px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px' }}>
              {error}
            </div>
          )}

          {/* Breadcrumbs or Manual Path Bar */}
          <div className="folder-browser-pathbar">
            {isEditingPath ? (
              <form onSubmit={handleManualPathSubmit} style={{ display: 'flex', gap: '6px', width: '100%' }}>
                <input
                  type="text"
                  className="form-input"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  placeholder="/Users/username/repo"
                  autoFocus
                  style={{ fontSize: '12.5px', padding: '6px 10px' }}
                />
                <button type="submit" className="btn-action" style={{ padding: '6px 12px', fontSize: '12px' }}>
                  Go
                </button>
                <button
                  type="button"
                  className="btn-action"
                  onClick={() => {
                    setIsEditingPath(false);
                    setPathInput(currentPath);
                  }}
                  style={{ padding: '6px 10px', fontSize: '12px' }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '8px' }}>
                <div className="folder-breadcrumbs" style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', gap: '4px', flex: 1, padding: '2px 0' }}>
                  <button
                    type="button"
                    className="breadcrumb-chip"
                    onClick={() => fetchDirectory('~')}
                    title="Jump to Home (~)"
                    style={{ fontSize: '13px' }}
                  >
                    🏠
                  </button>
                  <span style={{ color: 'var(--text-dim)', opacity: 0.5 }}>|</span>
                  <button
                    type="button"
                    className={`breadcrumb-chip ${currentPath === '/' ? 'active' : ''}`}
                    onClick={() => handleBreadcrumbClick('/')}
                    title="Root (/)"
                  >
                    /
                  </button>
                  {breadcrumbs.map((crumb) => (
                    <React.Fragment key={crumb.path}>
                      <button
                        type="button"
                        className={`breadcrumb-chip ${crumb.path === currentPath ? 'active' : ''}`}
                        onClick={() => handleBreadcrumbClick(crumb.path)}
                        title={crumb.path}
                      >
                        {crumb.name}
                      </button>
                      <span style={{ color: 'var(--text-dim)', fontSize: '11px', opacity: 0.6 }}>/</span>
                    </React.Fragment>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-action"
                  onClick={() => setIsEditingPath(true)}
                  title="Directly edit or paste path"
                  style={{ padding: '3px 8px', fontSize: '11px', flexShrink: 0 }}
                >
                  ✏️ Edit
                </button>
              </div>
            )}
          </div>

          {/* Current Selection Banner */}
          <div className="folder-current-banner">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: '24px', flexShrink: 0 }}>{isGit ? '📦' : '📁'}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-main)' }}>
                    {currentFolderBasename}
                  </span>
                  {isGit && (
                    <span
                      style={{
                        background: 'rgba(16, 185, 129, 0.15)',
                        color: '#10b981',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 600,
                      }}
                    >
                      ⎇ git repo
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: '11.5px',
                    color: 'var(--text-dim)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={currentPath}
                >
                  {currentPath}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn-new"
              onClick={() => handleSelect(currentPath)}
              style={{
                padding: '6px 14px',
                fontSize: '12.5px',
                fontWeight: 600,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>✓</span>
              <span>Use This Folder</span>
            </button>
          </div>

          {/* Recent Workspaces Quick Bar */}
          {recentWorkspaces.length > 0 && (
            <div className="folder-recent-section">
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Recent Workspaces:
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                {recentWorkspaces.map((rw) => {
                  const name = rw.split('/').filter(Boolean).pop() || rw;
                  const isCurrent = rw === currentPath;
                  return (
                    <button
                      key={rw}
                      type="button"
                      className={`recent-workspace-pill ${isCurrent ? 'active' : ''}`}
                      onClick={() => fetchDirectory(rw)}
                      title={rw}
                    >
                      <span style={{ opacity: 0.7 }}>📁</span> {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Navigation Controls: Parent & Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {parentPath && (
              <button
                type="button"
                className="btn-action"
                onClick={() => fetchDirectory(parentPath)}
                title="Go to parent directory"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  flexShrink: 0,
                }}
              >
                <span>⬆️</span>
                <span>Parent Folder</span>
              </button>
            )}
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type="text"
                className="form-input"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="🔍 Filter subdirectories..."
                style={{ fontSize: '12px', padding: '6px 10px', height: '32px' }}
              />
              {filterQuery && (
                <button
                  type="button"
                  onClick={() => setFilterQuery('')}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Directory Entries List */}
          <div className="folder-entries-container">
            {loading ? (
              <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                Loading folders...
              </div>
            ) : filteredEntries.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
                {filterQuery ? 'No matching folders found' : 'No subdirectories in this folder'}
              </div>
            ) : (
              <div className="folder-entries-list">
                {filteredEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className="folder-entry-row"
                    onClick={() => fetchDirectory(entry.path)}
                    title={`Click to open ${entry.name}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: '16px', flexShrink: 0 }}>{entry.isGit ? '📦' : '📁'}</span>
                      <span className="folder-entry-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 500 }}>
                        {entry.name}
                      </span>
                      {entry.isGit && (
                        <span
                          style={{
                            background: 'rgba(16, 185, 129, 0.12)',
                            color: '#10b981',
                            border: '1px solid rgba(16, 185, 129, 0.25)',
                            padding: '1px 5px',
                            borderRadius: '3px',
                            fontSize: '10px',
                            fontWeight: 600,
                            flexShrink: 0,
                          }}
                        >
                          git
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <button
                        type="button"
                        className="btn-select-folder-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelect(entry.path);
                        }}
                        title={`Select ${entry.name} immediately`}
                      >
                        Select
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '350px',
            }}
            title={currentPath}
          >
            {currentPath}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn-action" onClick={onClose} style={{ padding: '6px 14px', fontSize: '12.5px' }}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-new"
              onClick={() => handleSelect(currentPath)}
              style={{ padding: '6px 16px', fontSize: '12.5px', fontWeight: 600 }}
            >
              Choose Current Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
