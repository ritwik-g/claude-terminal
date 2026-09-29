import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { sessionManager } from './acp/session-mgr.js';
import { ptyManager } from './pty-manager.js';
import { store } from './store.js';
import { getOrCreateToken } from './paths.js';

export function setupWebSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/ws' || pathname.startsWith('/ws/terminal/')) {
      const ip = request.socket.remoteAddress;
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!isLoopback) {
        const token = getOrCreateToken();
        const reqToken = url.searchParams.get('token') || (request.headers['x-acp-token'] as string);
        if (!reqToken || reqToken !== token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const sessionClients = new Set<WebSocket>();

  // Relay session events to all active connected web clients
  sessionManager.on('sessionsUpdated', (sessions) => {
    const msg = JSON.stringify({ type: 'sessionsUpdated', sessions });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('sessionStream', (payload) => {
    const msg = JSON.stringify({
      type: 'sessionStream',
      event: payload.type,
      sessionId: payload.sessionId,
      session: payload.session,
      text: payload.text,
      turn: payload.turn,
      toolCall: payload.toolCall,
      usage: payload.usage,
      rateLimits: payload.rateLimits,
      promptSuggestion: payload.promptSuggestion,
    });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('permissionRequested', (payload) => {
    const msg = JSON.stringify({ type: 'permissionRequested', ...payload });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  sessionManager.on('permissionResolved', (payload) => {
    const msg = JSON.stringify({ type: 'permissionResolved', ...payload });
    for (const ws of sessionClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Terminal attachment stream: /ws/terminal/:terminalId (or /ws/terminal/:sessionId)
    if (pathname.startsWith('/ws/terminal/')) {
      const targetId = pathname.slice('/ws/terminal/'.length);
      let term = ptyManager.getTerminal(targetId);

      // If targetId is not an active transient terminal, check if it is a session ID
      if (!term) {
        const session = store.get(targetId);
        if (session) {
          term = ptyManager.getOrCreateSessionTerminal(session.id, session.cwd);
        }
      }

      if (!term) {
        ws.send(JSON.stringify({ type: 'error', message: 'Terminal not found' }));
        ws.close();
        return;
      }

      const termId = term.id;

      // Replay existing output buffer
      if (term.outputBuffer) {
        ws.send(JSON.stringify({ type: 'data', data: term.outputBuffer }));
      }

      const onData = (evt: { id: string; data: string }) => {
        if (evt.id === termId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data: evt.data }));
        }
      };

      const onExit = (evt: { id: string; exitCode: number | null }) => {
        if (evt.id === termId && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', exitCode: evt.exitCode }));
        }
      };

      ptyManager.on('data', onData);
      ptyManager.on('exit', onExit);

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input' && typeof msg.data === 'string') {
            ptyManager.write(termId, msg.data);
          } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            ptyManager.resize(termId, msg.cols, msg.rows);
          }
        } catch {
          // ignore malformed message
        }
      });

      ws.on('close', () => {
        ptyManager.off('data', onData);
        ptyManager.off('exit', onExit);
      });

      return;
    }

    // Default: Session management stream
    sessionClients.add(ws);

    // Send initial snapshot
    ws.send(JSON.stringify({
      type: 'initial',
      sessions: sessionManager.listSessions(),
    }));

    ws.on('close', () => {
      sessionClients.delete(ws);
    });
  });
}
