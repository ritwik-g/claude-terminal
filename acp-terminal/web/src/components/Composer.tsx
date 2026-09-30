import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AcpSession, AgentDescriptor, FileAttachment, SlashCommandItem } from '../types';
import { api } from '../api';
import { useEscapeLayer } from '../hooks';
import { Button, Icon, IconButton, Kbd } from '../ui';
import { VendorIcon } from './VendorLogos';
import { getModelMeta } from './AgentModelPicker';
import { advertisedModelLabel } from '../effort';
import { ApprovalPicker, EffortPicker } from './ComposerPickers';
import { getSlashCommandsForAgent, filterSlashCommands } from '../slashCommands';
import { SlashMenu, type SlashCategory } from './SlashMenu';
import { ModelSwitcher } from './ModelSwitcher';
import { QueuedPrompts } from './QueuedPrompts';
import { AutoCompactControl, isCompacting } from './CompactionCard';
import { cx, formatBytes } from './sessionMeta';
import { MOD_KEY } from './Sidebar';

// The textarea grows with its content up to this share of the viewport.
const MAX_GROW = 0.4;

export const Composer: React.FC<{
  session: AcpSession;
  agents: AgentDescriptor[];
  promptText: string;
  setPromptText: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  showModelPicker: boolean;
  setShowModelPicker: (open: boolean | ((prev: boolean) => boolean)) => void;
  /** Runs a command the terminal handles itself (/compact, /undo…). Resolves true if it did. */
  runLocalCommand: (command: string) => Promise<boolean>;
  onCancelPrompt: () => void;
  onRefresh: () => void;
  onOpenSwitchModal: () => void;
  /** Rendered above the composer card, inside the same column (e.g. the approval banner). */
  above?: React.ReactNode;
}> = ({
  session,
  agents,
  promptText,
  setPromptText,
  inputRef,
  showModelPicker,
  setShowModelPicker,
  runLocalCommand,
  onCancelPrompt,
  onRefresh,
  onOpenSwitchModal,
  above,
}) => {
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilterCategory, setSlashFilterCategory] = useState<SlashCategory>('all');
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEscapeLayer(showModelPicker, () => setShowModelPicker(false));
  useEscapeLayer(showSlashMenu, () => setShowSlashMenu(false));

  useEffect(() => {
    setAttachments([]);
    setShowSlashMenu(false);
    setSelectedSlashIndex(0);
  }, [session.id]);

  // ---------------------------------------------------------------- Autogrow
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * MAX_GROW))}px`;
  }, [promptText, inputRef]);

  // ----------------------------------------------------------- Slash menu
  const availableSlashCommands = useMemo(
    () => getSlashCommandsForAgent(session.agentId, session.agentCommands),
    [session.agentId, session.agentCommands]
  );
  const slashQuery = useMemo(() => {
    if (!promptText.startsWith('/')) return '';
    const match = promptText.match(/^\/(\S*)/);
    return match ? match[1] : '';
  }, [promptText]);
  const filteredSlashCommands = useMemo(() => {
    let list = filterSlashCommands(availableSlashCommands, slashQuery);
    if (slashFilterCategory !== 'all') list = list.filter((c) => c.category === slashFilterCategory);
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
    if (!showSlashMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (slashMenuRef.current && !slashMenuRef.current.contains(t) && inputRef.current && !inputRef.current.contains(t)) {
        setShowSlashMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showSlashMenu, inputRef]);

  useEffect(() => {
    if (!showModelPicker) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowModelPicker(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [showModelPicker, setShowModelPicker]);

  const handleSelectSlashCommand = async (cmd: SlashCommandItem) => {
    setShowSlashMenu(false);
    if (await runLocalCommand(cmd.command)) return;
    const textToInsert = cmd.command + ' ';
    setPromptText(textToInsert);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(textToInsert.length, textToInsert.length);
    }, 50);
  };

  // ---------------------------------------------------------- Attachments
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
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) processFiles(files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Moving over a child fires dragleave on the parent; only clear when leaving the card.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) processFiles(Array.from(e.dataTransfer.files));
  };

  // ----------------------------------------------------------------- Send
  const handleSendPrompt = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setShowSlashMenu(false);
    const text = promptText.trim();
    if ((!text && attachments.length === 0) || sending) return;

    if (text.startsWith('/') && !text.includes(' ') && (await runLocalCommand(text))) return;

    // While a turn runs this queues behind it; each queued message can still be sent now from the list
    const outgoing = [...attachments];
    setPromptText('');
    setAttachments([]);
    setSending(true);
    try {
      await api.queuePrompt(session.id, text, outgoing.length > 0 ? outgoing : undefined);
    } catch (err: any) {
      alert(`Error sending prompt: ${err.message}`);
      setPromptText(text);
      setAttachments(outgoing);
    } finally {
      setSending(false);
      onRefresh();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    // Plain and Shift+Enter fall through to the textarea as a new line; only Cmd/Ctrl+Enter sends
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendPrompt();
    }
  };

  const currentModelMeta = getModelMeta(session.model || 'sonnet');
  const modelName = advertisedModelLabel(session) || currentModelMeta.label || session.model || session.agentName;
  const compacting = isCompacting(session);
  // A compaction holds the session like a turn: messages queue behind it and Stop ends it
  const working = session.state === 'working' || compacting;
  const agentShort = session.agentName.replace(/ \(ACP\)$/, '');
  // Phones get a shorter placeholder so it fits on one line.
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches;
  const canSend = (promptText.trim().length > 0 || attachments.length > 0) && !sending;

  return (
    <form className="ws-composer-dock" onSubmit={handleSendPrompt}>
      <div className="ws-composer-column">
        {above}
        {session.queuedPrompts && session.queuedPrompts.length > 0 && (
          <QueuedPrompts session={session} onRefresh={onRefresh} />
        )}
        {showSlashMenu && (
          <SlashMenu
            ref={slashMenuRef}
            agentId={session.agentId}
            agentName={session.agentName}
            query={slashQuery}
            commands={filteredSlashCommands}
            totalCount={availableSlashCommands.length}
            category={slashFilterCategory}
            onCategoryChange={(c) => {
              setSlashFilterCategory(c);
              setSelectedSlashIndex(0);
              inputRef.current?.focus();
            }}
            selectedIndex={selectedSlashIndex}
            onHover={setSelectedSlashIndex}
            onSelect={handleSelectSlashCommand}
            onClose={() => {
              setShowSlashMenu(false);
              inputRef.current?.focus();
            }}
          />
        )}

        <div
          className={cx('ws-composer', isDraggingOver && 'is-dragging')}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingOver && (
            <div className="ws-drop-overlay" aria-hidden>
              <Icon name="paperclip" size={18} />
              Drop images or files to attach
            </div>
          )}

          {attachments.length > 0 && (
            <div className="ws-attachments">
              {attachments.map((att) => (
                <div key={att.id} className="ws-attachment">
                  {att.isImage ? (
                    <img src={att.data} alt="" className="ws-attachment-thumb" />
                  ) : (
                    <span className="ws-attachment-thumb is-file">
                      <Icon name="file" size={15} />
                    </span>
                  )}
                  <span className="ws-attachment-text">
                    <span className="ws-attachment-name" title={att.name}>
                      {att.name}
                    </span>
                    <span className="ws-attachment-size">{formatBytes(att.size)}</span>
                  </span>
                  <IconButton
                    icon="x"
                    size="sm"
                    label={`Remove ${att.name}`}
                    className="ws-attachment-remove"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  />
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={inputRef}
            className="ws-textarea"
            rows={1}
            placeholder={
              session.promptSuggestion
                ? `${session.promptSuggestion}  (Tab to use it)`
                : attachments.length > 0
                ? `Add a message, or press ${MOD_KEY} Enter to send the attachments`
                : compacting
                ? 'Queue a message for when compaction finishes'
                : working
                ? 'Queue a message for when the agent finishes'
                : narrow
                ? `Message ${agentShort}`
                : `Message ${agentShort}, or type / for commands`
            }
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={sending}
            aria-label="Message"
          />

          <div className="ws-composer-toolbar">
            <div className="ws-composer-tools">
              <div className="ws-model-anchor" ref={pickerRef}>
                <button
                  type="button"
                  className={cx('ws-model-pill', showModelPicker && 'is-open')}
                  onClick={() => setShowModelPicker((prev) => !prev)}
                  aria-haspopup="dialog"
                  aria-expanded={showModelPicker}
                  title="Switch model for your next messages"
                >
                  <VendorIcon agentId={session.agentId} size={14} />
                  <span className="ws-model-pill-name">{modelName}</span>
                  <Icon name="chevronDown" size={12} className="ws-model-pill-chevron" />
                </button>
                {showModelPicker && (
                  <>
                    <div className="ws-sheet-backdrop" onClick={() => setShowModelPicker(false)} aria-hidden />
                    <ModelSwitcher
                      session={session}
                      agents={agents}
                      onClose={() => setShowModelPicker(false)}
                      onRefresh={onRefresh}
                      onOpenSwitchModal={onOpenSwitchModal}
                    />
                  </>
                )}
              </div>
              <EffortPicker session={session} agents={agents} onChanged={onRefresh} />
              <ApprovalPicker session={session} agents={agents} onChanged={onRefresh} />
              <IconButton
                icon="paperclip"
                label="Attach files"
                title="Attach pictures or files (or paste or drop them here)"
                onClick={() => fileInputRef.current?.click()}
              />
              <button
                type="button"
                className={cx('ui-iconbtn ui-iconbtn-ghost ui-iconbtn-md ws-slash-btn', showSlashMenu && 'is-active')}
                aria-label="Commands"
                aria-expanded={showSlashMenu}
                title={`Browse slash commands for ${agentShort} (or type /)`}
                onClick={() => {
                  setShowSlashMenu(!showSlashMenu);
                  if (!showSlashMenu && !promptText.startsWith('/')) setPromptText('/');
                  inputRef.current?.focus();
                }}
              >
                /
              </button>
              <AutoCompactControl session={session} onChanged={onRefresh} />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="ws-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  if (e.target.files) {
                    processFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }
                }}
              />
            </div>
            <div className="ws-composer-send">
              <span className="ws-composer-hint">
                <Kbd>{MOD_KEY} Enter</Kbd> send <Kbd>Enter</Kbd> new line
              </span>
              {working && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="stop"
                  onClick={onCancelPrompt}
                  title={compacting ? 'Stop compacting; the context stays as it was' : 'Stop the current turn'}
                >
                  Stop
                </Button>
              )}
              <IconButton
                type="submit"
                icon="arrowUp"
                label={working ? `Queue for after this turn (${MOD_KEY} Enter)` : `Send (${MOD_KEY} Enter)`}
                className={cx('ws-send', sending && 'is-sending')}
                disabled={!canSend}
                aria-busy={sending || undefined}
              />
            </div>
          </div>
        </div>
      </div>
    </form>
  );
};
