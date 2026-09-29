import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl } from '../api';

interface TerminalDrawerProps {
  terminalId?: string;
  sessionId: string;
}

export const TerminalDrawer: React.FC<TerminalDrawerProps> = ({ terminalId, sessionId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#090a0d',
        foreground: '#e5e7eb',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    const handleResize = () => {
      try {
        fitAddon.fit();
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      } catch {
        // ignore fit resize error
      }
    };

    window.addEventListener('resize', handleResize);

    // Attach to active terminal or dedicated interactive workspace session shell
    const targetId = terminalId || sessionId;
    const ws = new WebSocket(wsUrl(`/ws/terminal/${encodeURIComponent(targetId)}`));
    wsRef.current = ws;

    ws.onopen = () => {
      try {
        fitAddon.fit();
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data' && msg.data) {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          term.writeln(`\r\n\x1b[33m[Process completed with exit code ${msg.exitCode}]\x1b[0m\r\n`);
        } else if (msg.type === 'error') {
          term.writeln(`\r\n\x1b[31m[Terminal error: ${msg.message}]\x1b[0m\r\n`);
        }
      } catch {
        term.write(event.data);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Auto-focus terminal on mount so user can immediately type
    const focusTimer = setTimeout(() => {
      try {
        fitAddon.fit();
        term.focus();
      } catch {
        // ignore
      }
    }, 80);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, [terminalId, sessionId]);

  return <div ref={containerRef} className="terminal-container" style={{ height: '100%', width: '100%' }} />;
};
