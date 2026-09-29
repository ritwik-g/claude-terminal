import React, { useState, useEffect, useRef } from 'react';
import type { AgentDescriptor } from '../types';
import { api, isHostMachine } from '../api';
import { Button, Field, Icon, Input, Kbd, Textarea } from '../ui';
import { AgentModelPicker } from './AgentModelPicker';
import { FolderBrowserModal } from './FolderBrowserModal';
import { Modal } from './Modal';

interface NewSessionModalProps {
  agents: AgentDescriptor[];
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

const FORM_ID = 'new-session-form';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** Absolute POSIX or Windows path, or one under the home folder. */
const looksAbsolute = (p: string) => /^(\/|~|[A-Za-z]:[\\/]|\\\\)/.test(p);

/** Server errors about the folder belong on the folder field, not in the banner. */
const isFolderError = (msg: string) => /working directory|cwd|no such file|not a directory|ENOENT/i.test(msg);

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  agents,
  onClose,
  onCreated,
}) => {
  const [selectedAgent, setSelectedAgent] = useState<string>(agents[0]?.id || 'claude');
  const currentAgent = agents.find((a) => a.id === selectedAgent) || agents[0];
  const [selectedModel, setSelectedModel] = useState<string>(currentAgent?.defaultModel || '');
  const [cwd, setCwd] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [initialPrompt, setInitialPrompt] = useState<string>('');
  const [suggestedFolders, setSuggestedFolders] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<string | null>(null);

  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [isNativeBrowsing, setIsNativeBrowsing] = useState(false);
  const cwdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (agents.length > 0 && (!selectedAgent || !agents.some((a) => a.id === selectedAgent))) {
      const first = agents[0];
      setSelectedAgent(first.id);
      setSelectedModel(first.defaultModel || '');
    }
  }, [agents]);

  useEffect(() => {
    if (currentAgent?.defaultModel && (!selectedModel || !currentAgent.availableModels?.includes(selectedModel))) {
      setSelectedModel(currentAgent.defaultModel);
    }
  }, [selectedAgent]);

  useEffect(() => {
    api.getFolders().then((res) => {
      // Prefill with the most recent project rather than $HOME, and never
      // overwrite a path the user already started typing.
      setCwd((prev) => prev || res.recent?.[0] || res.current);
      setSuggestedFolders(res.entries);
      if (res.recent && res.recent.length > 0) {
        setRecentWorkspaces(res.recent);
      }
    }).catch(() => {});
  }, []);

  const chooseCwd = (path: string) => {
    setCwd(path);
    setCwdError(null);
  };

  const handleNativeFinder = async () => {
    setIsNativeBrowsing(true);
    try {
      const res = await api.browseNativeFolder();
      if (res.selected) {
        chooseCwd(res.selected);
      }
    } catch (err: any) {
      console.warn('Native folder selection error:', err);
    } finally {
      setIsNativeBrowsing(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    const path = cwd.trim();
    if (!path) {
      setCwdError('Choose the folder the agent should work in.');
      cwdRef.current?.focus();
      return;
    }
    if (!looksAbsolute(path)) {
      setCwdError('Use a full path, such as /Users/you/projects/my-app.');
      cwdRef.current?.focus();
      return;
    }
    setLoading(true);
    setError(null);
    setCwdError(null);

    try {
      const res = await api.createSession({
        agentId: selectedAgent,
        model: selectedModel || undefined,
        cwd: path,
        title: title.trim() || undefined,
        initialPrompt: initialPrompt.trim() || undefined,
      });
      onCreated(res.session.id);
    } catch (err: any) {
      const msg: string = err.message || 'The session could not be started.';
      if (isFolderError(msg)) {
        const missing = /^Working directory does not exist:\s*(.+)$/i.exec(msg);
        setCwdError(
          missing
            ? `There's no folder at ${missing[1]}. Check the path or choose another folder.`
            : `${msg}. Check the path or choose another folder.`
        );
        cwdRef.current?.focus();
      } else {
        setError(msg);
      }
      setLoading(false);
    }
  };

  const recent = recentWorkspaces.slice(0, 6);
  const quickPick = recentWorkspaces.length === 0 ? suggestedFolders.slice(0, 6) : [];

  return (
    <>
      <Modal
        onClose={onClose}
        size="md"
        icon="plus"
        heading="New session"
        description="Pick an agent and the project it should work in."
        bodyClassName="ns-body"
        footerStart={
          <span className="dlg-hint">
            <Kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>Enter</Kbd>
            <span>to start</span>
          </span>
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={FORM_ID} loading={loading} icon="play">
              {loading ? 'Starting…' : 'Start session'}
            </Button>
          </>
        }
      >
        <form
          id={FORM_ID}
          className="dlg-form"
          onSubmit={handleSubmit}
          noValidate
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
          {error && (
            <div className="dlg-callout tone-danger" role="alert">
              <Icon name="alert" size={15} />
              <div className="dlg-callout-text">
                <strong>The session didn't start.</strong>
                <span>{error}</span>
              </div>
            </div>
          )}

          <AgentModelPicker
            agents={agents}
            selectedAgentId={selectedAgent}
            selectedModel={selectedModel}
            onAgentChange={(id) => setSelectedAgent(id)}
            onModelChange={(model) => setSelectedModel(model)}
            disabled={loading}
          />

          <div className="ns-cwd-group">
            <Field
              label="Project folder"
              htmlFor="ns-cwd"
              aside="On the host machine"
              error={cwdError}
            >
              <div className="ns-cwd-row">
                <div className={`dlg-input-icon${cwdError ? ' is-invalid' : ''}`}>
                  <Icon name="folder" size={14} />
                  <Input
                    ref={cwdRef}
                    id="ns-cwd"
                    mono
                    value={cwd}
                    onChange={(e) => {
                      setCwd(e.target.value);
                      if (cwdError) setCwdError(null);
                    }}
                    placeholder="/Users/you/projects/my-app"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!cwdError || undefined}
                    disabled={loading}
                  />
                </div>
                <Button icon="folder" onClick={() => setShowFolderBrowser(true)} disabled={loading} title="Browse folders on the host">
                  Browse
                </Button>
                {isHostMachine() && (
                  <Button
                    icon="external"
                    onClick={handleNativeFinder}
                    loading={isNativeBrowsing}
                    disabled={loading}
                    title="Pick a folder with the macOS Finder dialog"
                  >
                    Finder
                  </Button>
                )}
              </div>
            </Field>
            {(recent.length > 0 || quickPick.length > 0) && (
              <div className="dlg-chips" role="group" aria-label={recent.length > 0 ? 'Recent projects' : 'Folders in your home folder'}>
                <span className="dlg-eyebrow">{recent.length > 0 ? 'Recent' : 'Suggested'}</span>
                {recent.map((ws) => (
                  <button
                    key={ws}
                    type="button"
                    className={`dlg-chip${cwd === ws ? ' is-selected' : ''}`}
                    aria-pressed={cwd === ws}
                    onClick={() => chooseCwd(ws)}
                    title={ws}
                    disabled={loading}
                  >
                    <Icon name="folder" size={12} />
                    {baseName(ws)}
                  </button>
                ))}
                {quickPick.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`dlg-chip${cwd === f.path ? ' is-selected' : ''}`}
                    aria-pressed={cwd === f.path}
                    onClick={() => chooseCwd(f.path)}
                    title={f.path}
                    disabled={loading}
                  >
                    <Icon name="folder" size={12} />
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Field label="Title" htmlFor="ns-title" aside="Optional">
            <Input
              id="ns-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Refactor the API routes"
              disabled={loading}
            />
          </Field>

          <Field
            label="First message"
            htmlFor="ns-prompt"
            aside="Optional"
            hint="Sent to the agent as soon as the session starts."
          >
            <Textarea
              id="ns-prompt"
              rows={3}
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="What should the agent work on first?"
              disabled={loading}
            />
          </Field>
        </form>
      </Modal>
      {showFolderBrowser && (
        <FolderBrowserModal
          initialPath={cwd}
          onSelect={(selectedPath) => chooseCwd(selectedPath)}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </>
  );
};
