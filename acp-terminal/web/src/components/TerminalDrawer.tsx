import React, { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl } from '../api';
import { useTheme } from '../design/theme';
import { Button, StatusDot, type Tone } from '../ui';

interface TerminalDrawerProps {
  terminalId?: string;
  sessionId: string;
}

type ConnState =
  | { kind: 'connecting' }
  | { kind: 'starting' }
  | { kind: 'connected' }
  | { kind: 'disconnected' }
  | { kind: 'exited'; code: number | null }
  | { kind: 'error'; message: string };

function isLightTheme(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr === 'light';
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** xterm can't read CSS variables, so resolve the design tokens into concrete colours. */
function readXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const light = isLightTheme();
  const bg = v('--surface-inset');
  return {
    background: bg,
    foreground: v('--text'),
    cursor: v('--accent'),
    cursorAccent: bg,
    selectionBackground: v('--selection'),
    // Map the ANSI palette onto the status tokens so coloured output stays
    // legible in both themes (white-on-light and black-on-dark would vanish).
    black: light ? v('--text') : v('--border-strong'),
    brightBlack: v('--text-3'),
    white: light ? v('--border-strong') : v('--text-2'),
    brightWhite: light ? v('--text-2') : v('--text'),
    red: v('--danger'),
    brightRed: v('--danger'),
    green: v('--ok'),
    brightGreen: v('--ok'),
    yellow: v('--warn'),
    brightYellow: v('--warn'),
    blue: v('--info'),
    brightBlue: v('--info'),
    magenta: v('--accent'),
    brightMagenta: v('--accent'),
    cyan: v('--info'),
    brightCyan: v('--info'),
  };
}

function monoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Menlo, monospace';
}

const STATE_LINE: Record<ConnState['kind'], { tone: Tone; pulse?: boolean }> = {
  connecting: { tone: 'accent', pulse: true },
  starting: { tone: 'accent', pulse: true },
  connected: { tone: 'ok' },
  disconnected: { tone: 'neutral' },
  exited: { tone: 'neutral' },
  error: { tone: 'danger' },
};

export const TerminalDrawer: React.FC<TerminalDrawerProps> = ({ terminalId, sessionId }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [conn, setConn] = useState<ConnState>({ kind: 'connecting' });
  // Bumped by "Reconnect" to tear down and re-attach.
  const [attempt, setAttempt] = useState(0);
  const { resolved } = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setConn({ kind: 'connecting' });

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: monoFont(),
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: readXtermTheme(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    termRef.current = term;

    let sent = { cols: 0, rows: 0 };
    const sendSize = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (term.cols === sent.cols && term.rows === sent.rows) return;
      sent = { cols: term.cols, rows: term.rows };
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    // Fit only while the host is laid out. A hidden tab (display: none) has no
    // size; fitting then squashed the PTY to a couple of columns, so the
    // replayed buffer and the prompt rendered as a blank screen, and nothing
    // refitted until the window itself resized.
    let fitted = false;
    const fit = () => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
        fitted = true;
        sendSize();
        connect();
      } catch {
        // The renderer may not be ready yet; the next resize retries.
      }
    };
    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    // Attach to the given terminal, or the session's own interactive shell.
    // Connecting after the first fit means the PTY learns the real size right
    // away; cols/rows ride along so the server can spawn a new shell at that
    // size instead of its 100x30 default (it ignores them today).
    const targetId = terminalId || sessionId;
    let ws: WebSocket | null = null;
    let ended = false;
    let disposed = false;
    const connect = () => {
      if (ws || disposed) return;
      const size = fitted ? `?cols=${term.cols}&rows=${term.rows}` : '';
      const sock = new WebSocket(wsUrl(`/ws/terminal/${encodeURIComponent(targetId)}${size}`));
      ws = sock;
      wsRef.current = sock;
      // A login shell can take a few seconds to print its first prompt; say
      // so rather than showing a blank, silent terminal.
      let gotData = false;
      sock.onopen = () => {
        setConn({ kind: 'starting' });
        sendSize();
      };
      sock.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'data' && msg.data) {
            term.write(msg.data);
            if (!gotData) {
              gotData = true;
              setConn({ kind: 'connected' });
            }
          } else if (msg.type === 'exit') {
            ended = true;
            setConn({ kind: 'exited', code: msg.exitCode ?? null });
          } else if (msg.type === 'error') {
            ended = true;
            setConn({ kind: 'error', message: String(msg.message || 'Terminal error') });
          }
        } catch {
          term.write(event.data);
        }
      };
      sock.onclose = () => {
        if (!ended && !disposed) setConn({ kind: 'disconnected' });
      };
    };
    scheduleFit();
    // Don't wait forever on a container that never gets a size.
    const connectTimer = window.setTimeout(connect, 1500);

    const input = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const focusTimer = window.setTimeout(() => {
      if (host.clientWidth > 0) term.focus();
    }, 80);

    return () => {
      disposed = true;
      window.clearTimeout(focusTimer);
      window.clearTimeout(connectTimer);
      cancelAnimationFrame(frame);
      ro.disconnect();
      input.dispose();
      ws?.close();
      wsRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [terminalId, sessionId, attempt]);

  // Follow the app theme live: the theme hook covers the in-app toggle and the
  // OS setting, the observer covers anything else that flips data-theme.
  useEffect(() => {
    const retheme = () => {
      if (termRef.current) termRef.current.options.theme = readXtermTheme();
    };
    retheme();
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', retheme);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', retheme);
    };
  }, [resolved, attempt]);

  const line = STATE_LINE[conn.kind];
  const label =
    conn.kind === 'connecting'
      ? 'Connecting to your shell…'
      : conn.kind === 'starting'
        ? 'Starting your shell…'
        : conn.kind === 'connected'
        ? 'Connected'
        : conn.kind === 'disconnected'
          ? 'Disconnected. The shell may still be running on the server.'
          : conn.kind === 'exited'
            ? `Shell exited${conn.code != null ? ` with code ${conn.code}` : ''}.`
            : `Couldn't attach: ${conn.message}`;

  return (
    <div className={`xterm-frame is-${conn.kind}`}>
      <div className="xterm-status" role="status" aria-live="polite">
        <StatusDot tone={line.tone} pulse={line.pulse} />
        <span className="xterm-status-text">{label}</span>
        {(conn.kind === 'disconnected' || conn.kind === 'exited' || conn.kind === 'error') && (
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
            {conn.kind === 'exited' ? 'Start a new shell' : 'Reconnect'}
          </Button>
        )}
      </div>
      <div className="xterm-pad" onClick={() => termRef.current?.focus()}>
        <div ref={hostRef} className="terminal-container" />
      </div>
    </div>
  );
};
