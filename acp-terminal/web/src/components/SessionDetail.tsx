import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { AcpSession, AgentDescriptor, FileAttachment, TurnMessage, SlashCommandItem } from '../types';
import { api, withToken } from '../api';
import { useEscapeLayer } from '../hooks';
import { LiveTerminalPanel } from './LiveTerminalPanel';
import { AgentTurnBody } from './AgentTurn';
import { ActivityStrip } from './ActivityStrip';
import { commandOf, isShellCall } from '../toolDisplay';
import { MarkdownContent } from './MarkdownContent';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { getSlashCommandsForAgent, filterSlashCommands } from '../slashCommands';

export function nextPriority(current: 'p0' | 'p1' | 'p2' | null | undefined): 'p0' | 'p1' | 'p2' | null {
  const cycle: Record<string, 'p0' | 'p1' | 'p2' | null> = { null: 'p0', p0: 'p1', p1: 'p2', p2: null };
  return cycle[String(current ?? null)];
}

interface SessionDetailProps {
  session: AcpSession;
  agents: AgentDescriptor[];
  onRefresh: () => void;
  onOpenSwitchModal: () => void;
  onOpenSubscriptionsModal?: () => void;
  onBackToList?: () => void;
  onDeleted?: (id: string) => void;
  totalSessionsCount?: number;
}

export const SessionDetail: React.FC<SessionDetailProps> = ({
  session,
  agents,
  onRefresh,
  onOpenSwitchModal,
  onOpenSubscriptionsModal,
  onBackToList,
  onDeleted,
  totalSessionsCount,
}) => {
  const [activeTab, setActiveTab] = useState<'conversation' | 'terminal' | 'usage'>('conversation');
  const [showMobileActions, setShowMobileActions] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [switchingEngine, setSwitchingEngine] = useState(false);
  const [contextTransferMode, setContextTransferMode] = useState<'compact' | 'full' | 'none'>('compact');
  const [autoContinueOnSwitch, setAutoContinueOnSwitch] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [editableTitle, setEditableTitle] = useState(session.title);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  useEscapeLayer(Boolean(previewImage), () => setPreviewImage(null));
  useEscapeLayer(showMobileActions, () => setShowMobileActions(false));
  useEscapeLayer(showModelPicker, () => setShowModelPicker(false));
  const chatEndRef = useRef<HTMLDivElement>(null);
  const shellCommandCount = session.turns.reduce(
    (n, t) => n + (t.toolCalls || []).filter((c) => isShellCall(c) && Boolean(commandOf(c))).length,
    0
  );
  // Follow new output only while the reader is at the bottom; scrolling up to
  // read earlier turns must not be yanked back on every streamed chunk.
  const stickToBottomRef = useRef(true);
  const composerPickerRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilterCategory, setSlashFilterCategory] = useState<'all' | 'agent' | 'terminal'>('all');
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);

  const availableSlashCommands = useMemo(() => {
    return getSlashCommandsForAgent(session.agentId);
  }, [session.agentId]);

  const slashQuery = useMemo(() => {
    if (!promptText.startsWith('/')) return '';
    const match = promptText.match(/^\/(\S*)/);
    return match ? match[1] : '';
  }, [promptText]);

  const filteredSlashCommands = useMemo(() => {
    let list = filterSlashCommands(availableSlashCommands, slashQuery);
    if (slashFilterCategory !== 'all') {
      list = list.filter((c) => c.category === slashFilterCategory);
    }
    return list;
  }, [availableSlashCommands, slashQuery, slashFilterCategory]);

  useEffect(() => {
    if (selectedSlashIndex >= filteredSlashCommands.length) {
      setSelectedSlashIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, selectedSlashIndex]);

  useEffect(() => {
    if (promptText.startsWith('/') && !promptText.includes('\n')) {
      setShowSlashMenu(true);
    } else if (!promptText.startsWith('/') && showSlashMenu) {
      setShowSlashMenu(false);
    }
  }, [promptText]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(e.target as Node) &&
        promptInputRef.current &&
        !promptInputRef.current.contains(e.target as Node)
      ) {
        setShowSlashMenu(false);
      }
    };
    if (showSlashMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSlashMenu]);

  useEffect(() => {
    setPromptText('');
    setAttachments([]);
    setShowSlashMenu(false);
    setSelectedSlashIndex(0);
    setEditableTitle(session.title);
  }, [session.id]);

  const processFiles = (files: File[]) => {
    if (!files || files.length === 0) return;
    for (const file of files) {
      const isImg = file.type.startsWith('image/');
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((prev) => [
          ...prev,
          {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name || (isImg ? `screenshot-${Date.now()}.png` : `file-${Date.now()}`),
            size: file.size,
            mimeType: file.type || (isImg ? 'image/png' : 'application/octet-stream'),
            data: dataUrl,
            isImage: isImg,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const filesToProcess: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) filesToProcess.push(file);
      }
    }
    if (filesToProcess.length > 0) {
      processFiles(filesToProcess);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleRemoveAttachment = (attId: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== attId));
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const insideComposer = composerPickerRef.current && composerPickerRef.current.contains(target);
      if (!insideComposer) {
        setShowModelPicker(false);
      }
    };
    if (showModelPicker) {
      document.addEventListener('mousedown', handleOutsideClick);
      document.addEventListener('touchstart', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [showModelPicker]);

  useEffect(() => {
    setEditableTitle(session.title);
  }, [session.title]);

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [session.id, activeTab]);

  useEffect(() => {
    if (activeTab === 'conversation') {
      // Instant, not smooth: a smooth scroll emits intermediate scroll events that
      // would read as "user scrolled up" and unstick the view.
      if (stickToBottomRef.current) chatEndRef.current?.scrollIntoView({ block: 'end' });
    } else if (activeTab === 'usage') {
      const el = document.querySelector('.session-usage-tab-content');
      if (el) el.scrollTop = 0;
    }
  }, [session.turns, activeTab]);

  const handleCompactSession = async () => {
    if (compacting || session.turns.length <= 1) return;
    if (!confirm('Compact conversation history? This summarizes prior turns and tool outputs into a lean checkpoint, freeing up context.')) {
      return;
    }
    setCompacting(true);
    try {
      await api.compactSession(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to compact session: ${err.message}`);
    } finally {
      setCompacting(false);
    }
  };

  const handleSelectSlashCommand = async (cmd: SlashCommandItem) => {
    setShowSlashMenu(false);

    if (cmd.command === '/compact') {
      setPromptText('');
      await handleCompactSession();
      return;
    }
    if (cmd.command === '/undo') {
      setPromptText('');
      await handleRollback(undefined, 'undo_last');
      return;
    }
    if (cmd.command === '/stop') {
      setPromptText('');
      await handleStopAgent();
      return;
    }
    if (cmd.command === '/auto' || cmd.command === '/approval') {
      setPromptText('');
      await handleToggleAutoApprove();
      return;
    }
    if (cmd.command === '/switch') {
      setPromptText('');
      onOpenSwitchModal();
      return;
    }
    if (cmd.command === '/model') {
      setPromptText('');
      setShowModelPicker(true);
      return;
    }
    if (cmd.command === '/stats') {
      if (onOpenSubscriptionsModal) {
        setPromptText('');
        onOpenSubscriptionsModal();
        return;
      }
    }

    const textToInsert = cmd.command + ' ';
    setPromptText(textToInsert);
    setTimeout(() => {
      promptInputRef.current?.focus();
      promptInputRef.current?.setSelectionRange(textToInsert.length, textToInsert.length);
    }, 50);
  };

  const handleSendPrompt = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setShowSlashMenu(false);
    const text = promptText.trim();
    if ((!text && attachments.length === 0) || sending) return;

    if (text === '/compact') {
      setPromptText('');
      await handleCompactSession();
      return;
    }
    if (text === '/undo') {
      setPromptText('');
      await handleRollback(undefined, 'undo_last');
      return;
    }
    if (text === '/stop') {
      setPromptText('');
      await handleStopAgent();
      return;
    }
    if (text === '/auto' || text === '/approval') {
      setPromptText('');
      await handleToggleAutoApprove();
      return;
    }
    if (text === '/switch') {
      setPromptText('');
      onOpenSwitchModal();
      return;
    }
    if (text === '/model') {
      setPromptText('');
      setShowModelPicker(true);
      return;
    }
    if (text === '/stats') {
      if (onOpenSubscriptionsModal) {
        setPromptText('');
        onOpenSubscriptionsModal();
        return;
      }
    }

    if (
      session.state === 'working' &&
      !confirm('The agent is still working on the current turn. Stop it and send this message instead?')
    ) {
      return;
    }

    const outgoingAttachments = [...attachments];
    setPromptText('');
    setAttachments([]);
    setSending(true);

    try {
      if (session.state === 'working') {
        // If agent was active or stuck, cancel the active turn first to ensure clean state
        try {
          await api.cancelPrompt(session.id);
        } catch {}
      }
      await api.sendPrompt(session.id, text, outgoingAttachments.length > 0 ? outgoingAttachments : undefined);
    } catch (err: any) {
      alert(`Error sending prompt: ${err.message}`);
      setAttachments(outgoingAttachments);
    } finally {
      setSending(false);
      onRefresh();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If slash command suggestions are shown, handle arrow navigation, tab/enter selection, and escape
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSlashIndex((prev) => (prev + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSlashIndex((prev) => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredSlashCommands[selectedSlashIndex];
        if (selected) {
          handleSelectSlashCommand(selected);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }

    if (e.key === 'Tab' && !promptText && session.promptSuggestion) {
      e.preventDefault();
      setPromptText(session.promptSuggestion);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendPrompt();
    }
  };

  const handleCancelPrompt = async () => {
    try {
      await api.cancelPrompt(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error cancelling prompt: ${err.message}`);
    }
  };

  const handleStopAgent = async () => {
    try {
      await api.stopSessionAgent(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error stopping agent: ${err.message}`);
    }
  };

  const handleStartAgent = async () => {
    try {
      await api.startSessionAgent(session.id);
      onRefresh();
    } catch (err: any) {
      alert(`Error starting agent: ${err.message}`);
    }
  };

  const handleResolvePermission = async (optionId: string) => {
    try {
      await api.resolvePermission(session.id, optionId);
      onRefresh();
    } catch (err: any) {
      alert(`Error resolving permission: ${err.message}`);
    }
  };

  const updateAnnotations = async (patch: Parameters<typeof api.updateAnnotations>[1]) => {
    try {
      await api.updateAnnotations(session.id, patch);
      onRefresh();
    } catch (err: any) {
      alert(`Could not update session: ${err.message}`);
    }
  };

  const handleTogglePriority = () =>
    updateAnnotations({ priority: nextPriority(session.user.priority) });

  const handleTogglePin = () => updateAnnotations({ pinned: !session.user.pinned });

  const handleToggleCleanup = () => updateAnnotations({ cleanup: !session.user.cleanup });

  const isSnoozed = Boolean(session.user.snoozedUntil && session.user.snoozedUntil > Date.now());
  // Snoozing drops the session to the bottom of the ranking for an hour; the
  // server wakes it automatically when the time is up.
  const handleToggleSnooze = () =>
    updateAnnotations({ snoozedUntil: isSnoozed ? null : Date.now() + 60 * 60 * 1000 });

  const handleToggleAutoApprove = () => updateAnnotations({ autoApprove: !session.user.autoApprove });

  const handleRename = async () => {
    const next = editableTitle.trim();
    if (!next) {
      // An empty title would leave the session unlabeled everywhere; revert instead.
      setEditableTitle(session.title);
      return;
    }
    if (next !== session.title) {
      try {
        await api.renameSession(session.id, next);
        onRefresh();
      } catch (err: any) {
        alert(`Could not rename session: ${err.message}`);
        setEditableTitle(session.title);
      }
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Blurring triggers onBlur → handleRename, so the rename is sent once.
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setEditableTitle(session.title);
      e.currentTarget.blur();
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete session "${session.title}"? This stops its agent and removes its history.`)) return;
    try {
      await api.deleteSession(session.id);
      onDeleted?.(session.id);
    } catch (err: any) {
      alert(`Could not delete session: ${err.message}`);
    }
  };

  const handleInPlaceSwitch = async (targetAgentId: string, targetModel?: string) => {
    if (targetAgentId === session.agentId && (targetModel === session.model || !targetModel)) {
      setShowModelPicker(false);
      return;
    }
    setSwitchingEngine(true);
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
      setShowModelPicker(false);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to switch model: ${err.message}`);
    } finally {
      setSwitchingEngine(false);
    }
  };

  const handleSetEffort = async (effort: 'off' | 'low' | 'medium' | 'high') => {
    try {
      await api.setSessionEffort(session.id, effort);
      setShowModelPicker(false);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to update reasoning effort: ${err.message}`);
    }
  };

  const handleRollback = async (
    turnId?: string,
    action: 'revert_to_this' | 'revert_before_this' | 'undo_last' = 'revert_to_this'
  ) => {
    if (rollingBack) return;

    if (action === 'undo_last') {
      if (!confirm('Undo the last message/turn in this conversation?')) {
        return;
      }
    } else if (action === 'revert_to_this') {
      if (!confirm('Rewind conversation to this point? All subsequent messages will be undone.')) {
        return;
      }
    } else if (action === 'revert_before_this' && turnId) {
      const idx = session.turns.findIndex((t) => t.id === turnId);
      const isUser = idx !== -1 && session.turns[idx].role === 'user';
      if (!isUser) {
        if (!confirm('Delete this turn and all subsequent messages?')) {
          return;
        }
      }
    }

    setRollingBack(true);
    try {
      const res = await api.rollbackSession(session.id, { turnId, action });
      if (res.restoredPrompt) {
        setPromptText(res.restoredPrompt);
        setTimeout(() => {
          promptInputRef.current?.focus();
        }, 50);
      }
      onRefresh();
    } catch (err: any) {
      alert(`Failed to undo: ${err.message}`);
    } finally {
      setRollingBack(false);
    }
  };

  const currentModelMeta = getModelMeta(session.model || 'sonnet');
  const activeEffort = session.effort || 'medium';

  // Flatten all available models from agents with their vendor and capabilities
  const allModelItems: Array<{
    agentId: string;
    agentName: string;
    modelId: string;
    label: string;
    badge: string;
    description: string;
    provider: string;
    supportsEffort: boolean;
  }> = [];

  agents.forEach((agent) => {
    const list = agent.availableModels || [];
    list.forEach((mId) => {
      const meta = getModelMeta(mId);
      allModelItems.push({
        agentId: agent.id,
        agentName: agent.name,
        modelId: mId,
        label: meta.label,
        badge: meta.badge,
        description: meta.description,
        provider: meta.provider,
        supportsEffort: meta.supportsEffort,
      });
    });
  });

  const agentClass = session.agentId.toLowerCase().includes('claude')
    ? 'claude'
    : session.agentId.toLowerCase().includes('codex')
    ? 'codex'
    : (session.agentId.toLowerCase().includes('gemini') || session.agentId.toLowerCase().includes('antigravity'))
    ? 'gemini'
    : 'mock';

  // Model pricing & context window calculation
  const getSessionPricing = () => {
    const m = (session.model || '').toLowerCase();
    if (session.agentId === 'mock') {
      // The built-in demo agent runs locally and costs nothing.
      return { contextWindow: 200_000, inputPerMillion: 0, outputPerMillion: 0, cachePerMillion: 0 };
    }
    if (m.includes('gemini') || m.includes('flash') || m.includes('pro')) {
      const isPro = m.includes('pro');
      return {
        contextWindow: 1_000_000,
        inputPerMillion: isPro ? 1.25 : 0.15,
        outputPerMillion: isPro ? 5.0 : 0.6,
        cachePerMillion: isPro ? 0.3125 : 0.0375,
      };
    }
    if (m.includes('opus')) {
      return {
        contextWindow: 200_000,
        inputPerMillion: 15.0,
        outputPerMillion: 75.0,
        cachePerMillion: 1.5,
      };
    }
    if (m.includes('haiku')) {
      return {
        contextWindow: 200_000,
        inputPerMillion: 0.8,
        outputPerMillion: 4.0,
        cachePerMillion: 0.08,
      };
    }
    // Sonnet / GPT-4o / default
    return {
      contextWindow: 200_000,
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cachePerMillion: 0.3,
    };
  };

  const pricing = getSessionPricing();
  const inputTokens = session.usage?.inputTokens || 0;
  const outputTokens = session.usage?.outputTokens || 0;
  const cachedTokens = session.usage?.cachedTokens || 0;
  const contextTokens = session.usage?.contextTokens || inputTokens;
  const totalTokens = inputTokens + outputTokens;
  const percentContext = Math.min(100, Math.round((contextTokens / pricing.contextWindow) * 100));
  const estimatedCost = (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;

  const lastTurn = session.turns.length > 0 ? session.turns[session.turns.length - 1] : null;
  const lastAgentText = (lastTurn && lastTurn.role === 'agent' ? lastTurn.content : '') || '';
  const hasActiveToolCalls = Boolean(
    lastTurn?.role === 'agent' &&
    lastTurn?.toolCalls?.some((tc) => tc.status === 'pending' || tc.status === 'running')
  );

  const suggestedActions = useMemo(() => {
    if (session.state === 'working' && hasActiveToolCalls) return [];
    const chips: Array<{ label: string; prompt: string; tooltip: string }> = [];

    // Prioritize native prompt suggestion from agent (e.g. Claude Code)
    if (session.promptSuggestion) {
      chips.push({
        label: `✨ ${session.promptSuggestion.length > 36 ? session.promptSuggestion.slice(0, 36) + '…' : session.promptSuggestion}`,
        prompt: session.promptSuggestion,
        tooltip: `Agent suggested prompt: "${session.promptSuggestion}" (click to insert or press Tab)`,
      });
    }

    if (!lastAgentText) return chips;
    const textLower = lastAgentText.toLowerCase();

    // Word boundaries matter: a bare includes('pr') matched "approval", "prompt", "improve"...
    if (session.git?.branch && /\b(pr|pull request)\b/.test(textLower)) {
      chips.push({
        label: '🚀 Proceed with PR',
        prompt: 'Please proceed with creating the pull request.',
        tooltip: 'Instruct agent to proceed with opening the PR',
      });
      chips.push({
        label: '🔍 Review git diff',
        prompt: 'Can you show me the git diff?',
        tooltip: 'Inspect git changes before proceeding',
      });
    }

    if (/\b(tests?|validate|verify)\b/.test(textLower)) {
      chips.push({
        label: '🧪 Run tests',
        prompt: 'Please run the test suite and verify everything passes.',
        tooltip: 'Run the test suite to validate changes',
      });
    }

    if (chips.length === 0) {
      chips.push({
        label: '👍 Proceed',
        prompt: 'Looks good, please proceed with the next steps.',
        tooltip: 'Instruct agent to continue',
      });
      chips.push({
        label: '🔍 Show status',
        prompt: 'What is the current status and what needs to be done next?',
        tooltip: 'Ask for detailed status update',
      });
    }

    chips.push({
      label: '↩️ Undo',
      prompt: '/undo',
      tooltip: 'Undo the last turn',
    });

    return chips;
  }, [lastAgentText, session.state, session.promptSuggestion, session.git?.branch, hasActiveToolCalls]);

  const renderEngineSwitcherPopover = () => (
    <div className="engine-switcher-popover popover-above">
      <div className="mobile-sheet-drag-handle" />
      <div className="engine-popover-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="engine-popover-title">Select Model & Effort</div>
          <div className="engine-popover-desc">
            Switch model in-place for upcoming prompts. Conversation history is preserved.
          </div>
        </div>
        <button
          type="button"
          className="btn-popover-close"
          onClick={(e) => {
            e.stopPropagation();
            setShowModelPicker(false);
          }}
          title="Close model picker"
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            border: 'none',
            borderRadius: '50%',
            width: '28px',
            height: '28px',
            color: '#cbd5e1',
            fontSize: '13px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginLeft: '8px',
          }}
        >
          ✕
        </button>
      </div>

      {/* Effort Selection Section (for models supporting reasoning/thinking) */}
      {currentModelMeta.supportsEffort && (
        <div className="effort-selector-section">
          <div className="effort-section-header">
            <span className="effort-title">🧠 Reasoning / Thinking Effort</span>
            <span className="effort-current-label">
              Active: <strong>{activeEffort.toUpperCase()}</strong>
            </span>
          </div>
          <div className="effort-buttons-group">
            {(['off', 'low', 'medium', 'high'] as const).map((eff) => (
              <button
                key={eff}
                type="button"
                className={`btn-effort-chip ${activeEffort === eff ? 'selected' : ''}`}
                onClick={() => {
                  handleSetEffort(eff);
                }}
              >
                {eff === 'off' ? 'Off' : eff === 'low' ? 'Low' : eff === 'medium' ? 'Medium' : 'High'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conversation Context Transfer Section */}
      <div className="effort-selector-section" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '10px' }}>
        <div className="effort-section-header">
          <span className="effort-title">📜 Context Handover on Switch</span>
          <span className="effort-current-label">
            Mode: <strong>{contextTransferMode.toUpperCase()}</strong>
          </span>
        </div>
        <div className="effort-buttons-group">
          {(['compact', 'full', 'none'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn-effort-chip ${contextTransferMode === mode ? 'selected' : ''}`}
              onClick={() => setContextTransferMode(mode)}
              title={
                mode === 'compact'
                  ? 'Summarize prior turns & touched files into a lean checkpoint to optimize tokens'
                  : mode === 'full'
                  ? 'Transfer verbatim conversation messages of recent turns'
                  : 'Start with blank conversational context (files & git preserved)'
              }
            >
              {mode === 'compact' ? '📦 Compact (Rec.)' : mode === 'full' ? '📜 Full Turns' : '🚫 Clean Slate'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.015)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-main)' }}>
          <input
            type="checkbox"
            checked={autoContinueOnSwitch}
            onChange={(e) => setAutoContinueOnSwitch(e.target.checked)}
            style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
          />
          <span>⚡ Immediately prompt new model to continue active task</span>
        </label>
      </div>

      {/* All Models with Vendor Icons on the Side */}
      <div className="models-list-scroll">
        <div className="models-group-label">ALL AVAILABLE MODELS</div>
        {allModelItems.map((item) => {
          const isSelected =
            item.agentId === session.agentId &&
            (session.model === item.modelId ||
              (!session.model && item.modelId === agents.find((a) => a.id === item.agentId)?.defaultModel));
          return (
            <div
              key={`${item.agentId}-${item.modelId}`}
              className={`model-card-row ${isSelected ? 'selected' : ''}`}
              onClick={() => handleInPlaceSwitch(item.agentId, item.modelId)}
            >
              <div className="model-vendor-col">
                <VendorIcon agentId={item.agentId} size={22} />
              </div>
              <div className="model-info-col">
                <div className="model-title-line">
                  <span className="model-name-text">{item.label}</span>
                  <span className="model-badge-tag">{item.badge}</span>
                  {item.supportsEffort && (
                    <span className="effort-supported-tag" title="Supports Thinking / Reasoning Effort">
                      🧠 Thinking
                    </span>
                  )}
                </div>
                <div className="model-sub-text">
                  <span className="provider-name">{item.provider}</span> • {item.description}
                </div>
              </div>
              <div className="model-status-col">
                {isSelected && <span className="active-pill">✓ Active</span>}
              </div>
            </div>
          );
        })}

        {/* Custom Model Input */}
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
            CUSTOM SUBSCRIPTION / API MODEL ID
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              placeholder="e.g. gpt-4.5-preview, claude-3-opus, custom-id"
              value={customModelInput}
              onChange={(e) => setCustomModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customModelInput.trim()) {
                  handleInPlaceSwitch(session.agentId, customModelInput.trim());
                  setCustomModelInput('');
                }
              }}
              style={{
                flex: 1,
                background: '#0d0f14',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                color: 'var(--text-main)',
                fontSize: '12px',
                padding: '6px 10px',
              }}
            />
            <button
              type="button"
              className="btn-action"
              disabled={!customModelInput.trim() || switchingEngine}
              onClick={() => {
                if (customModelInput.trim()) {
                  handleInPlaceSwitch(session.agentId, customModelInput.trim());
                  setCustomModelInput('');
                }
              }}
              style={{ padding: '6px 12px', fontSize: '12px', fontWeight: 600 }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      <div className="engine-popover-footer">
        <button
          type="button"
          className="engine-footer-action"
          onClick={() => {
            setShowModelPicker(false);
            onOpenSwitchModal();
          }}
        >
          🔄 Advanced switch / Fork session...
        </button>
      </div>
    </div>
  );

  return (
    <div className="main-view">
      {/* Session Top Bar */}
      <div className="detail-header">
        <div className="header-left">
          {onBackToList && (
            <button
              type="button"
              className="btn-mobile-back"
              onClick={onBackToList}
              title="Back to all sessions"
            >
              <span className="back-arrow">‹</span>
              <span className="back-text">Sessions</span>
              {totalSessionsCount !== undefined && totalSessionsCount > 0 && (
                <span className="back-count-badge">{totalSessionsCount}</span>
              )}
            </button>
          )}

          {/* Top Header Agent Badge */}
          <div className="header-agent-badge" title={`${session.agentName} · ${currentModelMeta.label || session.model}`}>
            <VendorIcon agentId={session.agentId} size={18} />
          </div>
          <input
            className="header-title-input"
            value={editableTitle}
            onChange={(e) => setEditableTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleTitleKeyDown}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {session.git?.branch ? (
              <span className="branch-tag" title={session.cwd}>
                🌿 {session.git.branch}
              </span>
            ) : (
              <span className="branch-tag" title={session.cwd}>
                📁 {session.cwd.split('/').filter(Boolean).pop() || session.cwd}
              </span>
            )}
            <div style={{ position: 'relative' }}>
              <span
                className={`state-badge ${session.isAgentRunning === false ? 'parked' : session.state}`}
                style={{
                  cursor: 'pointer',
                  borderColor: session.isAgentRunning === false ? 'rgba(239, 68, 68, 0.45)' : undefined,
                  color: session.isAgentRunning === false ? '#f87171' : undefined,
                  backgroundColor: session.isAgentRunning === false ? 'rgba(239, 68, 68, 0.12)' : undefined,
                }}
                onClick={() => setShowReasons(!showReasons)}
                title={session.isAgentRunning === false ? 'Agent subprocess is stopped. Click to view reasons.' : 'Click to view attention reasons'}
              >
                {session.isAgentRunning === false ? '⏹ STOPPED' : session.state.replace('_', ' ').toUpperCase()} ({session.score}) ▾
              </span>
              {showReasons && (
                <div
                  style={{
                    position: 'absolute',
                    top: '24px',
                    left: 0,
                    zIndex: 100,
                    background: '#1f2028',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    width: '280px',
                    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                  }}
                >
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
                    ATTENTION SCORE BREAKDOWN ({session.score})
                  </div>
                  {session.reasons.map((r, i) => (
                    <div key={i} style={{ fontSize: '11px', color: 'var(--text-main)', marginBottom: '3px' }}>
                      • {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Desktop Header Actions */}
        <div className="header-actions">
          <button
            className="btn-action"
            onClick={handleToggleAutoApprove}
            title="Automatically approve all permission requests (file access, commands) without prompting"
            style={{
              color: session.user.autoApprove ? '#34d399' : 'inherit',
              borderColor: session.user.autoApprove ? '#059669' : undefined,
              backgroundColor: session.user.autoApprove ? 'rgba(16, 185, 129, 0.15)' : undefined,
            }}
          >
            ⚡ {session.user.autoApprove ? 'Auto: ON' : 'Auto: OFF'}
          </button>
          <button
            className="btn-action btn-failover"
            onClick={onOpenSwitchModal}
            title="Failover or switch to another agent (e.g. Codex/Claude)"
          >
            🔄 Switch
          </button>
          <button
            className="btn-action btn-undo"
            onClick={() => handleRollback(undefined, 'undo_last')}
            disabled={session.turns.length === 0 || rollingBack}
            title="Undo the last message or response in this conversation"
          >
            ↩ Undo
          </button>
          <button
            className="btn-action"
            onClick={handleCompactSession}
            disabled={session.turns.length <= 1 || compacting}
            title="Compact earlier verbose turns and tool logs into a clean checkpoint to optimize context"
            style={{
              color: compacting ? '#fbbf24' : 'inherit',
            }}
          >
            {compacting ? '⏳ Compacting...' : '📦 Compact'}
          </button>
          <button
            className="btn-action"
            onClick={handleTogglePriority}
            title={`Toggle priority (P0/P1/P2) - Current: ${session.user.priority ? session.user.priority.toUpperCase() : 'None'}`}
            aria-label={`Priority: ${session.user.priority ? session.user.priority.toUpperCase() : 'none'}`}
          >
            ⭐{session.user.priority ? ` ${session.user.priority.toUpperCase()}` : ''}
          </button>
          <button
            className="btn-action"
            onClick={handleTogglePin}
            title={session.user.pinned ? 'Pinned to top (Click to unpin)' : 'Pin session to top'}
            aria-label={session.user.pinned ? 'Unpin session' : 'Pin session'}
            style={{ color: session.user.pinned ? '#38bdf8' : 'inherit' }}
          >
            📌
          </button>
          <button
            className="btn-action"
            onClick={handleToggleCleanup}
            title={session.user.cleanup ? 'Marked cleaned up (Click to unmark)' : 'Mark session cleaned up'}
            aria-label={session.user.cleanup ? 'Unmark cleanup' : 'Mark for cleanup'}
            style={{ color: session.user.cleanup ? '#10b981' : 'inherit' }}
          >
            ✓
          </button>
          <button
            className="btn-action"
            onClick={handleToggleSnooze}
            title={
              isSnoozed
                ? `Snoozed until ${new Date(session.user.snoozedUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (click to wake)`
                : 'Snooze for 1 hour: move to the bottom of the list'
            }
            aria-label={isSnoozed ? 'Wake session' : 'Snooze session for 1 hour'}
            style={{ color: isSnoozed ? '#a78bfa' : 'inherit' }}
          >
            💤
          </button>
          {session.isAgentRunning !== false ? (
            <button
              className="btn-action btn-stop-agent"
              onClick={handleStopAgent}
              title="Stop and terminate the underlying agent subprocess & terminal to free memory and CPU. Session history is kept and auto-resumes on next message."
              style={{
                color: '#f87171',
                borderColor: 'rgba(239, 68, 68, 0.35)',
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
              }}
            >
              ⏹ Stop Agent
            </button>
          ) : (
            <button
              className="btn-action btn-start-agent"
              onClick={handleStartAgent}
              title="Start / Resume the agent subprocess"
              style={{
                color: '#34d399',
                borderColor: 'rgba(52, 211, 153, 0.35)',
                backgroundColor: 'rgba(52, 211, 153, 0.08)',
              }}
            >
              ▶ Resume Agent
            </button>
          )}
          <button
            className="btn-action"
            onClick={handleDelete}
            title="Delete session"
            aria-label="Delete session"
            style={{ color: '#ef4444' }}
          >
            🗑
          </button>
        </div>

        {/* Mobile Header Quick Actions */}
        <div className="mobile-header-right">
          <button
            type="button"
            className={`btn-mobile-auto ${session.user.autoApprove ? 'active' : ''}`}
            onClick={handleToggleAutoApprove}
            title={session.user.autoApprove ? 'Auto-Approve: ON' : 'Auto-Approve: OFF'}
            aria-label={session.user.autoApprove ? 'Auto-approve on' : 'Auto-approve off'}
          >
            ⚡
          </button>
          <button
            type="button"
            className="btn-mobile-more"
            onClick={() => setShowMobileActions(true)}
            title="More actions"
            aria-label="More actions"
          >
            ⋯
          </button>
        </div>
      </div>

      {/* Mobile Sub-Header: Title, Git branch & Attention score */}
      <div className="mobile-sub-header">
        <div className="mobile-sub-title-wrapper">
          <input
            className="mobile-header-title-input"
            value={editableTitle}
            onChange={(e) => setEditableTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleTitleKeyDown}
            placeholder="Session title..."
          />
        </div>
        <div className="mobile-sub-tags">
          {session.git?.branch && (
            <span className="branch-tag" title={session.cwd}>
              🌿 {session.git.branch}
            </span>
          )}
          <span
            className={`state-badge ${session.state}`}
            onClick={() => setShowReasons(!showReasons)}
          >
            {session.state.replace('_', ' ').toUpperCase()} ({session.score})
          </span>
        </div>
      </div>

      {/* Prominent Attention Banner when Blocked on Approval */}
      {session.pendingPermission && (
        <div className="approval-banner">
          <div className="approval-info">
            <span className="approval-icon">⚠️</span>
            <div>
              <div className="approval-title">{session.pendingPermission.title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                The agent is blocked waiting for your confirmation before executing this sensitive operation.
              </div>
            </div>
          </div>
          <div className="approval-buttons">
            {session.pendingPermission.options.map((opt) => (
              <button
                key={opt.optionId}
                className={opt.optionId.includes('deny') || opt.optionId.includes('reject') ? 'btn-reject' : 'btn-approve'}
                onClick={() => handleResolvePermission(opt.optionId)}
              >
                {opt.name}
              </button>
            ))}
            <button
              className="btn-approve"
              style={{ backgroundColor: '#059669', borderColor: '#10b981' }}
              onClick={async () => {
                await api.updateAnnotations(session.id, { autoApprove: true });
                const allowOpt = session.pendingPermission?.options.find(
                  (o) => !o.optionId.includes('deny') && !o.optionId.includes('reject')
                );
                handleResolvePermission(allowOpt?.optionId || 'allow');
              }}
              title="Approve this request and enable Auto-Approve for all future requests in this session"
            >
              ⚡ Always Allow (Enable Auto-Approve)
            </button>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="view-tabs">
        <div className="tabs-left">
          <button
            className={`view-tab ${activeTab === 'conversation' ? 'active' : ''}`}
            onClick={() => setActiveTab('conversation')}
          >
            Conversation
          </button>
          <button
            className={`view-tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setActiveTab('terminal')}
          >
            Terminal
            {shellCommandCount > 0 && <span className="tab-count">{shellCommandCount}</span>}
          </button>
          <button
            className={`view-tab ${activeTab === 'usage' ? 'active' : ''}`}
            onClick={() => setActiveTab('usage')}
          >
            📊 Usage & Context {contextTokens > 0 ? `(${contextTokens > 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens})` : ''}
          </button>
        </div>

        <div className="tabs-right">
          <button
            type="button"
            className={`header-usage-pill ${percentContext > 80 ? 'danger' : percentContext > 50 ? 'warning' : ''}`}
            onClick={() => setActiveTab('usage')}
            title={`Context Window: ${contextTokens.toLocaleString()} / ${pricing.contextWindow.toLocaleString()} tokens (${percentContext}%). Click to inspect token breakdown.`}
          >
            <span className="usage-pill-icon">📊</span>
            <span className="usage-pill-text">
              {contextTokens > 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : contextTokens} / {pricing.contextWindow >= 1000000 ? `${pricing.contextWindow / 1000000}M` : `${pricing.contextWindow / 1000}k`}
            </span>
            <span className="usage-pill-percent">({percentContext}%)</span>
            <span className="usage-pill-cost">· ${estimatedCost.toFixed(3)}</span>
          </button>
        </div>
      </div>

      {/* Body Views */}
      {activeTab === 'conversation' ? (
        <>
        <ActivityStrip session={session} />
        <div
          className="conversation-body"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          {session.turns.length === 0 && (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-dim)' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>💬</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-muted)' }}>
                Session started with {session.agentName}
              </div>
              <div style={{ fontSize: '13px', marginTop: '6px' }}>
                Type a goal or instruction below to begin.
              </div>
            </div>
          )}

          {session.turns.map((turn, index) => {
            if (turn.role === 'system') {
              return (
                <div key={turn.id} className="system-turn-bubble">
                  <span className="system-turn-icon">⚙️</span>
                  <span className="system-turn-text">{turn.content}</span>
                  <button
                    type="button"
                    className="system-turn-del-btn"
                    onClick={() => handleRollback(turn.id, 'revert_before_this')}
                    title="Remove this event and undo subsequent messages"
                  >
                    ✕
                  </button>
                </div>
              );
            }

            return (
              <div key={turn.id} className={`turn-bubble ${turn.role}`}>
                {turn.role === 'user' ? (
                  <div>
                    <div className="turn-top-bar">
                      <span className="turn-role-tag">User</span>
                      <div className="turn-hover-actions">
                        <button
                          type="button"
                          className="turn-action-btn"
                          onClick={() => handleRollback(turn.id, 'revert_before_this')}
                          title="Rewind here and edit this prompt in composer"
                        >
                          ✏️ Edit & Resend
                        </button>
                        <button
                          type="button"
                          className="turn-action-btn"
                          onClick={() => handleRollback(turn.id, 'revert_to_this')}
                          title="Rewind conversation so this is the last message"
                        >
                          ↩ Rewind here
                        </button>
                      </div>
                    </div>
                    {/* Attachments rendering */}
                    {turn.attachments && turn.attachments.length > 0 && (
                      <div className="turn-attachments-wrapper">
                        {turn.attachments.map((att) => (
                          <div key={att.id} className="turn-attachment-bubble">
                            {att.isImage ? (
                              <div
                                className="turn-image-container"
                                onClick={() => setPreviewImage(att.url ? withToken(att.url) : att.data || null)}
                                title="Click to view full size image"
                              >
                                <img
                                  src={att.url ? withToken(att.url) : att.data}
                                  alt={att.name}
                                  className="turn-image-thumb"
                                />
                                <div className="turn-image-badge">{att.name}</div>
                              </div>
                            ) : (
                              <a
                                href={att.url ? withToken(att.url) : '#'}
                                download={att.name}
                                className="turn-file-card"
                                title={`Download ${att.name}`}
                              >
                                <span style={{ fontSize: '18px' }}>📄</span>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontWeight: 600, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {att.name}
                                  </div>
                                  <div style={{ fontSize: '11px', opacity: 0.7 }}>
                                    {(att.size / 1024).toFixed(1)} KB
                                  </div>
                                </div>
                                <span style={{ fontSize: '13px' }}>⬇️</span>
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {turn.content && <div style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</div>}
                  </div>
                ) : (() => {
                    const turnAgentId = turn.agentId || session.agentId;
                    const turnAgentName = turn.agentName || session.agentName;
                    const turnModel = turn.model || session.model;
                    const turnModelMeta = turnModel ? getModelMeta(turnModel) : null;

                    return (
                      <div>
                        <div className="agent-turn-header">
                          <div className="agent-turn-meta">
                            <VendorIcon agentId={turnAgentId} size={15} />
                            <span className="agent-turn-name">{turnAgentName}</span>
                            {turnModel && (
                              <span
                                className="agent-turn-model"
                                title={turnModelMeta ? `${turnModelMeta.label} (${turnModelMeta.provider})` : turnModel}
                              >
                                {turnModelMeta?.label || turnModel}
                              </span>
                            )}
                          </div>
                      <div className="turn-hover-actions">
                        <button
                          type="button"
                          className="turn-action-btn"
                          onClick={() => handleRollback(turn.id, 'revert_to_this')}
                          title="Rewind conversation so this response is the last turn"
                        >
                          ↩ Rewind here
                        </button>
                        <button
                          type="button"
                          className="turn-action-btn btn-delete-turn"
                          onClick={() => handleRollback(turn.id, 'revert_before_this')}
                          title="Delete this agent turn and any subsequent messages"
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </div>

                    <AgentTurnBody
                      turn={turn}
                      isActiveTurn={
                        index === session.turns.length - 1 &&
                        (session.state === 'working' || Boolean(session.pendingPermission))
                      }
                      isAwaitingApproval={index === session.turns.length - 1 && Boolean(session.pendingPermission)}
                    />
                  </div>
                );
              })()}
              </div>
            );
          })}

          {/* Turn Status Banner & Quick Action Suggestions */}
          {session.turns.length > 0 && (
            <div className="conversation-status-area">
              {session.state === 'working' && !session.pendingPermission ? (
                <div className="turn-status-banner working">
                  <div className="status-banner-left">
                    <span className="pulse-indicator" />
                    <span className="status-banner-text">
                      {lastAgentText && !hasActiveToolCalls
                        ? 'Agent response received · Finishing turn...'
                        : 'Agent is working on your request...'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {lastAgentText && !hasActiveToolCalls && (
                      <button
                        type="button"
                        className="btn-action"
                        style={{ fontSize: '11px', padding: '3px 8px', color: '#10b981', borderColor: 'rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.1)' }}
                        onClick={handleCancelPrompt}
                        title="Agent response received. Click to release turn and mark ready immediately"
                      >
                        ✓ Mark Ready
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-banner-cancel"
                      onClick={handleCancelPrompt}
                      title="Stop active execution"
                    >
                      ⏹ Stop Turn
                    </button>
                  </div>
                </div>
              ) : session.pendingPermission ? (
                <div className="turn-status-banner blocked">
                  <div className="status-banner-left">
                    <span className="status-dot">⚠️</span>
                    <span className="status-banner-text">
                      <strong>Waiting for your approval</strong> · {session.pendingPermission.title}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="turn-status-banner ready">
                  <div className="status-banner-left">
                    <span className="status-dot green">🟢</span>
                    <span className="status-banner-text">
                      <strong>Ready for your input</strong> · Turn completed
                    </span>
                  </div>
                  {suggestedActions.length > 0 && (
                    <div className="quick-action-chips">
                      <span className="quick-action-label">Quick Action:</span>
                      {suggestedActions.map((action, i) => (
                        <button
                          key={i}
                          type="button"
                          className="quick-action-chip"
                          onClick={() => {
                            if (action.prompt === '/undo') {
                              handleRollback(undefined, 'undo_last');
                            } else {
                              setPromptText(action.prompt);
                              promptInputRef.current?.focus();
                            }
                          }}
                          title={action.tooltip}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        </>
      ) : activeTab === 'terminal' ? (
        <LiveTerminalPanel session={session} />
      ) : (
        <div className="session-usage-tab-content">
          {/* Top Context Meter Banner */}
          <div className="context-meter-card">
            <div className="context-meter-header">
              <div>
                <div className="context-meter-title">Context Window Utilization</div>
                <div className="context-meter-sub">
                  Active buffer: <strong>{contextTokens.toLocaleString()}</strong> of <strong>{pricing.contextWindow.toLocaleString()}</strong> tokens ({pricing.contextWindow >= 1000000 ? `${pricing.contextWindow / 1000000}M` : `${pricing.contextWindow / 1000}k`} window)
                </div>
              </div>
              <div
                className="context-meter-percent"
                style={{ color: percentContext > 80 ? '#ef4444' : percentContext > 50 ? '#f59e0b' : '#38bdf8' }}
              >
                {percentContext}%
              </div>
            </div>

            {/* Context Gauge Bar */}
            <div className="context-bar-track">
              <div
                className="context-bar-fill"
                style={{
                  width: `${percentContext}%`,
                  backgroundColor: percentContext > 80 ? '#ef4444' : percentContext > 50 ? '#f59e0b' : '#38bdf8',
                }}
              />
            </div>

            <div className="context-meter-footer">
              <span>{Math.max(0, pricing.contextWindow - contextTokens).toLocaleString()} tokens available</span>
              {percentContext > 60 && (
                <button
                  type="button"
                  className="btn-action"
                  onClick={handleCompactSession}
                  disabled={compacting || session.turns.length <= 1}
                  style={{ color: '#fbbf24', borderColor: '#f59e0b', fontSize: '12px' }}
                >
                  📦 Compact conversation history now
                </button>
              )}
            </div>
          </div>

          {/* Token Breakdown & Cost Grid */}
          <div className="usage-stats-grid">
            <div className="usage-stat-box">
              <div className="usage-stat-label">INPUT TOKENS</div>
              <div className="usage-stat-val">{inputTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Prompt text + tool inputs</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">OUTPUT TOKENS</div>
              <div className="usage-stat-val">{outputTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Agent reasoning + completions</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">CACHED TOKENS</div>
              <div className="usage-stat-val highlight">{cachedTokens.toLocaleString()}</div>
              <div className="usage-stat-hint">Prompt caching savings</div>
            </div>
            <div className="usage-stat-box">
              <div className="usage-stat-label">ESTIMATED SPEND</div>
              <div className="usage-stat-val" style={{ color: '#34d399' }}>
                ${estimatedCost.toFixed(4)}
              </div>
              <div className="usage-stat-hint">
                At ${pricing.inputPerMillion}/M in, ${pricing.outputPerMillion}/M out
              </div>
            </div>
          </div>

          {/* Model & Vendor Specs Card */}
          <div className="model-specs-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <VendorIcon agentId={session.agentId} size={20} />
                <span style={{ fontWeight: 700, fontSize: '14px' }}>
                  {session.agentName} · {currentModelMeta.label || session.model}
                </span>
              </div>
              {onOpenSubscriptionsModal && (
                <button
                  type="button"
                  className="btn-action"
                  onClick={onOpenSubscriptionsModal}
                  style={{ fontSize: '12px', padding: '6px 12px' }}
                >
                  💳 Manage Subscriptions & All Vendors →
                </button>
              )}
            </div>
            <div className="model-specs-table">
              <div className="spec-row">
                <span>Model ID:</span>
                <code>{session.model || 'default'}</code>
              </div>
              <div className="spec-row">
                <span>Max Context Window:</span>
                <span>{pricing.contextWindow.toLocaleString()} tokens</span>
              </div>
              <div className="spec-row">
                <span>Standard Pricing:</span>
                <span>${pricing.inputPerMillion.toFixed(2)} / 1M input · ${pricing.outputPerMillion.toFixed(2)} / 1M output</span>
              </div>
              <div className="spec-row">
                <span>Workspace:</span>
                <code title={session.cwd}>{session.cwd}</code>
              </div>
            </div>
          </div>

          {/* Vendor Rate Limits & Rolling Windows Card */}
          {session.rateLimits && (session.rateLimits.fiveHour || session.rateLimits.weeklyAll) && (
            <div
              className="model-specs-card"
              style={{
                marginTop: '16px',
                background: 'rgba(217, 119, 6, 0.08)',
                borderColor: 'rgba(217, 119, 6, 0.28)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>⏱️</span>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-normal)' }}>
                      Anthropic Claude Subscription Limits
                    </span>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      Live 5-hour rolling session limit and weekly capacity for your Claude account
                    </div>
                  </div>
                </div>
                {onOpenSubscriptionsModal && (
                  <button
                    type="button"
                    className="btn-action"
                    onClick={onOpenSubscriptionsModal}
                    style={{ fontSize: '12px', padding: '5px 12px' }}
                  >
                    💳 Manage Subscriptions →
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {session.rateLimits.fiveHour && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>5-Hour Session Limit</span>
                      <span style={{ fontWeight: 700, color: session.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {session.rateLimits.fiveHour.utilization}% used
                        {session.rateLimits.fiveHour.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {session.rateLimits.fiveHour.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, session.rateLimits.fiveHour.utilization)}%`,
                          background: session.rateLimits.fiveHour.utilization > 80 ? '#f59e0b' : '#d97706',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}

                {session.rateLimits.weeklyAll && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit (All Models)</span>
                      <span style={{ fontWeight: 700, color: session.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {session.rateLimits.weeklyAll.utilization}% used
                        {session.rateLimits.weeklyAll.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {session.rateLimits.weeklyAll.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, session.rateLimits.weeklyAll.utilization)}%`,
                          background: session.rateLimits.weeklyAll.utilization > 80 ? '#f59e0b' : '#3b82f6',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}

                {session.rateLimits.weeklyModels?.map((wm: { name: string; utilization: number; resetsAt?: string | null }, idx: number) => (
                  <div key={idx}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-normal)' }}>Weekly Limit ({wm.name})</span>
                      <span style={{ fontWeight: 700, color: wm.utilization > 80 ? '#f59e0b' : 'inherit' }}>
                        {wm.utilization}% used
                        {wm.resetsAt && (
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>
                            · resets {wm.resetsAt}
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, wm.utilization)}%`,
                          background: wm.utilization > 80 ? '#f59e0b' : '#8b5cf6',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Turn Activity Breakdown */}
          <div className="turns-usage-card">
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '10px', textTransform: 'uppercase' }}>
              Conversation Turns & Tool Impact ({session.turns.length} turns)
            </div>
            <div className="turns-table-wrapper">
              <table className="turns-usage-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Role</th>
                    <th>Tool Calls</th>
                    <th>Timestamp</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {session.turns.map((t, idx) => (
                    <tr key={t.id}>
                      <td style={{ color: 'var(--text-dim)' }}>{idx + 1}</td>
                      <td>
                        <span className={`turn-role-badge ${t.role}`}>
                          {t.role.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        {t.toolCalls && t.toolCalls.length > 0 ? (
                          <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                            {t.toolCalls.length} tool{t.toolCalls.length > 1 ? 's' : ''}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                        {new Date(t.timestamp).toLocaleTimeString()}
                      </td>
                      <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.content ? t.content.slice(0, 80) : t.thoughts ? `💭 ${t.thoughts.slice(0, 80)}` : 'System event'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Input Bar with Engine Switcher Pill & File/Image Attachments */}
      <form className="input-bar" onSubmit={handleSendPrompt}>
        <div
          className={`input-box-wrapper ${isDraggingOver ? 'dragging-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingOver && (
            <div className="composer-drop-overlay">
              <span>📥 Drop pictures or files here to attach</span>
            </div>
          )}

          <div className="composer-toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className="composer-engine-wrapper" ref={composerPickerRef}>
                <button
                  type="button"
                  className="composer-engine-pill"
                  onClick={() => setShowModelPicker((prev) => !prev)}
                  title="Click to switch model or effort for upcoming prompts"
                >
                  <VendorIcon agentId={session.agentId} size={14} />
                  <span className="composer-engine-name">{currentModelMeta.label || session.model || session.agentName}</span>
                  {currentModelMeta.supportsEffort && activeEffort !== 'off' && (
                    <span className="composer-effort-tag">({activeEffort})</span>
                  )}
                  <span className="composer-chevron">{showModelPicker ? '▴' : '▾'}</span>
                </button>
                {showModelPicker && (
                  <>
                    <div
                      className="engine-switcher-mobile-backdrop"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModelPicker(false);
                      }}
                    />
                    {renderEngineSwitcherPopover()}
                  </>
                )}
              </div>

              {/* Attach File/Picture Button */}
              <button
                type="button"
                className="composer-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                title="Add pictures or files (or paste / drop here)"
              >
                <span>📎</span>
                <span className="attach-btn-label">Attach</span>
              </button>

              {/* Slash Commands Button */}
              <button
                type="button"
                className={`composer-attach-btn btn-slash-trigger ${showSlashMenu ? 'active' : ''}`}
                onClick={() => {
                  setShowSlashMenu(!showSlashMenu);
                  if (!showSlashMenu && !promptText.startsWith('/')) {
                    setPromptText('/');
                  }
                  promptInputRef.current?.focus();
                }}
                title={`Browse slash commands for ${session.agentName} (or type /)`}
              >
                <span className="slash-icon">/</span>
                <span className="attach-btn-label">Commands</span>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) {
                    processFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }
                }}
              />
            </div>
            <span className="composer-hint">Type / for commands • Enter to send</span>
          </div>

          {/* Pending Attachments Strip */}
          {attachments.length > 0 && (
            <div className="composer-attachments-bar">
              {attachments.map((att) => (
                <div key={att.id} className="composer-attachment-chip">
                  {att.isImage ? (
                    <img src={att.data} alt={att.name} className="composer-attachment-preview-img" />
                  ) : (
                    <span className="composer-attachment-icon">📄</span>
                  )}
                  <div className="composer-attachment-info">
                    <span className="composer-attachment-name" title={att.name}>{att.name}</span>
                    <span className="composer-attachment-size">({(att.size / 1024).toFixed(1)} KB)</span>
                  </div>
                  <button
                    type="button"
                    className="btn-remove-attachment"
                    onClick={() => handleRemoveAttachment(att.id)}
                    title="Remove attachment"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Slash Commands Autocomplete Popover */}
          {showSlashMenu && (
            <div className="slash-commands-popover" ref={slashMenuRef}>
              <div className="slash-popover-header">
                <div className="slash-popover-title-row">
                  <span className={`slash-agent-tag ${session.agentId.toLowerCase()}`}>
                    <VendorIcon agentId={session.agentId} size={14} />
                    <span style={{ marginLeft: '4px' }}>{session.agentName.split(' ')[0]}</span>
                  </span>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-main)' }}>
                    Slash Commands {slashQuery ? `matching "/${slashQuery}"` : ''}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                    ({filteredSlashCommands.length})
                  </span>
                </div>
                <div className="slash-popover-tabs">
                  <button
                    type="button"
                    className={`slash-tab-btn ${slashFilterCategory === 'all' ? 'active' : ''}`}
                    onClick={() => setSlashFilterCategory('all')}
                  >
                    All ({availableSlashCommands.length})
                  </button>
                  <button
                    type="button"
                    className={`slash-tab-btn ${slashFilterCategory === 'agent' ? 'active' : ''}`}
                    onClick={() => setSlashFilterCategory('agent')}
                  >
                    {session.agentName.split(' ')[0]}
                  </button>
                  <button
                    type="button"
                    className={`slash-tab-btn ${slashFilterCategory === 'terminal' ? 'active' : ''}`}
                    onClick={() => setSlashFilterCategory('terminal')}
                  >
                    Terminal
                  </button>
                  <button
                    type="button"
                    className="slash-tab-btn"
                    onClick={() => setShowSlashMenu(false)}
                    title="Close suggestions (Esc)"
                    style={{ marginLeft: '4px' }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="slash-commands-list">
                {filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                    No slash commands matching <code>/{slashQuery}</code> for {session.agentName}
                  </div>
                ) : (
                  filteredSlashCommands.map((cmd, idx) => {
                    const isSelected = idx === selectedSlashIndex;
                    const badgeClass =
                      cmd.category === 'terminal'
                        ? 'terminal'
                        : session.agentId.toLowerCase().includes('claude')
                        ? 'claude'
                        : session.agentId.toLowerCase().includes('codex')
                        ? 'codex'
                        : (session.agentId.toLowerCase().includes('antigravity') || session.agentId.toLowerCase().includes('gemini'))
                        ? 'antigravity'
                        : 'terminal';

                    return (
                      <div
                        key={cmd.command}
                        className={`slash-command-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleSelectSlashCommand(cmd)}
                        onMouseEnter={() => setSelectedSlashIndex(idx)}
                      >
                        <div className="slash-item-left">
                          <span className="slash-item-icon">{cmd.icon || '⚡'}</span>
                          <div className="slash-item-info">
                            <div className="slash-item-main">
                              <span className="slash-item-name">{cmd.command}</span>
                              {cmd.hint && <span className="slash-item-hint">{cmd.hint}</span>}
                              <span className="slash-item-label">• {cmd.label}</span>
                            </div>
                            <div className="slash-item-desc">{cmd.description}</div>
                          </div>
                        </div>
                        <span className={`slash-item-badge ${badgeClass}`}>
                          {cmd.category === 'terminal' ? 'ACP Terminal' : session.agentName.split(' ')[0]}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="slash-hint-text">
                  ↑↓ to navigate • ↵ or Tab to select • Esc to dismiss
                </span>
                <span className="slash-hint-text" style={{ color: '#38bdf8' }}>
                  Tailored for {session.agentName}
                </span>
              </div>
            </div>
          )}

          <textarea
            ref={promptInputRef}
            className="prompt-textarea"
            placeholder={
              session.promptSuggestion
                ? `Suggestion: ${session.promptSuggestion} (Press Tab to insert)...`
                : attachments.length > 0
                ? 'Add an instruction or press Enter to send attached files/pictures...'
                : `Ask ${session.agentName}${session.model ? ` (${session.model})` : ''}...`
            }
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={sending}
          />
        </div>
        {session.state === 'working' && !promptText.trim() && attachments.length === 0 ? (
          <button type="button" className="btn-cancel" onClick={handleCancelPrompt}>
            ⏹ Stop Turn
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '8px' }}>
            {session.state === 'working' && (
              <button
                type="button"
                className="btn-cancel"
                onClick={handleCancelPrompt}
                title="Stop current generation"
              >
                ⏹ Stop
              </button>
            )}
            <button
              type="submit"
              className="btn-send"
              disabled={(!promptText.trim() && attachments.length === 0) || sending}
              title={session.state === 'working' ? 'Stop current turn and send new prompt' : 'Send prompt'}
            >
              {sending ? 'Sending...' : session.state === 'working' ? '⚡ Send & Interrupt' : 'Send'}
            </button>
          </div>
        )}
      </form>

      {/* Mobile Actions Drawer / Sheet */}
      {showMobileActions && (
        <div className="mobile-actions-backdrop" onClick={() => setShowMobileActions(false)}>
          <div className="mobile-actions-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-sheet-header">
              <div className="mobile-sheet-title">Session Actions & Tools</div>
              <button type="button" className="btn-close" onClick={() => setShowMobileActions(false)}>✕</button>
            </div>

            <div className="mobile-actions-list">
              <button
                type="button"
                className={`mobile-action-item ${session.user.autoApprove ? 'active' : ''}`}
                onClick={() => {
                  handleToggleAutoApprove();
                  setShowMobileActions(false);
                }}
              >
                <span className="mobile-action-icon">⚡</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Auto-Approve Tool Permissions</div>
                  <div className="mobile-action-desc">
                    {session.user.autoApprove ? 'Enabled (auto-approves tool runs)' : 'Disabled (prompts for approvals)'}
                  </div>
                </div>
                <span className="mobile-action-toggle">{session.user.autoApprove ? 'ON' : 'OFF'}</span>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  setShowMobileActions(false);
                  setShowModelPicker(true);
                }}
              >
                <span className="mobile-action-icon">🧠</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Switch Active Model & Effort</div>
                  <div className="mobile-action-desc">
                    Active: {currentModelMeta.label || session.model || session.agentName} ({activeEffort})
                  </div>
                </div>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  setShowMobileActions(false);
                  onOpenSwitchModal();
                }}
              >
                <span className="mobile-action-icon">🔄</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Switch or Failover Agent</div>
                  <div className="mobile-action-desc">Switch between Claude, Codex, Gemini, or fork session</div>
                </div>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  setShowMobileActions(false);
                  handleRollback(undefined, 'undo_last');
                }}
                disabled={session.turns.length === 0 || rollingBack}
              >
                <span className="mobile-action-icon">↩</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Undo Last Turn</div>
                  <div className="mobile-action-desc">Revert last prompt & response</div>
                </div>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  setShowMobileActions(false);
                  handleCompactSession();
                }}
                disabled={session.turns.length <= 1 || compacting}
              >
                <span className="mobile-action-icon">📦</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Compact History Checkpoint</div>
                  <div className="mobile-action-desc">Free up tokens by summarizing earlier turns</div>
                </div>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  handleTogglePriority();
                }}
              >
                <span className="mobile-action-icon">⭐</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">Priority Level</div>
                  <div className="mobile-action-desc">Current: {session.user.priority ? session.user.priority.toUpperCase() : 'Standard'}</div>
                </div>
                <span className="mobile-action-tag">{session.user.priority ? session.user.priority.toUpperCase() : 'None'}</span>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  handleTogglePin();
                }}
              >
                <span className="mobile-action-icon">📌</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">{session.user.pinned ? 'Unpin Session' : 'Pin to Top'}</div>
                  <div className="mobile-action-desc">Keep at the top of the session list</div>
                </div>
                <span className="mobile-action-tag">{session.user.pinned ? 'Pinned' : 'Off'}</span>
              </button>

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  handleToggleCleanup();
                }}
              >
                <span className="mobile-action-icon">✓</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">{session.user.cleanup ? 'Mark Active' : 'Mark for Cleanup'}</div>
                  <div className="mobile-action-desc">Filter completed work away from active queue</div>
                </div>
                <span className="mobile-action-tag">{session.user.cleanup ? 'Cleaned' : 'Active'}</span>
              </button>

              <button type="button" className="mobile-action-item" onClick={handleToggleSnooze}>
                <span className="mobile-action-icon">💤</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label">{isSnoozed ? 'Wake Session' : 'Snooze for 1 Hour'}</div>
                  <div className="mobile-action-desc">Move to the bottom of the list until later</div>
                </div>
                <span className="mobile-action-tag">{isSnoozed ? 'Snoozed' : 'Off'}</span>
              </button>

              {onOpenSubscriptionsModal && (
                <button
                  type="button"
                  className="mobile-action-item"
                  onClick={() => {
                    setShowMobileActions(false);
                    onOpenSubscriptionsModal();
                  }}
                >
                  <span className="mobile-action-icon">💳</span>
                  <div className="mobile-action-info">
                    <div className="mobile-action-label">Subscriptions & Vendor Usage</div>
                    <div className="mobile-action-desc">Manage API keys and check token limits</div>
                  </div>
                </button>
              )}

              <button
                type="button"
                className="mobile-action-item"
                onClick={() => {
                  setShowMobileActions(false);
                  if (session.isAgentRunning !== false) {
                    handleStopAgent();
                  } else {
                    handleStartAgent();
                  }
                }}
              >
                <span className="mobile-action-icon">{session.isAgentRunning !== false ? '⏹' : '▶'}</span>
                <div className="mobile-action-info">
                  <div
                    className="mobile-action-label"
                    style={{ color: session.isAgentRunning !== false ? '#f87171' : '#34d399' }}
                  >
                    {session.isAgentRunning !== false ? 'Stop Agent Subprocess' : 'Resume Agent Subprocess'}
                  </div>
                  <div className="mobile-action-desc">
                    {session.isAgentRunning !== false
                      ? 'Terminate background process and free CPU/memory; history is kept'
                      : 'Spawns agent background process and terminal'}
                  </div>
                </div>
              </button>

              <button
                type="button"
                className="mobile-action-item danger"
                onClick={() => {
                  setShowMobileActions(false);
                  handleDelete();
                }}
              >
                <span className="mobile-action-icon">🗑</span>
                <div className="mobile-action-info">
                  <div className="mobile-action-label" style={{ color: '#f87171' }}>Delete Session</div>
                  <div className="mobile-action-desc">Permanently remove this agent session</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox / Modal for enlarged image preview */}
      {previewImage && (
        <div className="modal-overlay image-preview-overlay" onClick={() => setPreviewImage(null)} style={{ zIndex: 1300 }}>
          <div className="image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="image-preview-close"
              onClick={() => setPreviewImage(null)}
              title="Close image"
            >
              ✕
            </button>
            <img src={previewImage} alt="Enlarged preview" className="image-preview-full" />
          </div>
        </div>
      )}
    </div>
  );
};
