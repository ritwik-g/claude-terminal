import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';

const THEME = {
  background: '#0a0c0f',
  foreground: '#e6e9ef',
  cursor: '#6ea8fe',
  cursorAccent: '#0a0c0f',
  selectionBackground: '#2b4a7d88',
  black: '#0a0c0f', red: '#f2686a', green: '#48c98a', yellow: '#f0a83c',
  blue: '#6ea8fe', magenta: '#c58af9', cyan: '#4fd0d6', white: '#c9d1dc',
  brightBlack: '#5a6373', brightRed: '#ff8a8c', brightGreen: '#6fe0a8',
  brightYellow: '#ffc46a', brightBlue: '#93c0ff', brightMagenta: '#dcb0ff',
  brightCyan: '#7ee6eb', brightWhite: '#f2f5fa',
};

interface Props {
  termId: string;
  onExit?: (code: number) => void;
  onIdentified?: (sessionId: string) => void;
}

export function TerminalPane({ termId, onExit, onIdentified }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const manualReconnect = useRef<(() => void) | null>(null);
  // attachCustomKeyEventHandler returns void in xterm 5.5, so the handler can
  // never be replaced — it would capture searchOpen=false forever and its
  // Escape branch would be dead code, sending \x1b to Claude instead of
  // closing the search box. A ref keeps the live value reachable.
  const searchOpenRef = useRef(false);
  const [query, setQuery] = useState('');
  const [exited, setExited] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      theme: THEME,
      cursorBlink: true,
      // Deep local scrollback: this is the whole reason we hold the PTY
      // ourselves rather than putting tmux in the middle.
      scrollback: 100_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // Claude Code needs Shift+Enter for a newline; CSI-u encoding is what
      // carries that through, and we control both ends here.
      windowsMode: false,
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    searchRef.current = search;

    let closed = false;
    let ws: WebSocket | null = null;

    // Last dimensions the PTY was actually told about. Dragging the sidebar
    // edge fires the ResizeObserver on every frame, and each send is a SIGWINCH
    // to a live Claude Code, which redraws its whole TUI on receipt — 60 a
    // second garbles it. A drag crosses a character-cell boundary a few dozen
    // times at most, so sending only on a real change is both correct and calm.
    let sentCols = 0;
    let sentRows = 0;

    const sendResize = (force = false) => {
      try { fit.fit(); } catch { /* host not laid out yet */ }
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!force && term.cols === sentCols && term.rows === sentRows) return;
      sentCols = term.cols;
      sentRows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    /**
     * The server terminates any socket that misses one 30s ping, so a laptop
     * sleep or any network gap closes it — while the PTY on the other side is
     * completely fine. Without automatic reconnection the pane froze and the
     * only obvious remedy in the UI was Restart, which SIGHUPs a live session
     * and destroys the in-flight turn. Reconnect instead.
     */
    const connect = (isRetry: boolean) => {
      if (closed) return;
      setReconnecting(isRetry);
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/term?id=${encodeURIComponent(termId)}`);

      ws.onopen = () => {
        attemptsRef.current = 0;
        setConnected(true);
        setReconnecting(false);
        // A new socket is a new PTY as far as sizing goes: tell it the size
        // unconditionally, or a reconnect at the same dimensions leaves the
        // far side on whatever default it started with.
        sendResize(true);
      };

      ws.onerror = () => { /* onclose always follows; handled there */ };

      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        // Exponential backoff, capped. A dead PTY will just replay empty
        // history, so retrying is harmless even when the session is gone.
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 10_000);
        attemptsRef.current += 1;
        setReconnecting(true);
        reconnectRef.current = setTimeout(() => connect(true), delay);
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'attach') {
          // On a reconnect the buffer already holds everything up to the drop,
          // and the server replays from the start — reset first or the history
          // is spliced in twice.
          // Only reset when there is history to replace it with. After a
          // terminal is reaped its log is gone and the server replies with an
          // empty history — resetting then blanks the exited session's output
          // under a banner still promising it is there.
          if (isRetry && msg.history) term.reset();
          if (msg.history) term.write(msg.history);
          sendResize(true);
        } else if (msg.type === 'data') {
          term.write(msg.data);
        } else if (msg.type === 'exit') {
          setExited(msg.code ?? 0);
          onExit?.(msg.code ?? 0);
        } else if (msg.type === 'identified') {
          onIdentified?.(msg.sessionId);
        }
      };

      wsRef.current = ws;
    };

    manualReconnect.current = () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      attemptsRef.current = 0;
      const stale = wsRef.current;
      if (stale) {
        // Detach first: a socket still CONNECTING would otherwise fire onclose
        // after we reconnect and schedule a SECOND connection, leaving two live
        // sockets writing into the same terminal.
        stale.onclose = null;
        stale.onmessage = null;
        try { stale.close(); } catch { /* already closed */ }
      }
      connect(true);
    };

    connect(false);

    const dataSub = term.onData((d) => {
      const sock = wsRef.current;
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'input', data: d }));
      }
    });

    // Intercept before xterm swallows it, so Cmd/Ctrl+F opens our search.
    const keySub = term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        setSearchOpen(true);
        return false;
      }
      if (e.type === 'keydown' && e.key === 'Escape' && searchOpenRef.current) {
        setSearchOpen(false);
        return false;
      }
      return true;
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);
    requestAnimationFrame(() => sendResize(true));
    setTimeout(() => { sendResize(); term.focus(); }, 60);

    return () => {
      closed = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      manualReconnect.current = null;
      ro.disconnect();
      dataSub.dispose();
      void keySub;
      try { wsRef.current?.close(); } catch { /* already closing */ }
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
      wsRef.current = null;
    };
    // termId identifies the terminal; remounting on change is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  const runSearch = useCallback((dir: 'next' | 'prev', q: string, incremental = false) => {
    const s = searchRef.current;
    if (!s || !q) return;
    // Highlight every match rather than only moving the selection: across a
    // 100k-line scrollback, a jump with no highlights tells you nothing.
    const opts = {
      caseSensitive: false,
      incremental,
      decorations: {
        matchBackground: '#2b4a7d',
        matchBorder: '#6ea8fe',
        matchOverviewRuler: '#6ea8fe',
        activeMatchBackground: '#6ea8fe',
        activeMatchBorder: '#eaf1ff',
        activeMatchColorOverviewRuler: '#eaf1ff',
      },
    };
    if (dir === 'next') s.findNext(q, opts);
    else s.findPrevious(q, opts);
  }, []);

  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);

  useEffect(() => {
    if (searchOpen) {
      const el = document.getElementById('term-search-input') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    } else {
      searchRef.current?.clearDecorations?.();
      termRef.current?.focus();
    }
  }, [searchOpen]);

  return (
    <div className="term-wrap has-banners">
      {exited !== null && (
        <div className="banner exited">
          Session exited (code {exited}). Its output is still here — use{' '}
          <strong>Restart</strong> to run it again, or <strong>Close</strong> to discard it.
        </div>
      )}
      {!connected && exited === null && attemptsRef.current > 0 && (
        <div className="banner err">
          {reconnecting ? 'Terminal disconnected — reconnecting…' : 'Terminal disconnected.'}
          {' '}The session is still running; nothing has been lost.{' '}
          <button className="btn sm" onClick={() => manualReconnect.current?.()}>
            Reconnect now
          </button>
        </div>
      )}
      {searchOpen && (
        <div className="term-search">
          <input
            id="term-search-input"
            value={query}
            placeholder="find in terminal"
            onChange={(e) => { setQuery(e.target.value); runSearch('next', e.target.value, true); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'prev' : 'next', query); }
              if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); }
            }}
          />
          <button className="btn sm" onClick={() => runSearch('prev', query)} title="Previous (Shift+Enter)">↑</button>
          <button className="btn sm" onClick={() => runSearch('next', query)} title="Next (Enter)">↓</button>
          <button className="btn sm" onClick={() => setSearchOpen(false)} title="Close (Esc)">✕</button>
        </div>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  );
}
