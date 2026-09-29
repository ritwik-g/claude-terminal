import React, { useState, useEffect, useRef } from 'react';
import { api, isHostMachine } from '../api';
import { Badge, Button, EmptyState, Icon, IconButton, Input, Kbd, Spinner } from '../ui';
import { Modal } from './Modal';
import { useEscapeLayer } from '../hooks';

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

const baseName = (p: string) => p.split('/').filter(Boolean).pop() || p;

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
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const lastRequested = useRef<string | undefined>(initialPath);
  const listHadFocus = useRef(false);

  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);

  const fetchDirectory = async (targetPath?: string) => {
    lastRequested.current = targetPath;
    setLoading(true);
    setError(null);
    setFilterQuery('');
    setActiveIndex(0);
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
      setError(err.message || "This folder couldn't be read.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDirectory(initialPath);
  }, []);

  // Keep the deepest breadcrumb in view on long paths.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath, isEditingPath]);

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

  const handleManualPathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pathInput.trim()) {
      fetchDirectory(pathInput.trim());
      setIsEditingPath(false);
    }
  };

  // Build breadcrumb segments from currentPath
  const pathParts = currentPath.split('/').filter(Boolean);
  const breadcrumbs = pathParts.map((part, index) => ({
    name: part,
    path: '/' + pathParts.slice(0, index + 1).join('/'),
  }));

  const filteredEntries = entries.filter((e) => e.name.toLowerCase().includes(filterQuery.toLowerCase()));

  const focusRow = (idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row]');
    if (!rows || rows.length === 0) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, idx));
    setActiveIndex(clamped);
    rows[clamped].focus();
    rows[clamped].scrollIntoView({ block: 'nearest' });
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const entry = filteredEntries[activeIndex];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(activeIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (activeIndex === 0) filterRef.current?.focus();
        else focusRow(activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(filteredEntries.length - 1);
        break;
      case 'ArrowRight':
        if (entry) {
          e.preventDefault();
          listHadFocus.current = true;
          fetchDirectory(entry.path);
        }
        break;
      case 'ArrowLeft':
      case 'Backspace':
        if (parentPath) {
          e.preventDefault();
          listHadFocus.current = true;
          fetchDirectory(parentPath);
        }
        break;
    }
  };

  // Focus returns to the list after navigating, so arrow keys keep working.
  useEffect(() => {
    if (!loading && listHadFocus.current) {
      listHadFocus.current = false;
      if (filteredEntries.length > 0) focusRow(0);
      else filterRef.current?.focus();
    }
  }, [loading]);

  const cancelPathEdit = () => {
    setIsEditingPath(false);
    setPathInput(currentPath);
  };
  // Esc while typing a path cancels the edit instead of closing the browser.
  useEscapeLayer(isEditingPath, cancelPathEdit);

  return (
    // Nested: Esc closes only this browser, not the New Session dialog underneath.
    <Modal
      nested
      onClose={onClose}
      size="md"
      icon="folder"
      heading="Choose a project folder"
      description="The agent reads and edits files inside this folder."
      className="fb-card"
      bodyClassName="fb-body"
      initialFocusRef={filterRef}
      headerActions={
        isHostMachine() ? (
          <Button
            size="sm"
            variant="ghost"
            icon="external"
            loading={nativeBrowsing}
            onClick={handleNativeBrowse}
            title="Pick a folder with the macOS Finder dialog"
          >
            Finder
          </Button>
        ) : null
      }
      footerStart={
        <span className="dlg-hint fb-keys">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>move</span>
          <Kbd>Enter</Kbd>
          <span>open</span>
          <Kbd>⌫</Kbd>
          <span>up</span>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="check" onClick={() => handleSelect(currentPath)} disabled={!currentPath || loading}>
            Use this folder
          </Button>
        </>
      }
    >
      {/* Path bar: parent, home, breadcrumbs, and a typed-path mode */}
      <div className="fb-pathbar">
        {isEditingPath ? (
          <form className="fb-pathform" onSubmit={handleManualPathSubmit}>
            <Input
              mono
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/Users/you/projects/my-app"
              aria-label="Folder path"
              spellCheck={false}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button size="sm" variant="primary" type="submit">
              Go
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelPathEdit}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <IconButton
              icon="arrowUp"
              label="Parent folder"
              size="sm"
              disabled={!parentPath || loading}
              onClick={() => parentPath && fetchDirectory(parentPath)}
            />
            <IconButton icon="home" label="Home folder" size="sm" disabled={loading} onClick={() => fetchDirectory('~')} />
            <nav className="fb-crumbs" aria-label="Folder path" ref={crumbsRef}>
              <button
                type="button"
                className={`fb-crumb${currentPath === '/' ? ' is-current' : ''}`}
                onClick={() => fetchDirectory('/')}
                title="Root (/)"
                aria-current={currentPath === '/' ? 'location' : undefined}
              >
                /
              </button>
              {breadcrumbs.map((crumb, i) => {
                const isLast = i === breadcrumbs.length - 1;
                return (
                  <React.Fragment key={crumb.path}>
                    {i > 0 && <Icon name="chevronRight" size={12} className="fb-crumb-sep" />}
                    <button
                      type="button"
                      className={`fb-crumb${isLast ? ' is-current' : ''}`}
                      onClick={() => fetchDirectory(crumb.path)}
                      title={crumb.path}
                      aria-current={isLast ? 'location' : undefined}
                    >
                      {crumb.name}
                    </button>
                  </React.Fragment>
                );
              })}
            </nav>
            <IconButton icon="edit" label="Type a path" size="sm" onClick={() => setIsEditingPath(true)} />
          </>
        )}
      </div>

      {/* The folder that "Use this folder" picks */}
      <div className="fb-current">
        <span className={`fb-current-icon${isGit ? ' is-git' : ''}`}>
          <Icon name={isGit ? 'branch' : 'folder'} size={16} />
        </span>
        <div className="fb-current-text">
          <div className="fb-current-name">
            <span>{baseName(currentPath) || '/'}</span>
            {isGit && (
              <Badge tone="ok" icon="branch">
                Git repository
              </Badge>
            )}
          </div>
          <div className="fb-current-path mono" title={currentPath}>
            {currentPath}
          </div>
        </div>
      </div>

      {recentWorkspaces.length > 0 && (
        <div className="dlg-chips" role="group" aria-label="Recent projects">
          <span className="dlg-eyebrow">Recent</span>
          {recentWorkspaces.slice(0, 8).map((rw) => (
            <button
              key={rw}
              type="button"
              className={`dlg-chip${rw === currentPath ? ' is-selected' : ''}`}
              aria-pressed={rw === currentPath}
              onClick={() => fetchDirectory(rw)}
              title={rw}
            >
              <Icon name="clock" size={12} />
              {baseName(rw)}
            </button>
          ))}
        </div>
      )}

      <div className="dlg-input-icon fb-filter">
        <Icon name="search" size={14} />
        <Input
          ref={filterRef}
          value={filterQuery}
          onChange={(e) => {
            setFilterQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusRow(0);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const first = filteredEntries[0];
              if (first) fetchDirectory(first.path);
            } else if (e.key === 'Backspace' && !filterQuery && parentPath && !loading) {
              // An empty filter has nothing to delete, so Backspace goes up a level.
              e.preventDefault();
              fetchDirectory(parentPath);
            }
          }}
          placeholder={entries.length > 0 ? `Filter ${entries.length} ${entries.length === 1 ? 'folder' : 'folders'}` : 'Filter folders'}
          aria-label="Filter folders"
          aria-controls="fb-list"
        />
        {filterQuery && (
          <IconButton
            icon="x"
            label="Clear filter"
            size="sm"
            className="dlg-input-clear"
            onClick={() => {
              setFilterQuery('');
              filterRef.current?.focus();
            }}
          />
        )}
      </div>

      <div className="fb-list-wrap">
        {error ? (
          <div className="fb-state">
            <EmptyState
              compact
              icon="alert"
              title="This folder couldn't be opened"
              description={error}
              action={
                <div className="fb-state-actions">
                  <Button size="sm" icon="refresh" onClick={() => fetchDirectory(lastRequested.current)}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" icon="home" onClick={() => fetchDirectory('~')}>
                    Go to home folder
                  </Button>
                </div>
              }
            />
          </div>
        ) : loading ? (
          <div className="fb-state fb-loading" role="status">
            <Spinner size={16} />
            <span>Loading folders…</span>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="fb-state">
            <EmptyState
              compact
              icon={filterQuery ? 'search' : 'folder'}
              title={filterQuery ? 'No folders match' : 'No subfolders here'}
              description={
                filterQuery
                  ? `Nothing in ${baseName(currentPath)} matches "${filterQuery}".`
                  : 'You can use this folder as it is, or go up a level.'
              }
              action={
                filterQuery ? (
                  <Button
                    size="sm"
                    icon="x"
                    onClick={() => {
                      setFilterQuery('');
                      filterRef.current?.focus();
                    }}
                  >
                    Clear filter
                  </Button>
                ) : parentPath ? (
                  <Button size="sm" icon="arrowUp" onClick={() => fetchDirectory(parentPath)}>
                    Up one level
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div
            className={`fb-list${filterQuery ? ' has-query' : ''}`}
            id="fb-list"
            role="list"
            aria-label={`Folders in ${baseName(currentPath)}`}
            ref={listRef}
            onKeyDown={onListKeyDown}
          >
            {filteredEntries.map((entry, i) => (
              <div key={entry.path} role="listitem" className={`fb-row${i === activeIndex ? ' is-active' : ''}`}>
                <button
                  type="button"
                  data-row
                  className="fb-row-open"
                  tabIndex={i === activeIndex ? 0 : -1}
                  onFocus={() => setActiveIndex(i)}
                  onClick={() => {
                    listHadFocus.current = true;
                    fetchDirectory(entry.path);
                  }}
                  title={`Open ${entry.name}`}
                >
                  <span className={`fb-row-icon${entry.isGit ? ' is-git' : ''}`}>
                    <Icon name={entry.isGit ? 'branch' : 'folder'} size={15} />
                  </span>
                  <span className="fb-row-name">{entry.name}</span>
                  {entry.isGit && <Badge tone="ok">git</Badge>}
                  <Icon name="chevronRight" size={14} className="fb-row-chevron" />
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="fb-row-select"
                  tabIndex={i === activeIndex ? 0 : -1}
                  onClick={() => handleSelect(entry.path)}
                  aria-label={`Use ${entry.name}`}
                >
                  Use
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};
