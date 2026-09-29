import React, { useMemo, useEffect, useRef } from 'react';
import { marked } from 'marked';
import { escapeHtml, sanitizeHtml } from '../sanitize';

interface MarkdownContentProps {
  content: string;
  className?: string;
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
    if (!containerRef.current) return;

    // Enhance links to open in a new tab safely
    const links = containerRef.current.querySelectorAll('a');
    links.forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    // Add interactive copy buttons to all code blocks
    const preBlocks = containerRef.current.querySelectorAll('pre');
    preBlocks.forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;

      const codeEl = pre.querySelector('code');
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.type = 'button';
      copyBtn.innerHTML = '<span>📋</span> <span>Copy</span>';
      copyBtn.title = 'Copy code to clipboard';

      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const textToCopy = (codeEl ? codeEl.innerText : pre.innerText).trimEnd();
        try {
          await navigator.clipboard.writeText(textToCopy);
          copyBtn.innerHTML = '<span>✓</span> <span>Copied!</span>';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = '<span>📋</span> <span>Copy</span>';
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch {
          const textArea = document.createElement('textarea');
          textArea.value = textToCopy;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
          copyBtn.innerHTML = '<span>✓</span> <span>Copied!</span>';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = '<span>📋</span> <span>Copy</span>';
            copyBtn.classList.remove('copied');
          }, 2000);
        }
      });

      pre.style.position = 'relative';
      pre.appendChild(copyBtn);
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
