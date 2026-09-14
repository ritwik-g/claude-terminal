import { useEffect, useState } from 'react';
import { api, type DirListing } from '../api';
import { shortPath } from '../util';

interface Props {
  /** Where to open: the path already typed, when it names a readable folder. */
  start: string;
  /** Called with every folder navigated into, so the input tracks the browser. */
  onPick: (path: string) => void;
}

/**
 * An inline folder browser for the new-session popover.
 *
 * Inline rather than a native dialog because the same UI runs in a plain
 * browser tab, where there is no way to get an absolute path out of a file
 * picker. The server lists folders; nothing here ever reads a file.
 */
export function FolderBrowser({ start, onPick }: Props): JSX.Element {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');

  const go = async (target: string | undefined, pick: boolean) => {
    try {
      const next = await api.dirs(target);
      setListing(next);
      setError(null);
      setFilter('');
      if (pick) onPick(next.path);
    } catch (e: any) {
      // A typed path that does not exist yet is normal while typing — open at
      // home instead of showing an error for the very first listing.
      if (!listing && target) return go(undefined, false);
      setError(String(e?.message ?? e));
    }
  };

  // Only on open: re-listing on every keystroke in the input would fight the
  // user's own navigation here.
  useEffect(() => {
    void go(start.trim() || undefined, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!listing) {
    return <div className="folder-browser empty">{error ?? 'Loading…'}</div>;
  }

  const join = (name: string) => (listing.path.endsWith('/') ? listing.path + name : `${listing.path}/${name}`);
  const q = filter.trim().toLowerCase();
  const shown = listing.dirs.filter(
    (d) => (showHidden || !d.startsWith('.')) && (!q || d.toLowerCase().includes(q)),
  );

  return (
    <div className="folder-browser">
      <div className="fb-bar">
        <button
          className="btn sm icon"
          disabled={!listing.parent}
          onClick={() => listing.parent && void go(listing.parent, true)}
          title="Up one folder"
          aria-label="Up one folder"
        >
          ↑
        </button>
        <button
          className="btn sm icon"
          onClick={() => void go(listing.home, true)}
          title="Home folder"
          aria-label="Home folder"
        >
          ~
        </button>
        <span className="fb-path" title={listing.path}>{shortPath(listing.path)}</span>
        <label className="fb-hidden" title="Show folders starting with a dot">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          hidden
        </label>
      </div>
      <input
        className="tag-input fb-filter"
        value={filter}
        placeholder="Filter folders…"
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          // Enter descends into the single match, so a folder can be reached
          // by typing alone.
          if (e.key === 'Enter' && shown.length === 1) {
            e.preventDefault();
            e.stopPropagation();
            void go(join(shown[0]), true);
          }
        }}
      />
      <div className="fb-list" role="listbox" aria-label="Folders">
        {shown.map((d) => (
          <button
            key={d}
            className="fb-item"
            role="option"
            aria-selected={false}
            onClick={() => void go(join(d), true)}
            title={join(d)}
          >
            <span aria-hidden>▸</span> {d}
          </button>
        ))}
        {!shown.length && <div className="fb-none">{q ? 'No folder matches.' : 'No subfolders.'}</div>}
        {listing.truncated && <div className="fb-none">Only the first 1000 folders are listed.</div>}
      </div>
      {error && <div className="fb-none err">{error}</div>}
    </div>
  );
}
