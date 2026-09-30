import React, { useEffect, useRef } from 'react';
import type { SlashCommandItem } from '../types';
import { Icon, IconButton, Kbd, Segmented, type IconName } from '../ui';
import { VendorIcon } from './VendorLogos';
import { cx } from './sessionMeta';

export type SlashCategory = 'all' | 'agent' | 'terminal';

const KNOWN_ICONS = new Set<string>([
  'archive', 'search', 'branch', 'chart', 'shield', 'fileEdit', 'alert', 'refresh', 'settings', 'help', 'diff', 'zap',
  'brain', 'undo', 'circleDot', 'list', 'message', 'globe', 'sparkles', 'swap', 'stop', 'card', 'commit', 'terminal',
]);

const iconFor = (cmd: SlashCommandItem): IconName =>
  cmd.icon && KNOWN_ICONS.has(cmd.icon) ? (cmd.icon as IconName) : cmd.category === 'terminal' ? 'terminal' : 'command';

/** The slash-command list shown above the composer while typing "/…". */
export const SlashMenu = React.forwardRef<
  HTMLDivElement,
  {
    agentId: string;
    agentName: string;
    query: string;
    commands: SlashCommandItem[];
    totalCount: number;
    category: SlashCategory;
    onCategoryChange: (c: SlashCategory) => void;
    selectedIndex: number;
    onHover: (index: number) => void;
    onSelect: (cmd: SlashCommandItem) => void;
    onClose: () => void;
  }
>(({ agentId, agentName, query, commands, totalCount, category, onCategoryChange, selectedIndex, onHover, onSelect, onClose }, ref) => {
  const listRef = useRef<HTMLDivElement>(null);
  const shortAgent = agentName.replace(/ \(ACP\)$/, '').split(' ')[0];

  // Keep the keyboard highlight in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-slash-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Commands arrive agent-first then terminal, so contiguous runs form the groups
  // and the flat index used for keyboard navigation stays in visual order.
  const groups: Array<{ key: string; label: React.ReactNode; items: Array<{ cmd: SlashCommandItem; index: number }> }> = [];
  commands.forEach((cmd, index) => {
    const key = cmd.category;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = {
        key,
        label:
          key === 'terminal' ? (
            <>
              <Icon name="terminal" size={11} /> CodePit
            </>
          ) : (
            <>
              <VendorIcon agentId={agentId} size={11} /> {agentName.replace(/ \(ACP\)$/, '')}
            </>
          ),
        items: [],
      };
      groups.push(g);
    }
    g.items.push({ cmd, index });
  });

  return (
    <div className="ws-popover ws-slash" ref={ref} role="dialog" aria-label="Slash commands">
      <div className="ws-slash-head">
        <span className="ws-slash-title">
          Commands
          {query && <span className="ws-slash-query mono">/{query}</span>}
        </span>
        <Segmented<SlashCategory>
          size="sm"
          label="Filter commands"
          value={category}
          onChange={onCategoryChange}
          options={[
            { value: 'all', label: `All ${totalCount}` },
            { value: 'agent', label: shortAgent },
            { value: 'terminal', label: 'Terminal' },
          ]}
        />
        <IconButton icon="x" size="sm" label="Close commands (Esc)" onClick={onClose} />
      </div>

      <div className="ws-slash-list" ref={listRef} role="listbox" aria-label="Commands">
        {commands.length === 0 ? (
          <div className="ws-slash-empty">
            No commands match <span className="mono">/{query}</span>
          </div>
        ) : (
          groups.map((g) => (
            <div key={`${g.key}-${g.items[0].index}`} className="ws-slash-group" role="group">
              <div className="ws-group-label">{g.label}</div>
              {g.items.map(({ cmd, index }) => (
                <div
                  key={cmd.command}
                  role="option"
                  aria-selected={index === selectedIndex}
                  data-slash-index={index}
                  className={cx('ws-slash-item', index === selectedIndex && 'is-selected')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onSelect(cmd)}
                  onMouseEnter={() => onHover(index)}
                >
                  <span className="ws-slash-icon">
                    <Icon name={iconFor(cmd)} size={14} />
                  </span>
                  <span className="ws-slash-text">
                    <span className="ws-slash-line">
                      <span className="ws-slash-cmd">{cmd.command}</span>
                      {cmd.hint && <span className="ws-slash-hint">{cmd.hint}</span>}
                      <span className="ws-slash-label">{cmd.label}</span>
                    </span>
                    <span className="ws-slash-desc">{cmd.description}</span>
                  </span>
                  {index === selectedIndex && (
                    <span className="ws-slash-enter" aria-hidden>
                      <Kbd>↵</Kbd>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="ws-popover-foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span>
          <Kbd>↵</Kbd> or <Kbd>Tab</Kbd> select
        </span>
        <span>
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </div>
  );
});
SlashMenu.displayName = 'SlashMenu';
