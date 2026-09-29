import React, { useState, useRef, useEffect } from 'react';
import type { AgentDescriptor } from '../types';
import { VendorIcon } from './VendorLogos';

export function getVendorMeta(agentId: string) {
  const lower = agentId.toLowerCase();
  if (lower.includes('claude')) {
    return {
      icon: '🟧',
      color: '#f97316',
      badgeClass: 'claude',
      provider: 'Anthropic',
      shortName: 'Claude',
    };
  }
  if (lower.includes('codex')) {
    return {
      icon: '🟩',
      color: '#10b981',
      badgeClass: 'codex',
      provider: 'OpenAI',
      shortName: 'Codex',
    };
  }
  if (lower.includes('gemini') || lower.includes('antigravity')) {
    return {
      icon: '🔷',
      color: '#38bdf8',
      badgeClass: 'gemini',
      provider: 'Google',
      shortName: 'Antigravity',
    };
  }
  return {
    icon: '🟣',
    color: '#a855f7',
    badgeClass: 'mock',
    provider: 'Built-in',
    shortName: 'Demo',
  };
}

export function getModelMeta(modelId: string) {
  const m = modelId.toLowerCase().trim();

  // --- Claude Code Models (from Claude Code CLI /model) ---
  if (m === 'sonnet' || m === 'sonnet-5' || m.includes('sonnet-5') || m.includes('sonnet 5')) {
    return {
      label: 'Claude Sonnet',
      badge: 'Recommended · Flagship',
      icon: '⚡',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Anthropic recommended flagship model for Claude Code & agentic coding',
    };
  }
  if (m === 'opus' || m === 'opus-5.5' || m === 'opus-5' || m.includes('opus-5.5') || m.includes('opus 5.5')) {
    return {
      label: 'Claude Opus',
      badge: 'Most Capable',
      icon: '🧠',
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
      icon: '🚀',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Fastest model for quick edits, scripts, and terminal tasks',
    };
  }
  if (m === 'claude-opus-4-6' || m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('opus 4.6')) {
    return {
      label: 'Claude Opus 4.6',
      badge: 'Frontier Reasoning',
      icon: '🧠',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Anthropic frontier model for complex architectural problems',
    };
  }
  if (m === 'claude-opus-4-5' || m.includes('opus-4-5') || m.includes('opus-4.5') || m.includes('opus 4.5')) {
    return {
      label: 'Claude Opus 4.5',
      badge: 'Deep Reasoning',
      icon: '🧠',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Capable reasoning and full codebase generation',
    };
  }
  if (m === 'claude-haiku-4-5') {
    return {
      label: 'Claude Haiku 4.5',
      badge: 'Fast Lightweight',
      icon: '🚀',
      supportsEffort: false,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Fast lightweight model for rapid iterations and scripts',
    };
  }
  if (m === 'fable-5.1' || m === 'fable' || m.includes('fable-5.1') || m.includes('fable 5.1')) {
    return {
      label: 'Fable 5.1',
      badge: 'Toughest Challenges',
      icon: '⚡',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'For your toughest challenges and complex edge-cases',
    };
  }
  if (m === 'fable-5' || m.includes('fable 5')) {
    return {
      label: 'Fable 5',
      badge: 'Longest-Running',
      icon: '⚡',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Most capable for your hardest and longest-running tasks',
    };
  }
  if (m === 'opus-4.8' || m.includes('opus 4.8')) {
    return {
      label: 'Opus 4.8',
      badge: 'Complex Tasks',
      icon: '🧠',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Best for everyday, complex tasks',
    };
  }
  if (m === 'opus-4.7' || m.includes('opus 4.7')) {
    return {
      label: 'Opus 4.7',
      badge: 'Complex Tasks',
      icon: '🧠',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Best for everyday, complex tasks',
    };
  }
  if (m.includes('3-7-sonnet') || m.includes('3.7-sonnet') || (m.includes('claude') && (m.includes('3.7') || m.includes('3-7')))) {
    return {
      label: 'Claude Sonnet',
      badge: 'Hybrid Reasoning',
      icon: '⚡',
      supportsEffort: true,
      provider: 'Anthropic',
      vendor: 'claude',
      description: 'Frontier hybrid coding & reasoning with adjustable thinking effort',
    };
  }
  if (m.includes('3-5-sonnet') || m.includes('3.5-sonnet')) {
    return {
      label: 'Claude 3.5 Sonnet',
      badge: 'Flagship Coding',
      icon: '⚡',
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
      icon: '🚀',
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
      badge: 'Flagship / Default',
      icon: '⚡',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Recommended set of models from ChatGPT subscription',
    };
  }
  if (m === '5.6-terra' || m === '5.6 terra' || m.includes('terra')) {
    return {
      label: '5.6 Terra',
      badge: 'High Intelligence',
      icon: '🧠',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Deep reasoning, math, and comprehensive world knowledge',
    };
  }
  if (m === '5.6-luna' || m === '5.6 luna') {
    return {
      label: '5.6 Luna',
      badge: 'Fast Omni',
      icon: '⚡',
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
      icon: '⚙️',
      supportsEffort: false,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Balanced everyday coding, reasoning, and synthesis',
    };
  }
  if (m === 'gpt-4o') {
    return {
      label: 'GPT-4o',
      badge: 'Omni Flagship',
      icon: '✨',
      supportsEffort: false,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Versatile multimodal flagship model for code and text',
    };
  }
  if (m.includes('o3')) {
    return {
      label: 'o3-mini',
      badge: 'High Reasoning',
      icon: '🔬',
      supportsEffort: true,
      provider: 'OpenAI',
      vendor: 'codex',
      description: 'Cost-efficient deep STEM reasoning with selectable effort',
    };
  }
  if (m === 'o1') {
    return {
      label: 'o1',
      badge: 'Deep Reasoning',
      icon: '🧠',
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
      badge: 'High Fast',
      icon: '⚡',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'High-speed flagship with adaptive reasoning and large context',
    };
  }
  if (m.includes('3.7-flash') || m.includes('3.7 flash')) {
    return {
      label: 'Gemini 3.7 Flash',
      badge: 'Medium',
      icon: '✨',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'Balanced speed and multi-step reasoning for everyday coding',
    };
  }
  if (m.includes('3.6-flash') || m.includes('3.6 flash')) {
    return {
      label: 'Gemini 3.6 Flash',
      badge: 'Medium Fast',
      icon: '🚀',
      supportsEffort: true,
      provider: 'Google',
      vendor: 'antigravity',
      description: 'Low-latency coding assistant with high throughput',
    };
  }
  if (m.includes('3.1-pro') || m.includes('3.1 pro')) {
    return {
      label: 'Gemini 3.1 Pro',
      badge: 'Low Effort',
      icon: '🧠',
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
      icon: '⚡',
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
      icon: '🧠',
      supportsEffort: true,
      provider: 'Google Antigravity',
      vendor: 'antigravity',
      description: 'Antigravity-integrated Claude Opus with deep thinking',
    };
  }
  if (m.includes('gpt-oss') || m.includes('120b')) {
    return {
      label: 'GPT-OSS 120B (Medium)',
      badge: 'Medium',
      icon: '🌐',
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
    icon: inferredVendor === 'claude' ? '⚡' : inferredVendor === 'codex' ? '🟩' : inferredVendor === 'antigravity' ? '🔷' : '⚙️',
    supportsEffort,
    provider: inferredProvider,
    vendor: inferredVendor,
    description: `Subscription/API model: ${modelId}`,
  };
}

interface AgentModelPickerProps {
  agents: AgentDescriptor[];
  selectedAgentId: string;
  selectedModel: string;
  onAgentChange: (agentId: string) => void;
  onModelChange: (model: string) => void;
  disabled?: boolean;
}

export const AgentModelPicker: React.FC<AgentModelPickerProps> = ({
  agents,
  selectedAgentId,
  selectedModel,
  onAgentChange,
  onModelChange,
  disabled = false,
}) => {
  const [vendorOpen, setVendorOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');

  const vendorRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (vendorRef.current && !vendorRef.current.contains(e.target as Node)) {
        setVendorOpen(false);
      }
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const availableModels = currentAgent?.availableModels || (currentAgent?.defaultModel ? [currentAgent.defaultModel] : []);

  const vendorMeta = currentAgent ? getVendorMeta(currentAgent.id) : null;
  const currentModelMeta = selectedModel ? getModelMeta(selectedModel) : null;

  const handleSelectAgent = (agent: AgentDescriptor) => {
    onAgentChange(agent.id);
    const defaultM = agent.defaultModel || (agent.availableModels && agent.availableModels[0]) || '';
    onModelChange(defaultM);
    setVendorOpen(false);
  };

  const handleSelectModel = (model: string) => {
    onModelChange(model);
    setModelOpen(false);
  };

  return (
    <div className="picker-container">
      {/* 1. Vendor Selection */}
      <div className="form-group" ref={vendorRef} style={{ position: 'relative' }}>
        <label className="form-label">Coding Agent / Vendor</label>
        <button
          type="button"
          className="picker-trigger-btn"
          onClick={() => !disabled && setVendorOpen((prev) => !prev)}
          disabled={disabled}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <VendorIcon agentId={currentAgent?.id || selectedAgentId} size={20} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '13px' }}>
                {currentAgent?.name || 'Select Agent'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {vendorMeta?.provider} Engine
              </div>
            </div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{vendorOpen ? '▲' : '▼'}</span>
        </button>

        {vendorOpen && (
          <div className="picker-dropdown-menu">
            {agents.map((agent) => {
              const isSelected = agent.id === selectedAgentId;
              return (
                <div
                  key={agent.id}
                  className={`picker-dropdown-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelectAgent(agent)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <VendorIcon agentId={agent.id} size={22} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '13px' }}>
                        {agent.name}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '1px' }}>
                        {agent.description}
                      </div>
                    </div>
                  </div>
                  {isSelected && <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>✓</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Model Selection */}
      <div className="form-group" ref={modelRef} style={{ position: 'relative', marginTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label className="form-label">Model Selection</label>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            Configured for {vendorMeta?.shortName}
          </span>
        </div>

        <button
          type="button"
          className="picker-trigger-btn"
          onClick={() => !disabled && setModelOpen((prev) => !prev)}
          disabled={disabled || availableModels.length === 0}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>{currentModelMeta?.icon || '⚙️'}</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '13px' }}>
                {currentModelMeta?.label || selectedModel || 'Select Model'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {currentModelMeta?.badge}
              </div>
            </div>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{modelOpen ? '▲' : '▼'}</span>
        </button>

        {modelOpen && (
          <div className="picker-dropdown-menu">
            {availableModels.map((model) => {
              const meta = getModelMeta(model);
              const isSelected = model === selectedModel;
              const isDefault = model === currentAgent?.defaultModel;

              return (
                <div
                  key={model}
                  className={`picker-dropdown-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelectModel(model)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '16px' }}>{meta.icon}</span>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '13px' }}>
                          {meta.label}
                        </span>
                        {isDefault && (
                          <span className="badge-recommended">
                            Recommended
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
                        <code>{model}</code> • {meta.badge}
                      </div>
                    </div>
                  </div>
                  {isSelected && <span style={{ color: '#38bdf8', fontWeight: 'bold' }}>✓</span>}
                </div>
              );
            })}

            {/* Custom Model Inline Entry */}
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                CUSTOM MODEL ID
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="e.g. sonnet, opus, 6-luna, custom-id"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customInput.trim()) {
                      handleSelectModel(customInput.trim());
                      setCustomInput('');
                    }
                  }}
                  style={{
                    flex: 1,
                    background: '#0d0f14',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '5px',
                    color: 'var(--text-main)',
                    fontSize: '12px',
                    padding: '5px 8px',
                  }}
                />
                <button
                  type="button"
                  className="btn-action"
                  disabled={!customInput.trim()}
                  onClick={() => {
                    if (customInput.trim()) {
                      handleSelectModel(customInput.trim());
                      setCustomInput('');
                    }
                  }}
                  style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 600 }}
                >
                  Use
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
