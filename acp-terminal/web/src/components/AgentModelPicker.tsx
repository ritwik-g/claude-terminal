import React, { useState, useRef, useEffect, useId } from 'react';
import { useEscapeLayer } from '../hooks';
import { api } from '../api';
import type { AgentDescriptor, VendorSubscriptionInfo } from '../types';
import { VendorIcon } from './VendorLogos';
import { Badge, Button, ChoiceCard, Icon, Input, type IconName } from '../ui';
import '../styles/dialogs.css';

export interface VendorMeta {
  badgeClass: 'claude' | 'codex' | 'gemini' | 'mock';
  provider: string;
  shortName: string;
  /** Plain-language agent name for pickers, without the "(ACP)" suffix. */
  displayName: string;
  /** One short line on what the agent is. */
  tagline: string;
  /** What account the agent bills to when we can't read the real plan. */
  accountHint: string;
  subscriptionKey?: 'anthropic' | 'openai' | 'google';
}

export function getVendorMeta(agentId: string): VendorMeta {
  const lower = agentId.toLowerCase();
  if (lower.includes('claude')) {
    return {
      badgeClass: 'claude',
      provider: 'Anthropic',
      shortName: 'Claude',
      displayName: 'Claude Code',
      tagline: "Anthropic's coding agent",
      accountHint: 'Claude Pro or Max plan',
      subscriptionKey: 'anthropic',
    };
  }
  if (lower.includes('codex')) {
    return {
      badgeClass: 'codex',
      provider: 'OpenAI',
      shortName: 'Codex',
      displayName: 'Codex',
      tagline: "OpenAI's coding agent",
      accountHint: 'ChatGPT Plus or Pro plan',
      subscriptionKey: 'openai',
    };
  }
  if (lower.includes('gemini') || lower.includes('antigravity')) {
    return {
      badgeClass: 'gemini',
      provider: 'Google',
      shortName: 'Antigravity',
      displayName: 'Antigravity',
      tagline: "Google's coding agent",
      accountHint: 'Google Antigravity account',
      subscriptionKey: 'google',
    };
  }
  return {
    badgeClass: 'mock',
    provider: 'Built-in',
    shortName: 'Demo',
    displayName: 'Demo agent',
    tagline: 'Built-in, for trying things out',
    accountHint: 'Runs offline, no account needed',
  };
}

/** The agent's name as shown in pickers ("Claude Code (ACP)" becomes "Claude Code"). */
export function agentDisplayName(agent: Pick<AgentDescriptor, 'id' | 'name'>): string {
  const meta = getVendorMeta(agent.id);
  if (meta.badgeClass !== 'mock' || agent.id === 'mock') return meta.displayName;
  return agent.name.replace(/\s*\(ACP\)\s*$/i, '');
}

export interface ModelMeta {
  label: string;
  /** Short sentence-case strength, e.g. "Fastest" or "Most capable". */
  badge: string;
  /** Icon name for the model (never an emoji). */
  icon: IconName;
  supportsEffort: boolean;
  provider: string;
  vendor: string;
  description: string;
}

export function getModelMeta(modelId: string): ModelMeta {
  const m = modelId.toLowerCase().trim();

  // --- Claude Code Models (from Claude Code CLI /model) ---
  if (m === 'sonnet' || m === 'sonnet-5' || m.includes('sonnet-5') || m.includes('sonnet 5')) {
    return {
      label: 'Claude Sonnet',
      badge: 'Flagship',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Anthropic recommended flagship model for Claude Code & agentic coding',
    };
  }
  if (m === 'opus' || m === 'opus-5.5' || m === 'opus-5' || m.includes('opus-5.5') || m.includes('opus 5.5')) {
    return {
      label: 'Claude Opus',
      badge: 'Most capable',
      icon: 'star',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Anthropic most capable model for deep reasoning, complex architecture, and math',
    };
  }
  if (m === 'haiku' || m === 'haiku-4.5' || m.includes('haiku-4.5') || m.includes('haiku 4.5')) {
    return {
      label: 'Claude Haiku',
      badge: 'Fastest',
      icon: 'gauge',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Fastest model for quick edits, scripts, and terminal tasks',
    };
  }
  if (m === 'claude-opus-4-6' || m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('opus 4.6')) {
    return {
      label: 'Claude Opus 4.6',
      badge: 'Frontier reasoning',
      icon: 'star',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Anthropic frontier model for complex architectural problems',
    };
  }
  if (m === 'claude-opus-4-5' || m.includes('opus-4-5') || m.includes('opus-4.5') || m.includes('opus 4.5')) {
    return {
      label: 'Claude Opus 4.5',
      badge: 'Deep reasoning',
      icon: 'star',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Capable reasoning and full codebase generation',
    };
  }
  if (m === 'claude-haiku-4-5') {
    return {
      label: 'Claude Haiku 4.5',
      badge: 'Fast and light',
      icon: 'gauge',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Fast lightweight model for rapid iterations and scripts',
    };
  }
  if (m === 'fable-5.1' || m === 'fable' || m.includes('fable-5.1') || m.includes('fable 5.1')) {
    return {
      label: 'Fable 5.1',
      badge: 'Hardest problems',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'For your toughest challenges and complex edge-cases',
    };
  }
  if (m === 'fable-5' || m.includes('fable 5')) {
    return {
      label: 'Fable 5',
      badge: 'Long-running',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Most capable for your hardest and longest-running tasks',
    };
  }
  if (m === 'opus-4.8' || m.includes('opus 4.8')) {
    return {
      label: 'Opus 4.8',
      badge: 'Complex tasks',
      icon: 'star',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Best for everyday, complex tasks',
    };
  }
  if (m === 'opus-4.7' || m.includes('opus 4.7')) {
    return {
      label: 'Opus 4.7',
      badge: 'Complex tasks',
      icon: 'star',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Best for everyday, complex tasks',
    };
  }
  if (m.includes('3-7-sonnet') || m.includes('3.7-sonnet') || (m.includes('claude') && (m.includes('3.7') || m.includes('3-7')))) {
    return {
      label: 'Claude Sonnet',
      badge: 'Hybrid reasoning',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Frontier hybrid coding & reasoning with adjustable thinking effort',
    };
  }
  if (m.includes('3-5-sonnet') || m.includes('3.5-sonnet')) {
    return {
      label: 'Claude 3.5 Sonnet',
      badge: 'Flagship coding',
      icon: 'zap',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Industry standard for software engineering & refactoring',
    };
  }
  if (m.includes('3-5-haiku') || m.includes('3.5-haiku')) {
    return {
      label: 'Claude 3.5 Haiku',
      badge: 'Lightweight',
      icon: 'gauge',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Rapid responses for quick edits and terminal tasks',
    };
  }

  // --- OpenAI / ChatGPT Models (from ChatGPT Subscription) ---
  if (m === '6-luna' || m === '6 luna' || m === '6') {
    return {
      label: '6 Luna',
      badge: 'Flagship',
      icon: 'zap',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Recommended set of models from ChatGPT subscription',
    };
  }
  if (m === '5.6-terra' || m === '5.6 terra' || m.includes('terra')) {
    return {
      label: '5.6 Terra',
      badge: 'High intelligence',
      icon: 'star',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Deep reasoning, math, and comprehensive world knowledge',
    };
  }
  if (m === '5.6-luna' || m === '5.6 luna') {
    return {
      label: '5.6 Luna',
      badge: 'Fast',
      icon: 'zap',
      supportsEffort: false,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Fast, intelligent multimodal reasoning model',
    };
  }
  if (m === '5.5' || m === '5-5') {
    return {
      label: '5.5',
      badge: 'Standard',
      icon: 'cpu',
      supportsEffort: false,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Balanced everyday coding, reasoning, and synthesis',
    };
  }
  if (m === 'gpt-4o') {
    return {
      label: 'GPT-4o',
      badge: 'Multimodal',
      icon: 'sparkles',
      supportsEffort: false,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Versatile multimodal flagship model for code and text',
    };
  }
  if (m.includes('o3')) {
    return {
      label: 'o3-mini',
      badge: 'High reasoning',
      icon: 'star',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Cost-efficient deep STEM reasoning with selectable effort',
    };
  }
  if (m === 'o1') {
    return {
      label: 'o1',
      badge: 'Deep reasoning',
      icon: 'star',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'High-depth reasoning model for complex architectural problems',
    };
  }

  // --- Google Antigravity Models (from Google Antigravity IDE) ---
  if (m.includes('3.8-flash') || m.includes('3.8 flash')) {
    return {
      label: 'Gemini 3.8 Flash',
      badge: 'Fast',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'High-speed flagship with adaptive reasoning and large context',
    };
  }
  if (m.includes('3.7-flash') || m.includes('3.7 flash')) {
    return {
      label: 'Gemini 3.7 Flash',
      badge: 'Balanced',
      icon: 'sparkles',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'Balanced speed and multi-step reasoning for everyday coding',
    };
  }
  if (m.includes('3.6-flash') || m.includes('3.6 flash')) {
    return {
      label: 'Gemini 3.6 Flash',
      badge: 'Low latency',
      icon: 'gauge',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'Low-latency coding assistant with high throughput',
    };
  }
  if (m.includes('3.1-pro') || m.includes('3.1 pro')) {
    return {
      label: 'Gemini 3.1 Pro',
      badge: 'Large context',
      icon: 'star',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'Massive context window for full-repo architectural planning',
    };
  }
  if (m.includes('sonnet-4.6') || m.includes('sonnet 4.6')) {
    return {
      label: 'Claude Sonnet 4.6 (Thinking)',
      badge: 'Thinking',
      icon: 'zap',
      supportsEffort: true,
      provider: 'Google Antigravity',
      vendor: 'antigravity',
      description: 'Antigravity-integrated Claude Sonnet with extended thinking',
    };
  }
  if (m.includes('opus-4.6') || m.includes('opus 4.6')) {
    return {
      label: 'Claude Opus 4.6 (Thinking)',
      badge: 'Thinking',
      icon: 'star',
      supportsEffort: true,
      provider: 'Google Antigravity',
      vendor: 'antigravity',
      description: 'Antigravity-integrated Claude Opus with deep thinking',
    };
  }
  if (m.includes('gpt-oss') || m.includes('120b')) {
    return {
      label: 'GPT-OSS 120B (Medium)',
      badge: 'Open weights',
      icon: 'globe',
      supportsEffort: true,
      provider: 'Google Antigravity',
      vendor: 'antigravity',
      description: 'Open-weights frontier model hosted in Antigravity',
    };
  }

  // Dynamic fallback for custom or unlisted models
  let inferredVendor = 'mock';
  let inferredProvider = 'Custom';
  if (m.includes('claude') || m.includes('anthropic') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku') || m.includes('fable')) {
    inferredVendor = 'claude';
    inferredProvider = 'Anthropic';
  } else if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('codex') || m.includes('openai') || m.includes('luna') || m.includes('terra')) {
    inferredVendor = 'codex';
    inferredProvider = 'OpenAI';
  } else if (m.includes('gemini') || m.includes('google') || m.includes('antigravity')) {
    inferredVendor = 'antigravity';
    inferredProvider = 'Google';
  }

  const supportsEffort = m.includes('o1') || m.includes('o3') || m.includes('3-7') || m.includes('3.7') || m.includes('think') || m.includes('opus') || m.includes('fable') || m.includes('sonnet') || m.includes('luna') || m.includes('terra') || m.includes('3.8') || m.includes('3.7');

  return {
    label: modelId,
    badge: 'Custom',
    icon: inferredVendor === 'claude' ? 'zap' : inferredVendor === 'antigravity' ? 'sparkles' : 'cpu',
    supportsEffort,
    provider: inferredProvider,
    vendor: inferredVendor,
    description: `Subscription/API model: ${modelId}`,
  };
}

// The plan each vendor's CLI is signed in with, fetched once per page load.
let subscriptionsPromise: Promise<Partial<Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo>>> | null = null;

function loadSubscriptions() {
  if (!subscriptionsPromise) {
    subscriptionsPromise = api
      .getSubscriptions()
      .then((res) => res.subscriptions || {})
      .catch(() => {
        subscriptionsPromise = null;
        return {};
      });
  }
  return subscriptionsPromise;
}

function useSubscriptions() {
  const [subs, setSubs] = useState<Partial<Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo>>>({});
  useEffect(() => {
    let alive = true;
    loadSubscriptions().then((s) => alive && setSubs(s));
    return () => {
      alive = false;
    };
  }, []);
  return subs;
}

function accountLine(agentId: string, subs: Partial<Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo>>) {
  const meta = getVendorMeta(agentId);
  const sub = meta.subscriptionKey ? subs[meta.subscriptionKey] : undefined;
  if (!sub) return { text: meta.accountHint, tone: 'neutral' as const };
  if (sub.status === 'unconfigured') return { text: 'Not signed in', tone: 'warn' as const };
  if (sub.status === 'expired') return { text: 'Sign-in expired', tone: 'warn' as const };
  const plan = (sub.planName || meta.accountHint).replace(/\s+subscription$/i, '');
  return { text: sub.authMode === 'api_key' ? 'API key' : plan, tone: 'ok' as const };
}

interface AgentModelPickerProps {
  agents: AgentDescriptor[];
  selectedAgentId: string;
  selectedModel: string;
  onAgentChange: (agentId: string) => void;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  /** Label above the agent choices. */
  agentLabel?: string;
  /** Label above the model picker. */
  modelLabel?: string;
}

/** Moves focus and selection between radios with the arrow keys. */
function onRadioGroupKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
  if (!keys.includes(e.key)) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  const idx = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (idx === -1) return;
  e.preventDefault();
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
  const next = radios[(idx + step + radios.length) % radios.length];
  next.focus();
  next.click();
}

export { onRadioGroupKeyDown };

export const AgentModelPicker: React.FC<AgentModelPickerProps> = ({
  agents,
  selectedAgentId,
  selectedModel,
  onAgentChange,
  onModelChange,
  disabled = false,
  agentLabel = 'Agent',
  modelLabel = 'Model',
}) => {
  const [modelOpen, setModelOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const subs = useSubscriptions();
  const uid = useId();

  const modelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const closeMenu = (refocus = true) => {
    setModelOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Esc closes the open menu without also closing the dialog around it.
  useEscapeLayer(modelOpen, () => closeMenu());

  // Close the menu on an outside click.
  useEffect(() => {
    if (!modelOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modelOpen]);

  // Opening the menu moves focus to the selected model, as a native select does.
  useEffect(() => {
    if (!modelOpen || !listRef.current) return;
    const selected = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    const first = listRef.current.querySelector<HTMLElement>('[role="option"]');
    (selected || first)?.focus({ preventScroll: true });
    (selected || first)?.scrollIntoView({ block: 'nearest' });
    // Bring the whole menu into view inside the dialog's scrolling body.
    listRef.current.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [modelOpen]);

  const currentAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const availableModels = currentAgent?.availableModels || (currentAgent?.defaultModel ? [currentAgent.defaultModel] : []);
  const isCustomModel = !!selectedModel && !availableModels.includes(selectedModel);
  const models = isCustomModel ? [...availableModels, selectedModel] : availableModels;

  const currentModelMeta = selectedModel ? getModelMeta(selectedModel) : null;
  const isDefaultModel = !!selectedModel && selectedModel === currentAgent?.defaultModel;

  const handleSelectAgent = (agent: AgentDescriptor) => {
    if (agent.id === selectedAgentId) return;
    onAgentChange(agent.id);
    const defaultM = agent.defaultModel || (agent.availableModels && agent.availableModels[0]) || '';
    onModelChange(defaultM);
    setModelOpen(false);
  };

  const handleSelectModel = (model: string) => {
    onModelChange(model);
    closeMenu();
  };

  const submitCustom = () => {
    const value = customInput.trim();
    if (!value) return;
    handleSelectModel(value);
    setCustomInput('');
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') || []);
    const idx = options.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(options.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = idx <= 0 ? 0 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else if (e.key === 'Tab') setModelOpen(false);
    if (next >= 0) {
      e.preventDefault();
      options[next]?.focus();
    }
  };

  const agentGroupId = `${uid}-agent`;
  const modelLabelId = `${uid}-model`;

  return (
    <div className="amp">
      <div className="amp-section">
        <div className="dlg-label-row">
          <span className="dlg-label" id={agentGroupId}>
            {agentLabel}
          </span>
        </div>
        {agents.length === 0 ? (
          <div className="dlg-callout tone-warn" role="status">
            <Icon name="alert" size={15} />
            <span>No other agents are available. Check the agents configured on the server.</span>
          </div>
        ) : (
          <div
            className={`amp-agents${agents.length % 2 === 1 ? ' is-odd' : ''}`}
            role="radiogroup"
            aria-labelledby={agentGroupId}
            onKeyDown={onRadioGroupKeyDown}
          >
            {agents.map((agent) => {
              const meta = getVendorMeta(agent.id);
              const account = accountLine(agent.id, subs);
              return (
                <ChoiceCard
                  key={agent.id}
                  selected={agent.id === currentAgent?.id}
                  onSelect={() => handleSelectAgent(agent)}
                  disabled={disabled}
                  icon={<VendorIcon agentId={agent.id} size={18} />}
                  title={agentDisplayName(agent)}
                  description={
                    <>
                      <span className="amp-agent-tagline">{agent.id === 'mock' || meta.badgeClass !== 'mock' ? meta.tagline : agent.description}</span>
                      <span className={`amp-agent-account tone-${account.tone}`}>
                        <Icon name={account.tone === 'warn' ? 'alert' : 'key'} size={11} />
                        {account.text}
                      </span>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="amp-section amp-model" ref={modelRef}>
        <div className="dlg-label-row">
          <span className="dlg-label" id={modelLabelId}>
            {modelLabel}
          </span>
          {currentAgent && (
            <span className="dlg-aside">
              {availableModels.length} {availableModels.length === 1 ? 'model' : 'models'} for {getVendorMeta(currentAgent.id).shortName}
            </span>
          )}
        </div>

        <button
          ref={triggerRef}
          type="button"
          className={`amp-trigger${modelOpen ? ' is-open' : ''}`}
          onClick={() => !disabled && setModelOpen((prev) => !prev)}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !modelOpen && !disabled) {
              e.preventDefault();
              setModelOpen(true);
            }
          }}
          disabled={disabled || !currentAgent}
          aria-haspopup="listbox"
          aria-expanded={modelOpen}
          aria-labelledby={`${modelLabelId} ${uid}-trigger-value`}
        >
          <span className="amp-model-icon">
            <Icon name={currentModelMeta?.icon || 'cpu'} size={15} />
          </span>
          <span className="amp-trigger-text" id={`${uid}-trigger-value`}>
            <span className="amp-trigger-label">{currentModelMeta?.label || selectedModel || 'Choose a model'}</span>
            {selectedModel && <span className="amp-trigger-id">{selectedModel}</span>}
          </span>
          {isDefaultModel && <Badge tone="accent">Recommended</Badge>}
          {currentModelMeta && !isDefaultModel && <Badge>{currentModelMeta.badge}</Badge>}
          <Icon name="chevronDown" size={15} className="amp-trigger-chevron" />
        </button>

        {modelOpen && (
          <div className="amp-menu">
            <div
              className="amp-menu-list"
              role="listbox"
              aria-labelledby={modelLabelId}
              ref={listRef}
              onKeyDown={onListKeyDown}
            >
              {models.map((model) => {
                const meta = getModelMeta(model);
                const isSelected = model === selectedModel;
                const isDefault = model === currentAgent?.defaultModel;
                return (
                  <button
                    key={model}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`amp-option${isSelected ? ' is-selected' : ''}`}
                    onClick={() => handleSelectModel(model)}
                    title={meta.description}
                  >
                    <span className="amp-model-icon">
                      <Icon name={meta.icon} size={15} />
                    </span>
                    <span className="amp-option-text">
                      <span className="amp-option-title">
                        {meta.label}
                        {isDefault && <Badge tone="accent">Recommended</Badge>}
                        {!isDefault && meta.badge !== 'Custom' && <Badge>{meta.badge}</Badge>}
                      </span>
                      <span className="amp-option-desc">
                        <code>{model}</code>
                        <span className="amp-option-sep" aria-hidden>
                          ·
                        </span>
                        <span>{meta.description}</span>
                      </span>
                    </span>
                    <span className="amp-option-check" aria-hidden>
                      {isSelected && <Icon name="check" size={14} />}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="amp-custom">
              <label className="dlg-eyebrow" htmlFor={`${uid}-custom`}>
                Other model
              </label>
              <div className="amp-custom-row">
                <Input
                  id={`${uid}-custom`}
                  mono
                  placeholder="Model id, e.g. opus"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitCustom();
                    }
                  }}
                />
                <Button size="sm" disabled={!customInput.trim()} onClick={submitCustom}>
                  Use
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
