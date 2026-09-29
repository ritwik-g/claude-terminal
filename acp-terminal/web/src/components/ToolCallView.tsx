import React, { useState, useMemo } from 'react';
import type { ToolCallRecord } from '../types';

export function formatToolOutput(raw: string | undefined): string {
  if (!raw) return '';

  // If raw is a string representation of an object (e.g. from previous sessions)
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') return parsed;
        if (typeof parsed.formatted_output === 'string') return parsed.formatted_output;
        if (typeof parsed.output === 'string') return parsed.output;
        if (typeof parsed.stdout === 'string') return parsed.stdout;
        if (Array.isArray(parsed.content)) {
          return parsed.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
        }
        if (parsed.result !== undefined) {
          return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2);
        }
        return JSON.stringify(parsed, null, 2);
      } catch {
        // Fall back to raw string
      }
    }

    // If it contains literal escaped \n but no real newlines, convert them
    if (raw.includes('\\n') && !raw.includes('\n')) {
      try {
        return JSON.parse(`"${raw}"`);
      } catch {
        return raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      }
    }
  }

  return raw;
}

export const ToolCallView: React.FC<{ toolCall: ToolCallRecord }> = ({ toolCall }) => {
  // Open by default if currently running, collapsed if completed
  const [isOpen, setIsOpen] = useState(toolCall.status === 'running' || toolCall.status === 'pending');
  const [copied, setCopied] = useState(false);

  const input = toolCall.input as any;

  // Synthesize readable title
  let displayTitle = toolCall.title;
  if (!displayTitle || displayTitle === 'Tool Call') {
    if (input?.command) {
      displayTitle = `$ ${input.command}`;
    } else if (input?.path) {
      displayTitle = `${toolCall.kind === 'write' ? 'Write' : 'Read'}: ${input.path}`;
    } else if (toolCall.kind) {
      displayTitle = `Tool: ${toolCall.kind}`;
    } else {
      displayTitle = 'Tool Execution';
    }
  }

  const formattedOutput = useMemo(() => formatToolOutput(toolCall.output), [toolCall.output]);
  const lineCount = formattedOutput ? formattedOutput.trim().split('\n').length : 0;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (formattedOutput) {
      navigator.clipboard.writeText(formattedOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isCommand = toolCall.kind === 'execute' || displayTitle.startsWith('$') || Boolean(input?.command);

  return (
    <div className={`tool-call-block ${toolCall.status} ${isOpen ? 'open' : 'collapsed'}`}>
      <div
        className="tool-call-header"
        onClick={() => setIsOpen(!isOpen)}
        title="Click to toggle tool output"
      >
        <div className="tool-call-header-left">
          <span className="tool-icon">{isCommand ? '💻' : '🔧'}</span>
          <span className="tool-call-title" title={displayTitle}>
            {displayTitle}
          </span>
        </div>

        <div className="tool-call-header-right">
          {lineCount > 0 && (
            <span className="tool-line-count">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
          )}
          <span className={`tool-status-tag ${toolCall.status}`}>
            {toolCall.status === 'completed'
              ? '✓ DONE'
              : toolCall.status === 'failed'
              ? '✕ FAILED'
              : '● RUNNING'}
          </span>
          <span className="tool-toggle-arrow">{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>

      {isOpen && (
        <div className="tool-call-body">
          {input?.command && (
            <div className="tool-command-preview">
              <span style={{ color: '#93c5fd', fontWeight: 600 }}>$</span> {input.command}
            </div>
          )}

          {formattedOutput && (
            <div className="tool-output-container">
              <button
                type="button"
                className="tool-copy-btn"
                onClick={handleCopy}
                title="Copy output"
              >
                {copied ? '✓ Copied' : '📋 Copy'}
              </button>
              <pre className="tool-output-box">{formattedOutput}</pre>
            </div>
          )}

          {toolCall.error && (
            <div className="tool-error-box">
              ⚠️ {toolCall.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
