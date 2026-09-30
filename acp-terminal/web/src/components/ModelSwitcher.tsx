import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, AgentDescriptor, ConfigChoice } from '../types';
import { api } from '../api';
import { Badge, Button, Icon, Input, Kbd, Segmented, Switch } from '../ui';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { cx } from './sessionMeta';
import { baseModel, modelChoices, sameModel, splitModels } from '../effort';

type ContextMode = 'compact' | 'full' | 'none';

const CONTEXT_MODE_HELP: Record<ContextMode, string> = {
  compact: 'Summarise earlier turns and touched files into a lean checkpoint. Recommended.',
  full: 'Hand over the recent turns word for word.',
  none: 'Start the new model with a blank conversation. Files and git state are kept.',
};

/** "<agentId>:<model>" for the favourites list. */
const favKey = (agentId: string, model: string) => `${agentId}:${model}`;

// Loaded once per page; every device shares the list through the server
let favoritesCache: string[] | null = null;

type Rail = 'favorites' | string;

interface Row {
  agent: AgentDescriptor;
  choice: ConfigChoice;
}

/**
 * The composer's model popover: a rail to pick an agent (or starred models), a search
 * over every agent's models, and older versions under "Legacy models". Arrow keys move
 * between models; Enter switches.
 */
export const ModelSwitcher: React.FC<{
  session: AcpSession;
  agents: AgentDescriptor[];
  onClose: () => void;
  onRefresh: () => void;
  onOpenSwitchModal: () => void;
}> = ({ session, agents, onClose, onRefresh, onOpenSwitchModal }) => {
  const [contextTransferMode, setContextTransferMode] = useState<ContextMode>('compact');
  const [autoContinueOnSwitch, setAutoContinueOnSwitch] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rail, setRail] = useState<Rail>(session.agentId);
  const [showLegacy, setShowLegacy] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(favoritesCache ?? []);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    api
      .getFavoriteModels()
      .then((res) => {
        favoritesCache = res.favorites;
        setFavorites(res.favorites);
      })
      .catch(() => {});
  }, []);

  const toggleFavorite = (agentId: string, model: string) => {
    const key = favKey(agentId, model);
    const next = favorites.includes(key) ? favorites.filter((f) => f !== key) : [...favorites, key];
    setFavorites(next);
    favoritesCache = next;
    api.setFavoriteModels(next).catch((err) => alert(`Could not save favourites: ${err.message}`));
  };

  // What each agent advertised (new models, 1M-context variants), else the registry list;
  // the session's own agent has just reported its list, which beats the one loaded with the page
  const byAgent = agents
    .map((agent) => ({ agent, ...splitModels(modelChoices(agent, agent.id === session.agentId ? session.agentOptions : undefined)) }))
    .filter((g) => g.current.length + g.legacy.length > 0);
  const everything: Row[] = byAgent.flatMap((g) => [...g.current, ...g.legacy].map((choice) => ({ agent: g.agent, choice })));

  const q = query.trim().toLowerCase();
  let rows: Row[];
  let legacyRows: Row[] = [];
  if (q) {
    rows = everything.filter(({ agent, choice }) =>
      [choice.label, choice.value, choice.description || '', agent.name].some((t) => t.toLowerCase().includes(q))
    );
  } else if (rail === 'favorites') {
    rows = everything.filter(({ agent, choice }) => favorites.includes(favKey(agent.id, choice.value)));
  } else {
    const group = byAgent.find((g) => g.agent.id === rail) ?? byAgent[0];
    rows = (group?.current ?? []).map((choice) => ({ agent: group!.agent, choice }));
    legacyRows = (group?.legacy ?? []).map((choice) => ({ agent: group!.agent, choice }));
  }
  const listed = showLegacy && legacyRows.length > 0 ? legacyRows : rows;

  const isCurrent = (agent: AgentDescriptor, mId: string) =>
    agent.id === session.agentId &&
    (sameModel(baseModel(session.model || ''), mId) ||
      baseModel(session.agentOptions?.currentModel || '') === mId ||
      (!session.model && mId === agent.defaultModel));

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const targets = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.mp-row-main:not(:disabled), .mp-legacy') || []);
    if (targets.length === 0) return;
    const idx = targets.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = idx === -1 ? 0 : Math.min(targets.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = idx <= 0 ? -2 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = targets.length - 1;
    if (next === -1) return;
    e.preventDefault();
    if (next === -2) {
      searchRef.current?.focus();
      return;
    }
    targets[next].focus();
    targets[next].scrollIntoView({ block: 'nearest' });
  };

  const handleInPlaceSwitch = async (targetAgentId: string, targetModel?: string) => {
    if (targetAgentId === session.agentId && (!targetModel || sameModel(targetModel, session.model))) {
      onClose();
      return;
    }
    setSwitchingTo(`${targetAgentId}:${targetModel || ''}`);
    try {
      if (autoContinueOnSwitch) {
        await api.switchAgent(session.id, targetAgentId, {
          model: targetModel,
          inPlace: true,
          contextMode: contextTransferMode,
          skipInitialPrompt: false,
        });
      } else {
        await api.setSessionAgent(session.id, targetAgentId, targetModel, session.effort, contextTransferMode);
      }
      onClose();
      onRefresh();
    } catch (err: any) {
      alert(`Failed to switch model: ${err.message}`);
    } finally {
      setSwitchingTo(null);
    }
  };

  const applyCustomModel = () => {
    const id = customModelInput.trim();
    if (!id) return;
    handleInPlaceSwitch(session.agentId, id);
    setCustomModelInput('');
  };

  const pickRail = (r: Rail) => {
    setRail(r);
    setShowLegacy(false);
    setQuery('');
  };

  const railLabel = (agent: AgentDescriptor) => agent.name.replace(/ \(ACP\)$/, '');

  return (
    <div className="ws-popover ws-model-switcher" role="dialog" aria-label="Model">
      <div className="ws-sheet-handle" aria-hidden />
      <div className="mp-body">
        <nav className="mp-rail" aria-label="Agents">
          <button
            type="button"
            className={cx('mp-rail-btn', rail === 'favorites' && !q && 'is-active')}
            onClick={() => pickRail('favorites')}
            title="Starred models"
            aria-pressed={rail === 'favorites'}
          >
            <Icon name="star" size={17} />
          </button>
          <span className="mp-rail-rule" aria-hidden />
          {byAgent.map(({ agent }) => (
            <button
              key={agent.id}
              type="button"
              className={cx('mp-rail-btn', rail === agent.id && !q && 'is-active')}
              onClick={() => pickRail(agent.id)}
              title={railLabel(agent)}
              aria-pressed={rail === agent.id}
            >
              <VendorIcon agentId={agent.id} size={18} />
            </button>
          ))}
        </nav>

        <div className="mp-main">
          <label className="mp-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search models…"
              value={query}
              aria-label="Search models"
              onChange={(e) => {
                setQuery(e.target.value);
                setShowLegacy(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  listRef.current?.querySelector<HTMLButtonElement>('.mp-row-main:not(:disabled), .mp-legacy')?.focus();
                } else if (e.key === 'Enter' && listed.length > 0) {
                  e.preventDefault();
                  handleInPlaceSwitch(listed[0].agent.id, listed[0].choice.value);
                }
              }}
            />
          </label>

          <div className="ws-model-list mp-list" ref={listRef} onKeyDown={onListKeyDown} role="listbox" aria-label="Models">
            {showLegacy && (
              <button type="button" className="mp-back" onClick={() => setShowLegacy(false)}>
                <Icon name="chevronLeft" size={14} />
                Legacy models
              </button>
            )}
            {listed.length === 0 && (
              <div className="mp-empty">
                {q ? `No models match “${query.trim()}”` : rail === 'favorites' ? 'Star a model to keep it here.' : 'This agent lists no models.'}
              </div>
            )}
            {listed.map(({ agent, choice }) => {
              const mId = choice.value;
              const meta = getModelMeta(mId);
              // Advertised models carry the agent's own name and description
              const advertised = choice.label !== choice.value;
              const label = advertised ? choice.label : meta.label;
              const description = advertised ? choice.description || '' : meta.description;
              const selected = isCurrent(agent, mId);
              const starred = favorites.includes(favKey(agent.id, mId));
              const key = `${agent.id}:${mId}`;
              return (
                <div key={key} className={cx('ws-model-row mp-row', selected && 'is-selected')} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    className="mp-row-main"
                    disabled={switchingTo !== null}
                    onClick={() => handleInPlaceSwitch(agent.id, mId)}
                  >
                    <span className="ws-model-name">
                      {label}
                      {choice.isNew && <Badge tone="info" className="mp-new">New</Badge>}
                      {switchingTo === key && <span className="ws-model-switching">Switching…</span>}
                    </span>
                    <span className="mp-row-sub">
                      <VendorIcon agentId={agent.id} size={12} />
                      <span className="mp-row-agent">{railLabel(agent)}</span>
                      {description && <span className="ws-model-desc">· {description}</span>}
                    </span>
                  </button>
                  {selected && <Icon name="check" size={15} className="ws-model-check" />}
                  <button
                    type="button"
                    className={cx('mp-star', starred && 'is-on')}
                    aria-pressed={starred}
                    aria-label={starred ? `Unstar ${label}` : `Star ${label}`}
                    title={starred ? 'Remove from starred' : 'Star this model'}
                    onClick={() => toggleFavorite(agent.id, mId)}
                  >
                    <Icon name="star" size={15} />
                  </button>
                </div>
              );
            })}
            {!showLegacy && legacyRows.length > 0 && (
              <button type="button" className="mp-legacy" onClick={() => setShowLegacy(true)}>
                <span className="mp-legacy-text">
                  <span className="ws-model-name">Legacy models</span>
                  <span className="ws-model-desc">
                    {legacyRows.length} {legacyRows.length === 1 ? 'model' : 'models'}
                  </span>
                </span>
                <Icon name="chevronRight" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="ws-model-advanced">
        <button
          type="button"
          className="ws-disclosure"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <Icon name={showAdvanced ? 'chevronDown' : 'chevronRight'} size={13} />
          Advanced
          <span className="ws-disclosure-hint">Handover, custom model</span>
        </button>
        {showAdvanced && (
          <div className="ws-advanced-body">
            <div className="ws-advanced-field">
              <div className="ws-advanced-label">Context handover when switching</div>
              <Segmented<ContextMode>
                size="sm"
                block
                label="Context handover"
                value={contextTransferMode}
                onChange={setContextTransferMode}
                options={[
                  { value: 'compact', label: 'Compact', title: CONTEXT_MODE_HELP.compact },
                  { value: 'full', label: 'Full turns', title: CONTEXT_MODE_HELP.full },
                  { value: 'none', label: 'Clean slate', title: CONTEXT_MODE_HELP.none },
                ]}
              />
              <div className="ws-advanced-hint">{CONTEXT_MODE_HELP[contextTransferMode]}</div>
            </div>
            <Switch
              checked={autoContinueOnSwitch}
              onChange={setAutoContinueOnSwitch}
              label="Continue the task after switching"
              description="Prompts the new model to pick up where the last one stopped."
            />
            <div className="ws-advanced-field">
              <label className="ws-advanced-label" htmlFor="ws-custom-model">
                Custom model ID
              </label>
              <div className="ws-custom-model">
                <Input
                  id="ws-custom-model"
                  mono
                  placeholder="e.g. claude-opus-4, gpt-5-codex"
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyCustomModel();
                    }
                  }}
                />
                <Button size="md" disabled={!customModelInput.trim() || switchingTo !== null} onClick={applyCustomModel}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="ws-popover-foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> choose
        </span>
        <span>
          <Kbd>↵</Kbd> switch
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="swap"
          className="ws-foot-action"
          onClick={() => {
            onClose();
            onOpenSwitchModal();
          }}
        >
          Switch agent or fork…
        </Button>
      </div>
    </div>
  );
};
