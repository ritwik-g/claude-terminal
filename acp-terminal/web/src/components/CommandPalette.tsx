import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AcpSession, SessionSummary } from '../types';
import { api } from '../api';
import { Modal } from './Modal';
import { Icon, Kbd, Spinner, StatusDot, type IconName } from '../ui';
import { folderName, relativeTime, sessionStatus, shortModel, MOD_KEY } from './Sidebar';
import { VendorIcon } from './VendorLogos';

export interface PaletteAction {
  id: string;
  label: string;
  icon: IconName;
  group: 'Current session' | 'Actions';
  /** Extra words the fuzzy match considers, e.g. synonyms. */
  keywords?: string;
  /** Keys shown on the right, e.g. [MOD_KEY, 'N']. */
  shortcut?: string[];
  /** Listed only once the user types a query, to keep the empty list short. */
  searchOnly?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  actions: PaletteAction[];
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

type Item =
  | {
      kind: 'session';
      key: string;
      group: string;
      session: SessionSummary;
      score: number;
      match: number[];
      snippet?: string;
      term?: string;
    }
  | { kind: 'action'; key: string; group: string; action: PaletteAction; score: number; match: number[] };

const GROUP_ORDER = ['Sessions', 'Current session', 'Actions', 'In transcripts'];

/**
 * Fuzzy match: a contiguous substring scores highest (more at a word start),
 * otherwise every query character must appear in order. Returns the score and
 * the matched character positions, or null for no match.
 */
function fuzzy(query: string, text: string): { score: number; match: number[] } | null {
  const q = query.toLowerCase().trim();
  if (!q) return { score: 0, match: [] };
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at !== -1) {
    const wordStart = at === 0 || /[\s/_\-.]/.test(t[at - 1]);
    return { score: 1000 - at + (wordStart ? 200 : 0), match: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  const chars = q.replace(/\s+/g, '');
  const match: number[] = [];
  let score = 0;
  let ti = 0;
  for (const c of chars) {
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    if (match.length && found === match[match.length - 1] + 1) score += 8;
    if (found === 0 || /[\s/_\-.]/.test(t[found - 1])) score += 10;
    score -= Math.min(found - ti, 10);
    match.push(found);
    ti = found + 1;
  }
  return { score: 100 + score, match };
}

function sessionHaystack(s: SessionSummary): string {
  return [folderName(s.cwd), s.agentName, s.git?.branch, s.model].filter(Boolean).join(' ');
}

/** A short excerpt around the first transcript hit for the query. */
function transcriptSnippet(session: AcpSession, query: string): string | undefined {
  const term = query.trim().toLowerCase().split(/\s+/)[0];
  if (!term) return undefined;
  const texts: string[] = [];
  for (const turn of session.turns) {
    if (turn.content) texts.push(turn.content);
    for (const tc of turn.toolCalls || []) texts.push(tc.title);
  }
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ');
    const i = text.toLowerCase().indexOf(term);
    if (i === -1) continue;
    // Start and end on word boundaries so the excerpt doesn't open mid-word.
    let start = Math.max(0, i - 36);
    if (start > 0) {
      const space = text.indexOf(' ', start);
      start = space !== -1 && space < i ? space + 1 : start;
    }
    let end = Math.min(text.length, i + term.length + 60);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      end = space > i + term.length ? space : end;
    }
    return `${start > 0 ? '… ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' …' : ''}`;
  }
  return undefined;
}

/** Positions of the first case-insensitive occurrence of `term` in `text`. */
function termMatch(text: string, term?: string): number[] {
  if (!term) return [];
  const at = text.toLowerCase().indexOf(term);
  return at === -1 ? [] : Array.from({ length: term.length }, (_, i) => at + i);
}

const Highlight: React.FC<{ text: string; match: number[] }> = ({ text, match }) => {
  if (!match.length) return <>{text}</>;
  const set = new Set(match);
  const out: React.ReactNode[] = [];
  let buf = '';
  let marked = false;
  const flush = (i: number) => {
    if (!buf) return;
    out.push(marked ? <mark key={i}>{buf}</mark> : buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== marked) {
      flush(i);
      marked = m;
    }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  sessions,
  currentSessionId,
  actions,
  onClose,
  onSelectSession,
}) => {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [transcriptHits, setTranscriptHits] = useState<{ query: string; sessions: AcpSession[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  // Transcript search on the server, debounced. Only the newest request may
  // update results, so a slow response for an old query can't overwrite it.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      requestSeq.current++;
      setTranscriptHits(null);
      setSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((res) => {
          if (seq !== requestSeq.current) return;
          setTranscriptHits({ query: q, sessions: res.sessions });
          setSearchError(null);
        })
        .catch((err) => {
          if (seq === requestSeq.current) setSearchError(err.message || 'Search failed');
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, 160);
    return () => clearTimeout(timer);
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const out: Item[] = [];

    // Sessions
    const sessionItems: Item[] = [];
    for (const s of sessions) {
      if (!q) {
        if (s.id === currentSessionId) continue;
        sessionItems.push({ kind: 'session', key: `s:${s.id}`, group: 'Sessions', session: s, score: 0, match: [] });
        continue;
      }
      const title = fuzzy(q, s.title);
      // Folder, agent, branch and model count only as a contiguous match: a
      // scattered one across those words matches almost anything.
      const restAt = sessionHaystack(s).toLowerCase().indexOf(q.toLowerCase());
      const restScore = restAt === -1 ? -Infinity : (1000 - restAt) * 0.7;
      const score = Math.max(title?.score ?? -Infinity, restScore);
      if (score === -Infinity) continue;
      sessionItems.push({ kind: 'session', key: `s:${s.id}`, group: 'Sessions', session: s, score, match: title?.match ?? [] });
    }
    if (q) sessionItems.sort((a, b) => b.score - a.score);
    out.push(...sessionItems.slice(0, q ? 8 : 5));

    // Actions
    const actionItems: Item[] = [];
    for (const a of actions) {
      if (!q && a.searchOnly) continue;
      const label = fuzzy(q, a.label);
      const kw = a.keywords ? fuzzy(q, a.keywords) : null;
      const score = Math.max(label?.score ?? -Infinity, (kw?.score ?? -Infinity) * 0.6);
      if (score === -Infinity) continue;
      actionItems.push({ kind: 'action', key: `a:${a.id}`, group: a.group, action: a, score, match: label?.match ?? [] });
    }
    if (q) actionItems.sort((a, b) => b.score - a.score);
    out.push(...actionItems);

    // Transcript matches not already listed by title
    if (q && transcriptHits && transcriptHits.query === q) {
      const listed = new Set(out.filter((i) => i.kind === 'session').map((i) => (i as { session: SessionSummary }).session.id));
      const byId = new Map(sessions.map((s) => [s.id, s]));
      for (const hit of transcriptHits.sessions) {
        if (listed.has(hit.id)) continue;
        const summary = byId.get(hit.id);
        if (!summary) continue;
        out.push({
          kind: 'session',
          key: `t:${hit.id}`,
          group: 'In transcripts',
          session: summary,
          score: 0,
          match: [],
          snippet: transcriptSnippet(hit, q),
          term: q.toLowerCase().split(/\s+/)[0],
        });
        if (out.filter((i) => i.group === 'In transcripts').length >= 8) break;
      }
    }

    return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [query, sessions, actions, currentSessionId, transcriptHits]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    if (selected >= items.length) setSelected(Math.max(0, items.length - 1));
  }, [items.length, selected]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'session') onSelectSession(item.session.id);
    else item.action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = items.length;
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (down || up) {
      e.preventDefault();
      if (n) setSelected((i) => (down ? (i + 1) % n : (i - 1 + n) % n));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';
  const activeId = items[selected] ? `cmdk-opt-${selected}` : undefined;

  return (
    <Modal onClose={onClose} title="Command palette" initialFocusRef={inputRef} className="cmdk" overlayClassName="cmdk-overlay">
      <div className="cmdk-input-row">
        <Icon name="search" size={16} className="cmdk-input-icon" />
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          placeholder="Search sessions or run a command"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
        />
        {searching && <Spinner size={13} />}
      </div>

      <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Results" ref={listRef}>
        {items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <React.Fragment key={item.key}>
              {header && (
                <div className="cmdk-group" role="presentation">
                  {header}
                </div>
              )}
              <div
                id={`cmdk-opt-${index}`}
                role="option"
                aria-selected={index === selected}
                data-index={index}
                className={`cmdk-item ${index === selected ? 'is-selected' : ''}`}
                onMouseMove={() => index !== selected && setSelected(index)}
                onClick={() => run(item)}
              >
                {item.kind === 'session' ? <SessionOption item={item} /> : <ActionOption item={item} />}
              </div>
            </React.Fragment>
          );
        })}

        {items.length === 0 && (
          <div className={`cmdk-empty ${searchError ? 'is-error' : ''}`}>
            {searchError
              ? `Transcript search failed: ${searchError}`
              : searching
              ? 'Searching transcripts…'
              : `Nothing matches "${query.trim()}".`}
          </div>
        )}
      </div>

      <div className="cmdk-foot">
        <span className="cmdk-hint">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span className="cmdk-hint">
          <Kbd>↵</Kbd> to open
        </span>
        <span className="cmdk-hint">
          <Kbd>Esc</Kbd> to close
        </span>
        <span className="cmdk-foot-spacer" />
        <span className="cmdk-hint">
          <Kbd>{MOD_KEY}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </div>
    </Modal>
  );
};

const SessionOption: React.FC<{ item: Extract<Item, { kind: 'session' }> }> = ({ item }) => {
  const s = item.session;
  const status = sessionStatus(s);
  const model = shortModel(s.model);
  return (
    <>
      <span className="cmdk-item-lead">
        <StatusDot tone={status.tone} pulse={status.pulse} label={status.label} />
      </span>
      <span className="cmdk-item-body">
        <span className="cmdk-item-title">
          <Highlight text={s.title} match={item.match} />
        </span>
        <span className="cmdk-item-sub">
          {item.snippet ? (
            <span className="cmdk-snippet">
              <Highlight text={item.snippet} match={termMatch(item.snippet, item.term)} />
            </span>
          ) : (
            <>
              <VendorIcon agentId={s.agentId} size={11} />
              <span>{folderName(s.cwd)}</span>
              {s.git?.branch && <span className="cmdk-sub-sep">{s.git.branch}</span>}
              {model && <span className="cmdk-sub-sep mono">{model}</span>}
            </>
          )}
        </span>
      </span>
      <span className="cmdk-item-trail">
        <span className={`cmdk-state tone-${status.tone}`}>{status.label}</span>
        <span className="cmdk-time">{relativeTime(s.updatedAt)}</span>
      </span>
    </>
  );
};

const ActionOption: React.FC<{ item: Extract<Item, { kind: 'action' }> }> = ({ item }) => (
  <>
    <span className="cmdk-item-lead cmdk-action-icon">
      <Icon name={item.action.icon} size={14} />
    </span>
    <span className="cmdk-item-body">
      <span className="cmdk-item-title">
        <Highlight text={item.action.label} match={item.match} />
      </span>
    </span>
    {item.action.shortcut && (
      <span className="cmdk-item-trail cmdk-keys">
        {item.action.shortcut.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    )}
  </>
);
