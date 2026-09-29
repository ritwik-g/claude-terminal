import React, { useState, useEffect, useRef } from 'react';
import type { AcpSession, AgentDescriptor } from '../types';
import { api } from '../api';
import { useEscapeLayer } from '../hooks';
import { LiveTerminalPanel } from './LiveTerminalPanel';
import { ActivityStrip } from './ActivityStrip';
import { UsageTab } from './UsageTab';
import { sessionPricing } from '../pricing';
import { commandOf, isShellCall } from '../toolDisplay';
import { getModelMeta } from './AgentModelPicker';
import type { MenuItem } from './Menu';
import { SessionHeader, SessionTabsBar, type WorkspaceTab } from './SessionHeader';
import { ApprovalBanner } from './ApprovalBanner';
import { ConversationView, type RollbackAction } from './ConversationView';
import { Composer } from './Composer';
import { MobileActionSheet } from './MobileActionSheet';
import { ImageLightbox } from './ImageLightbox';
import { nextPriority } from './sessionMeta';

// Other areas import these from here.
export { STATE_LABEL, formatTime, nextPriority } from './sessionMeta';

interface SessionDetailProps {
  session: AcpSession;
  agents: AgentDescriptor[];
  onRefresh: () => void;
  onOpenSwitchModal: () => void;
  onOpenSubscriptionsModal?: () => void;
  onOpenMcp?: () => void;
  onBackToList?: () => void;
  onDeleted?: (id: string) => void;
  totalSessionsCount?: number;
}

/** The session workspace: header, tabs, conversation / terminal / usage, and the composer. */
export const SessionDetail: React.FC<SessionDetailProps> = ({
  session,
  agents,
  onRefresh,
  onOpenSwitchModal,
  onOpenSubscriptionsModal,
  onOpenMcp,
  onBackToList,
  onDeleted,
  totalSessionsCount,
}) => {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('conversation');
  const [showMobileActions, setShowMobileActions] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [rollingBack, setRollingBack] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  useEscapeLayer(Boolean(previewImage), () => setPreviewImage(null));
  useEscapeLayer(showMobileActions, () => setShowMobileActions(false));
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPromptText('');
  }, [session.id]);

  const shellCommandCount = session.turns.reduce(
    (n, t) => n + (t.toolCalls || []).filter((c) => isShellCall(c) && Boolean(commandOf(c))).length,
    0
  );

  // ------------------------------------------------------------- Handlers
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

  const handleApproveAndAutoApprove = async () => {
    await api.updateAnnotations(session.id, { autoApprove: true });
    const allowOpt = session.pendingPermission?.options.find(
      (o) => !o.optionId.includes('deny') && !o.optionId.includes('reject')
    );
    await handleResolvePermission(allowOpt?.optionId || 'allow');
  };

  const updateAnnotations = async (patch: Parameters<typeof api.updateAnnotations>[1]) => {
    try {
      await api.updateAnnotations(session.id, patch);
      onRefresh();
    } catch (err: any) {
      alert(`Could not update session: ${err.message}`);
    }
  };

  const handleTogglePriority = () => updateAnnotations({ priority: nextPriority(session.user.priority) });
  const handleTogglePin = () => updateAnnotations({ pinned: !session.user.pinned });
  const handleToggleCleanup = () => updateAnnotations({ cleanup: !session.user.cleanup });
  const isSnoozed = Boolean(session.user.snoozedUntil && session.user.snoozedUntil > Date.now());
  // Snoozing drops the session to the bottom of the ranking for an hour; the
  // server wakes it automatically when the time is up.
  const handleToggleSnooze = () => updateAnnotations({ snoozedUntil: isSnoozed ? null : Date.now() + 60 * 60 * 1000 });
  const handleToggleAutoApprove = () => updateAnnotations({ autoApprove: !session.user.autoApprove });

  const handleRename = async (next: string): Promise<boolean> => {
    try {
      await api.renameSession(session.id, next);
      onRefresh();
      return true;
    } catch (err: any) {
      alert(`Could not rename session: ${err.message}`);
      return false;
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

  const handleRollback = async (turnId?: string, action: RollbackAction = 'revert_to_this') => {
    if (rollingBack) return;
    if (action === 'undo_last') {
      if (!confirm('Undo the last message/turn in this conversation?')) return;
    } else if (action === 'revert_to_this') {
      if (!confirm('Rewind conversation to this point? All subsequent messages will be undone.')) return;
    } else if (action === 'revert_before_this' && turnId) {
      const idx = session.turns.findIndex((t) => t.id === turnId);
      const isUser = idx !== -1 && session.turns[idx].role === 'user';
      if (!isUser && !confirm('Delete this turn and all subsequent messages?')) return;
    }

    setRollingBack(true);
    try {
      const res = await api.rollbackSession(session.id, { turnId, action });
      if (res.restoredPrompt) {
        setPromptText(res.restoredPrompt);
        setTimeout(() => promptInputRef.current?.focus(), 50);
      }
      onRefresh();
    } catch (err: any) {
      alert(`Failed to undo: ${err.message}`);
    } finally {
      setRollingBack(false);
    }
  };

  /** Commands the terminal runs itself instead of sending to the agent. */
  const runLocalCommand = async (command: string): Promise<boolean> => {
    switch (command) {
      case '/compact':
        setPromptText('');
        await handleCompactSession();
        return true;
      case '/undo':
        setPromptText('');
        await handleRollback(undefined, 'undo_last');
        return true;
      case '/stop':
        setPromptText('');
        await handleStopAgent();
        return true;
      case '/auto':
      case '/approval':
        setPromptText('');
        await handleToggleAutoApprove();
        return true;
      case '/switch':
        setPromptText('');
        onOpenSwitchModal();
        return true;
      case '/model':
        setPromptText('');
        setShowModelPicker(true);
        return true;
      case '/mcp':
        if (!onOpenMcp) return false;
        setPromptText('');
        onOpenMcp();
        return true;
      case '/stats':
        if (!onOpenSubscriptionsModal) return false;
        setPromptText('');
        onOpenSubscriptionsModal();
        return true;
      default:
        return false;
    }
  };

  // ---------------------------------------------------------------- Usage
  const pricing = sessionPricing(session);
  const inputTokens = session.usage?.inputTokens || 0;
  const outputTokens = session.usage?.outputTokens || 0;
  const contextTokens = session.usage?.contextTokens || inputTokens;
  const estimatedCost = (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;

  const currentModelMeta = getModelMeta(session.model || 'sonnet');
  const activeEffort = session.effort || 'medium';

  const menuItems: Array<MenuItem | 'divider'> = [
    {
      label: 'Undo last turn',
      icon: 'undo',
      onSelect: () => handleRollback(undefined, 'undo_last'),
      disabled: session.turns.length === 0 || rollingBack,
    },
    {
      label: compacting ? 'Compacting…' : 'Compact context',
      icon: 'archive',
      onSelect: handleCompactSession,
      disabled: session.turns.length <= 1 || compacting,
    },
    { label: isSnoozed ? 'Wake session' : 'Snooze for 1 hour', icon: 'moon', onSelect: handleToggleSnooze },
    { label: session.user.cleanup ? 'Unmark cleanup' : 'Mark for cleanup', icon: 'check', onSelect: handleToggleCleanup, hint: 'c' },
    'divider',
    { label: 'Delete session', icon: 'trash', onSelect: handleDelete, danger: true },
  ];

  return (
    <div className="main-view ws-root">
      <SessionHeader
        session={session}
        onRename={handleRename}
        onToggleAutoApprove={handleToggleAutoApprove}
        onOpenSwitchModal={onOpenSwitchModal}
        onStopAgent={handleStopAgent}
        onStartAgent={handleStartAgent}
        onTogglePriority={handleTogglePriority}
        onTogglePin={handleTogglePin}
        menuItems={menuItems}
        onBackToList={onBackToList}
        totalSessionsCount={totalSessionsCount}
        onOpenMobileActions={() => setShowMobileActions(true)}
        onOpenMcp={onOpenMcp}
      />

      <SessionTabsBar
        activeTab={activeTab}
        onChange={setActiveTab}
        shellCommandCount={shellCommandCount}
        contextTokens={contextTokens}
        contextWindow={pricing.contextWindow}
        estimatedCost={estimatedCost}
      />

      <div className="ws-body">
        {activeTab === 'conversation' ? (
          <>
            <ActivityStrip session={session} />
            <ConversationView
              session={session}
              onRollback={handleRollback}
              onPreviewImage={setPreviewImage}
              onCancelPrompt={handleCancelPrompt}
              onInsertPrompt={(text) => {
                setPromptText(text);
                promptInputRef.current?.focus();
              }}
            />
          </>
        ) : activeTab === 'terminal' ? (
          <LiveTerminalPanel session={session} />
        ) : (
          <UsageTab
            session={session}
            onOpenSubscriptionsModal={onOpenSubscriptionsModal}
            onCompact={handleCompactSession}
            compacting={compacting}
          />
        )}
      </div>

      <Composer
        session={session}
        agents={agents}
        promptText={promptText}
        setPromptText={setPromptText}
        inputRef={promptInputRef}
        showModelPicker={showModelPicker}
        setShowModelPicker={setShowModelPicker}
        runLocalCommand={runLocalCommand}
        onCancelPrompt={handleCancelPrompt}
        onRefresh={onRefresh}
        onOpenSwitchModal={onOpenSwitchModal}
        above={
          session.pendingPermission && (
            <ApprovalBanner
              permission={session.pendingPermission}
              onResolve={handleResolvePermission}
              onApproveAndAutoApprove={handleApproveAndAutoApprove}
            />
          )
        }
      />

      {showMobileActions && (
        <MobileActionSheet
          session={session}
          modelLabel={`${currentModelMeta.label || session.model || session.agentName}${currentModelMeta.supportsEffort ? `, ${activeEffort} effort` : ''}`}
          isSnoozed={isSnoozed}
          rollingBack={rollingBack}
          compacting={compacting}
          onClose={() => setShowMobileActions(false)}
          onToggleAutoApprove={handleToggleAutoApprove}
          onOpenModelPicker={() => setShowModelPicker(true)}
          onOpenSwitchModal={onOpenSwitchModal}
          onUndoLast={() => handleRollback(undefined, 'undo_last')}
          onCompact={handleCompactSession}
          onTogglePriority={handleTogglePriority}
          onTogglePin={handleTogglePin}
          onToggleCleanup={handleToggleCleanup}
          onToggleSnooze={handleToggleSnooze}
          onOpenSubscriptionsModal={onOpenSubscriptionsModal}
          onOpenMcp={onOpenMcp}
          onStopAgent={handleStopAgent}
          onStartAgent={handleStartAgent}
          onDelete={handleDelete}
        />
      )}

      {previewImage && <ImageLightbox src={previewImage} onClose={() => setPreviewImage(null)} />}
    </div>
  );
};
