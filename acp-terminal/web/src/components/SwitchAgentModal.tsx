import React, { useState, useEffect, useId } from 'react';
import type { AcpSession, AgentDescriptor } from '../types';
import { api } from '../api';
import { Badge, Button, ChoiceCard, Icon, Switch, Textarea, type IconName } from '../ui';
import { Modal } from './Modal';
import { AgentModelPicker, agentDisplayName, getModelMeta, onRadioGroupKeyDown } from './AgentModelPicker';
import { VendorIcon } from './VendorLogos';

interface SwitchAgentModalProps {
  currentSession: AcpSession;
  agents: AgentDescriptor[];
  onClose: () => void;
  onSwitched: (newSessionId: string) => void;
}

type ContextMode = 'compact' | 'full' | 'none';

const CONTEXT_OPTIONS: Array<{ value: ContextMode; title: string; description: string; icon: IconName; recommended?: boolean }> = [
  {
    value: 'compact',
    title: 'Summary',
    description: 'Earlier turns, decisions and edits, condensed.',
    icon: 'layers',
    recommended: true,
  },
  {
    value: 'full',
    title: 'Recent messages',
    description: 'The latest messages, word for word.',
    icon: 'message',
  },
  {
    value: 'none',
    title: 'None',
    description: 'Just the project files and git state.',
    icon: 'circle',
  },
];

const CONTEXT_LABEL: Record<ContextMode, string> = {
  compact: 'Summary of earlier turns',
  full: 'Recent messages, word for word',
  none: 'No conversation, only the project',
};

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
  const [contextMode, setContextMode] = useState<ContextMode>('compact');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

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
    if (!currentTargetAgent) return;
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
      setError(err.message || 'The switch did not go through.');
      setLoading(false);
    }
  };

  const targetName = currentTargetAgent ? agentDisplayName(currentTargetAgent) : 'another agent';
  const currentModelLabel = currentSession.model ? getModelMeta(currentSession.model).label : null;
  const goal = currentSession.lastPrompt || currentSession.recap;
  const git = currentSession.git;
  const promptEmpty = sendInitialPrompt && !customPrompt.trim();

  const primaryLabel = loading
    ? inPlace ? 'Switching…' : 'Forking…'
    : inPlace ? `Continue with ${targetName}` : `Fork to ${targetName}`;

  return (
    <Modal
      onClose={onClose}
      size="md"
      icon="swap"
      heading="Switch agent"
      description="Continue this session with another agent."
      bodyClassName="sw-body"
      footerStart={
        promptEmpty ? (
          <span className="dlg-hint tone-warn">
            <Icon name="alert" size={13} />
            Write a prompt, or switch it off.
          </span>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={inPlace ? 'swap' : 'branch'}
            loading={loading}
            disabled={!currentTargetAgent || promptEmpty}
            onClick={handleSwitch}
          >
            {primaryLabel}
          </Button>
        </>
      }
    >
      <div className="sw-from">
        <span className="dlg-eyebrow">Now</span>
        <span className="sw-from-agent">
          <VendorIcon agentId={currentSession.agentId} size={14} />
          <span>{agentDisplayName({ id: currentSession.agentId, name: currentSession.agentName })}</span>
          {currentModelLabel && <span className="sw-from-model">{currentModelLabel}</span>}
        </span>
        <Icon name="arrowRight" size={13} className="sw-from-arrow" />
        <span className="sw-from-agent is-target">
          {currentTargetAgent && <VendorIcon agentId={currentTargetAgent.id} size={14} />}
          <span>{targetName}</span>
          {targetModel && <span className="sw-from-model">{getModelMeta(targetModel).label}</span>}
        </span>
      </div>

      {error && (
        <div className="dlg-callout tone-danger" role="alert">
          <Icon name="alert" size={15} />
          <div className="dlg-callout-text">
            <strong>The switch didn't go through.</strong>
            <span>{error}</span>
          </div>
        </div>
      )}

      <AgentModelPicker
        agents={availableTargets}
        selectedAgentId={targetAgentId}
        selectedModel={targetModel}
        onAgentChange={(id) => setTargetAgentId(id)}
        onModelChange={(model) => setTargetModel(model)}
        disabled={loading}
        agentLabel="Switch to"
      />

      <section className="dlg-section">
        <span className="dlg-label" id={`${uid}-mode`}>
          Switch mode
        </span>
        <div className="dlg-choice-grid cols-2" role="radiogroup" aria-labelledby={`${uid}-mode`} onKeyDown={onRadioGroupKeyDown}>
          <ChoiceCard
            selected={inPlace}
            onSelect={() => setInPlace(true)}
            disabled={loading}
            icon={<Icon name="swap" size={15} />}
            title="Continue in this session"
            badge={<Badge tone="accent">Recommended</Badge>}
            description="Same thread and history. The new agent picks up where this one stopped."
          />
          <ChoiceCard
            selected={!inPlace}
            onSelect={() => setInPlace(false)}
            disabled={loading}
            icon={<Icon name="branch" size={15} />}
            title="Fork into a new session"
            description="Start a separate session and keep this one as it is."
          />
        </div>
        {!inPlace && (
          <div className="dlg-subpanel">
            <Switch
              checked={archivePrevious}
              onChange={setArchivePrevious}
              disabled={loading}
              label="Archive this session"
              description="Moves it out of the active list once the fork starts."
            />
          </div>
        )}
      </section>

      <section className="dlg-section">
        <span className="dlg-label" id={`${uid}-ctx`}>
          Context to hand over
        </span>
        <div className="dlg-choice-grid cols-3" role="radiogroup" aria-labelledby={`${uid}-ctx`} onKeyDown={onRadioGroupKeyDown}>
          {CONTEXT_OPTIONS.map((opt) => (
            <ChoiceCard
              key={opt.value}
              selected={contextMode === opt.value}
              onSelect={() => setContextMode(opt.value)}
              disabled={loading}
              title={opt.title}
              badge={opt.recommended ? <Badge tone="accent">Recommended</Badge> : undefined}
              description={opt.description}
            />
          ))}
        </div>
      </section>

      <section className="dlg-section">
        <Switch
          checked={sendInitialPrompt}
          onChange={setSendInitialPrompt}
          disabled={loading}
          label="Send a continuation prompt"
          description={`${targetName} starts working as soon as it takes over.`}
        />
        {sendInitialPrompt && (
          <Textarea
            aria-label="Continuation prompt"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            rows={3}
            disabled={loading}
            className="sw-prompt"
          />
        )}
      </section>

      <section className="sw-summary" aria-label="What carries over">
        <div className="dlg-eyebrow">What carries over</div>
        <dl className="sw-summary-list">
          <div className="sw-summary-row">
            <dt>
              <Icon name="folder" size={13} />
              Project
            </dt>
            <dd className="mono" title={currentSession.cwd}>
              {currentSession.cwd}
            </dd>
          </div>
          <div className="sw-summary-row">
            <dt>
              <Icon name="branch" size={13} />
              Branch
            </dt>
            <dd>
              {git?.branch ? (
                <>
                  <span className="mono">{git.branch}</span>
                  <span className="sw-summary-meta">
                    {git.uncommittedFiles
                      ? `${git.uncommittedFiles} uncommitted ${git.uncommittedFiles === 1 ? 'file' : 'files'}`
                      : 'clean'}
                  </span>
                </>
              ) : (
                <span className="sw-summary-muted">Not a git repository</span>
              )}
            </dd>
          </div>
          <div className="sw-summary-row">
            <dt>
              <Icon name="star" size={13} />
              Goal
            </dt>
            <dd className="sw-summary-goal">{goal ? goal : <span className="sw-summary-muted">No goal recorded yet</span>}</dd>
          </div>
          <div className="sw-summary-row">
            <dt>
              <Icon name="layers" size={13} />
              History
            </dt>
            <dd>{CONTEXT_LABEL[contextMode]}</dd>
          </div>
        </dl>
      </section>
    </Modal>
  );
};
