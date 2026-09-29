import React, { useMemo, useEffect, useRef } from 'react';
import { marked } from 'marked';
import { escapeHtml, sanitizeHtml } from '../sanitize';
import { copyToClipboard } from '../toolDisplay';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Static, trusted markup for the copy button (the lucide "copy" and "check" strokes).
const svg = (body: string) =>
  `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const COPY_ICON = svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
const CHECK_ICON = svg('<polyline points="20 6 9 17 4 12"/>');

function setCopyLabel(btn: HTMLButtonElement, copied: boolean) {
  btn.innerHTML = `${copied ? CHECK_ICON : COPY_ICON}<span>${copied ? 'Copied' : 'Copy'}</span>`;
  btn.classList.toggle('is-copied', copied);
  btn.setAttribute('aria-label', copied ? 'Copied' : 'Copy code');
}

/** Language from marked's `language-xxx` class on the fenced block's <code>. */
function languageOf(code: Element | null): string | null {
  const cls = code?.className.match(/(?:^|\s)language-([\w+#.-]+)/);
  return cls ? cls[1] : null;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      return sanitizeHtml(
        marked.parse(content, {
          gfm: true,
          breaks: true,
        }) as string
      );
    } catch (err) {
      console.error('Failed to parse markdown:', err);
      return `<pre>${escapeHtml(content)}</pre>`;
    }
  }, [content]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const timers: number[] = [];

    // Links open in a new tab, without handing the page an opener.
    root.querySelectorAll('a').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    // Wide tables scroll inside their own box instead of stretching the column.
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('md-table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    // Code blocks get a frame: a language header when the fence names one, and a copy button.
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('md-code')) return;
      const code = pre.querySelector('code');
      const lang = languageOf(code);

      const frame = document.createElement('div');
      frame.className = `md-code${lang ? ' has-lang' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-code-copy';
      btn.title = 'Copy code to clipboard';
      setCopyLabel(btn, false);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = (code ? code.textContent || '' : pre.textContent || '').replace(/\n$/, '');
        if (await copyToClipboard(text)) {
          setCopyLabel(btn, true);
          timers.push(window.setTimeout(() => setCopyLabel(btn, false), 1800));
        }
      });

      pre.replaceWith(frame);
      if (lang) {
        const head = document.createElement('div');
        head.className = 'md-code-head';
        const label = document.createElement('span');
        label.className = 'md-code-lang';
        label.textContent = lang;
        head.append(label, btn);
        frame.append(head, pre);
      } else {
        frame.append(pre, btn);
      }
    });

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`prose markdown-content ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
