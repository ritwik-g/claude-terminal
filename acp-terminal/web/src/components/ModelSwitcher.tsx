import React, { useEffect, useRef, useState } from 'react';
import type { AcpSession, AgentDescriptor } from '../types';
import { api } from '../api';
import { Badge, Button, Icon, IconButton, Input, Kbd, Segmented, Switch } from '../ui';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { cx } from './sessionMeta';

type Effort = 'off' | 'low' | 'medium' | 'high';
type ContextMode = 'compact' | 'full' | 'none';

const CONTEXT_MODE_HELP: Record<ContextMode, string> = {
  compact: 'Summarise earlier turns and touched files into a lean checkpoint. Recommended.',
  full: 'Hand over the recent turns word for word.',
  none: 'Start the new model with a blank conversation. Files and git state are kept.',
};

/**
 * The composer's model and effort popover: models grouped by agent, an effort
 * control, and the handover options behind an "Advanced" disclosure. Arrow keys
 * move between models; Enter switches.
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
  const listRef = useRef<HTMLDivElement>(null);

  const currentModelMeta = getModelMeta(session.model || 'sonnet');
  const activeEffort: Effort = (session.effort as Effort) || 'medium';

  // Focus the active model so arrow keys start from there.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLButtonElement>('.ws-model-row.is-selected') || list.querySelector<HTMLButtonElement>('.ws-model-row');
    target?.focus({ preventScroll: false });
    target?.scrollIntoView({ block: 'nearest' });
  }, []);

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.ws-model-row:not(:disabled)') || []);
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = idx === -1 ? 0 : Math.min(rows.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = idx === -1 ? rows.length - 1 : Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    if (next === -1) return;
    e.preventDefault();
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  };

  const handleInPlaceSwitch = async (targetAgentId: string, targetModel?: string) => {
    if (targetAgentId === session.agentId && (targetModel === session.model || !targetModel)) {
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

  const handleSetEffort = async (effort: Effort) => {
    try {
      await api.setSessionEffort(session.id, effort);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to update reasoning effort: ${err.message}`);
    }
  };

  const applyCustomModel = () => {
    const id = customModelInput.trim();
    if (!id) return;
    handleInPlaceSwitch(session.agentId, id);
    setCustomModelInput('');
  };

  const groups = agents
    .map((agent) => ({ agent, models: agent.availableModels || [] }))
    .filter((g) => g.models.length > 0);

  return (
    <div className="ws-popover ws-model-switcher" role="dialog" aria-label="Model and effort">
      <div className="ws-sheet-handle" aria-hidden />
      <div className="ws-model-head">
        <div>
          <div className="ws-popover-title">Model and effort</div>
          <div className="ws-popover-desc">Applies to your next messages. The conversation is kept.</div>
        </div>
        <IconButton icon="x" size="sm" label="Close" onClick={onClose} />
      </div>

      {currentModelMeta.supportsEffort && (
        <div className="ws-model-effort">
          <span className="ws-model-effort-label">
            <Icon name="brain" size={13} />
            Thinking effort
          </span>
          <Segmented<Effort>
            size="sm"
            label="Thinking effort"
            value={activeEffort}
            onChange={handleSetEffort}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
        </div>
      )}

      <div className="ws-model-list" ref={listRef} onKeyDown={onListKeyDown} role="listbox" aria-label="Models">
        {groups.map(({ agent, models }) => (
          <div key={agent.id} className="ws-model-group" role="group" aria-label={agent.name}>
            <div className="ws-group-label">
              <VendorIcon agentId={agent.id} size={12} />
              {agent.name.replace(/ \(ACP\)$/, '')}
            </div>
            {models.map((mId) => {
              const meta = getModelMeta(mId);
              const isSelected =
                agent.id === session.agentId && (session.model === mId || (!session.model && mId === agent.defaultModel));
              const key = `${agent.id}:${mId}`;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cx('ws-model-row', isSelected && 'is-selected')}
                  disabled={switchingTo !== null}
                  onClick={() => handleInPlaceSwitch(agent.id, mId)}
                >
                  <span className="ws-model-vendor">
                    <VendorIcon agentId={agent.id} size={16} />
                  </span>
                  <span className="ws-model-text">
                    <span className="ws-model-name">
                      {meta.label}
                      {meta.supportsEffort && (
                        <span className="ws-model-thinking" title="Supports thinking effort">
                          <Icon name="brain" size={11} />
                        </span>
                      )}
                    </span>
                    <span className="ws-model-desc">{meta.description}</span>
                  </span>
                  <span className="ws-model-end">
                    {switchingTo === key ? (
                      <span className="ws-model-switching">Switching…</span>
                    ) : isSelected ? (
                      <Icon name="check" size={15} className="ws-model-check" />
                    ) : (
                      meta.badge && <Badge className="ws-model-badge">{meta.badge.split(' · ')[0]}</Badge>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
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
