import React, { useState, useEffect, useRef } from 'react';
import type { AcpSession } from '../types';
import { api } from '../api';

interface SearchModalProps {
  onClose: () => void;
  onSelectSession: (id: string) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({ onClose, onSelectSession }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AcpSession[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api.search('').then((res) => setResults(res.sessions)).catch(() => {});
  }, []);

  const handleQueryChange = (val: string) => {
    setQuery(val);
    api.search(val).then((res) => {
      setResults(res.sessions);
      setSelectedIndex(0);
    }).catch(() => {});
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1 < results.length ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        onSelectSession(results[selectedIndex].id);
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '14px', borderBottom: '1px solid var(--border-subtle)' }}>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            style={{ fontSize: '15px', padding: '10px 14px' }}
            placeholder="Search across all conversations, prompts, and directories..."
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
          {results.map((session, index) => (
            <div
              key={session.id}
              style={{
                padding: '10px 12px',
                borderRadius: '6px',
                marginBottom: '4px',
                background: index === selectedIndex ? 'var(--bg-card-active)' : 'transparent',
                cursor: 'pointer',
                borderLeft: index === selectedIndex ? '3px solid #3b82f6' : '3px solid transparent',
              }}
              onClick={() => {
                onSelectSession(session.id);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-main)' }}>
                  {session.title}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {session.agentName}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {session.cwd} • {session.lastPrompt || session.recap}
              </div>
            </div>
          ))}

          {results.length === 0 && (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
              No sessions match "{query}"
            </div>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: '11px', color: 'var(--text-dim)', display: 'flex', justifyContent: 'space-between' }}>
          <span>↑↓ to navigate • Enter to select</span>
          <span>Esc to dismiss</span>
        </div>
      </div>
    </div>
  );
};
