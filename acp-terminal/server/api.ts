import express, { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { hasAgent, listAgents } from './agents/registry.js';
import { AgentNotRunningError, NothingToCompactError, QueuedPromptNotFoundError, sessionManager } from './acp/session-mgr.js';
import { parseAutoCompact } from './compaction.js';
import { TurnInFlightError } from './acp/client-host.js';
import { searchSessions } from './search.js';
import { getGitInfo } from './git.js';
import { store } from './store.js';
import {
  getVendorSubscriptions,
  saveStoredCredentials,
  getUsageSummary,
  calculateSessionCost,
  refreshClaudeRateLimitsAsync,
} from './subscriptions.js';
import { lanAccess } from './lan.js';
import { describeLanAddresses } from './network.js';
import { getOrCreateToken, getUploadsDir } from './paths.js';
import { isLocalClient } from './security.js';
import { mcpRouter } from './mcp/routes.js';
import { advertisedOptions, effortChoicesFor, effortError, isEffortValue } from './acp/agent-options.js';
import { refreshCodexRateLimitsAsync } from './codex-limits.js';

export const apiRouter = Router();

// @types/express v5 types route params as string | string[]; express v4 always gives a string
const sid = (req: Request): string => String(req.params.id);

// Static directory for uploaded files and pictures (under the app dir, so CODEPIT_APP_DIR isolates it)
apiRouter.use('/attachments', express.static(getUploadsDir()));

// App-level MCP servers, presets and the agents' own plugins and skills
apiRouter.use('/mcp', mcpRouter);

// 1. List registered agents
apiRouter.get('/agents', (req: Request, res: Response) => {
  // Absent param -> undefined so the registry's env default (test mode / CODEPIT_ENABLE_MOCK) applies
  const includeMock = req.query.includeMock === undefined ? undefined : req.query.includeMock === 'true';
  // With the effort and model choices each agent last advertised, so pickers show them before a session starts
  res.json({ agents: listAgents(includeMock).map((a) => ({ ...a, advertised: advertisedOptions(a.id) })) });
});

// 2. List attention-ranked sessions
apiRouter.get('/sessions', (_req: Request, res: Response) => {
  res.json({ sessions: sessionManager.listSessions() });
});

// 3. Create a new session
apiRouter.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { agentId, cwd, title, initialPrompt, model } = req.body;
    if (!agentId || !cwd) {
      res.status(400).json({ error: 'agentId and cwd are required' });
      return;
    }
    if (!hasAgent(agentId)) {
      res.status(400).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    if (typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd must be a string' });
      return;
    }
    const targetCwd = path.resolve(cwd.replace(/^~/, os.homedir()));
    let isDir = false;
    try {
      isDir = fs.statSync(targetCwd).isDirectory();
    } catch {
      // missing or unreadable
    }
    if (!isDir) {
      res.status(400).json({ error: `Working directory does not exist: ${targetCwd}` });
      return;
    }
    const session = await sessionManager.createSession({
      agentId,
      cwd: targetCwd,
      title,
      model,
      initialPrompt,
    });
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to start agent: ${err?.message || 'unknown error'}` });
  }
});

// 4. Get full session detail
apiRouter.get('/sessions/:id', (req: Request, res: Response) => {
  const session = sessionManager.getSession(sid(req));
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
});

// 5. Send prompt to session
apiRouter.post('/sessions/:id/prompt', async (req: Request, res: Response) => {
  try {
    const { prompt, attachments } = req.body;
    if (!prompt && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: 'prompt or attachment is required' });
      return;
    }
    const id = sid(req);
    if (!store.get(id)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (sessionManager.isTurnInFlight(id)) {
      res.status(409).json({ error: new TurnInFlightError().message });
      return;
    }
    // sendPrompt runs asynchronously in host
    sessionManager.sendPrompt(id, prompt || '', attachments).catch((err) => {
      console.error(`[api] Error executing prompt for ${id}:`, err);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Queue a prompt behind the running turn (sent at once when the session is free)
apiRouter.post('/sessions/:id/queue', async (req: Request, res: Response) => {
  try {
    const { prompt, attachments } = req.body;
    if (!prompt && (!attachments || attachments.length === 0)) {
      res.status(400).json({ error: 'prompt or attachment is required' });
      return;
    }
    if (!store.get(sid(req))) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(await sessionManager.queuePrompt(sid(req), prompt || '', attachments));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const queueError = (res: Response, err: any) =>
  res.status(err instanceof QueuedPromptNotFoundError ? 404 : 500).json({ error: err.message });

apiRouter.patch('/sessions/:id/queue/:queueId', (req: Request, res: Response) => {
  const { prompt } = req.body;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  try {
    const session = sessionManager.updateQueuedPrompt(sid(req), String(req.params.queueId), prompt);
    res.json({ queuedPrompts: session.queuedPrompts });
  } catch (err: any) {
    queueError(res, err);
  }
});

apiRouter.delete('/sessions/:id/queue/:queueId', (req: Request, res: Response) => {
  try {
    const session = sessionManager.removeQueuedPrompt(sid(req), String(req.params.queueId));
    res.json({ queuedPrompts: session.queuedPrompts });
  } catch (err: any) {
    queueError(res, err);
  }
});

apiRouter.post('/sessions/:id/queue/:queueId/send', async (req: Request, res: Response) => {
  try {
    await sessionManager.sendQueuedNow(sid(req), String(req.params.queueId));
    res.json({ ok: true });
  } catch (err: any) {
    queueError(res, err);
  }
});

// 6. Cancel prompt (stop active turn)
apiRouter.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
  try {
    await sessionManager.cancelPrompt(sid(req));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6b. Stop / Park underlying agent subprocess & terminal
apiRouter.post('/sessions/:id/stop', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.stopSessionAgent(sid(req));
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6c. Start / Resume underlying agent subprocess
apiRouter.post('/sessions/:id/start', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.startSessionAgent(sid(req));
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Resolve permission
apiRouter.post('/sessions/:id/permission', async (req: Request, res: Response) => {
  try {
    const { optionId } = req.body;
    if (!optionId) {
      res.status(400).json({ error: 'optionId is required' });
      return;
    }
    const ok = await sessionManager.resolvePermission(sid(req), optionId);
    res.json({ ok });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Failover / Switch agent
apiRouter.post('/sessions/:id/switch', async (req: Request, res: Response) => {
  try {
    const { targetAgentId, model, archivePrevious, inPlace, customPrompt, skipInitialPrompt, contextMode } = req.body;
    if (!targetAgentId) {
      res.status(400).json({ error: 'targetAgentId is required' });
      return;
    }
    if (!hasAgent(targetAgentId)) {
      res.status(400).json({ error: `Unknown agent: ${targetAgentId}` });
      return;
    }
    const newSession = await sessionManager.switchAgent(sid(req), targetAgentId, {
      model,
      archivePrevious: Boolean(archivePrevious),
      inPlace: Boolean(inPlace),
      customPrompt: customPrompt ? String(customPrompt) : undefined,
      skipInitialPrompt: Boolean(skipInitialPrompt),
      contextMode,
    });
    res.json({ session: newSession });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Rollback / Undo turns in conversation
apiRouter.post('/sessions/:id/rollback', async (req: Request, res: Response) => {
  try {
    const { turnId, action } = req.body;
    const result = await sessionManager.rollbackSession(sid(req), {
      turnId,
      action: action || 'revert_to_this',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact the session's context; returns once it has started, progress streams over the socket
apiRouter.post('/sessions/:id/compact', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.compactSession(sid(req), { force: req.body?.force === true });
    res.json({ session });
  } catch (err: any) {
    const conflict = err instanceof TurnInFlightError || err instanceof NothingToCompactError || err instanceof AgentNotRunningError;
    res.status(conflict ? 409 : 500).json({ error: err.message });
  }
});

// "Compact when finished": { enabled, thresholdPercent }
apiRouter.put('/sessions/:id/auto-compact', (req: Request, res: Response) => {
  const setting = parseAutoCompact(req.body);
  if (!setting) {
    res.status(400).json({ error: 'Expected { enabled: boolean, thresholdPercent: number between 5 and 95 }' });
    return;
  }
  try {
    const session = sessionManager.setAutoCompact(sid(req), setting);
    res.json({ autoCompact: session.autoCompact });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Update agent / model / effort in-place in current session
apiRouter.patch('/sessions/:id/agent', async (req: Request, res: Response) => {
  try {
    const { agentId, model, effort, contextMode } = req.body;
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!hasAgent(agentId)) {
      res.status(400).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    // Only the shape is checked here: a level the new model lacks falls back to Auto with a note
    if (effort !== undefined && !isEffortValue(effort)) {
      res.status(400).json({ error: 'effort must be a short level name such as auto, low or high' });
      return;
    }
    const session = await sessionManager.setSessionAgent(sid(req), agentId, model, effort, contextMode);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update thinking / reasoning effort in current session
apiRouter.patch('/sessions/:id/effort', async (req: Request, res: Response) => {
  try {
    const { effort } = req.body;
    const current = sessionManager.getSession(sid(req));
    if (!current) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    // Checked against what this agent and model offer, e.g. Claude Opus: low..max, Claude Haiku: none
    const invalid = effortError(effort, effortChoicesFor(current.agentId, current.model, current.agentOptions));
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const session = await sessionManager.setSessionEffort(sid(req), effort);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Update user annotations (priority, pin, snooze, tags, cleanup)
apiRouter.patch('/sessions/:id/annotations', (req: Request, res: Response) => {
  const updated = sessionManager.updateAnnotations(sid(req), req.body);
  if (!updated) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session: updated });
});

// 10. Rename session title
apiRouter.patch('/sessions/:id/title', (req: Request, res: Response) => {
  const session = store.get(sid(req));
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  session.title = req.body.title || session.title;
  session.titleSource = 'user';
  store.save(session);
  res.json({ session });
});

// 11. Delete session
apiRouter.delete('/sessions/:id', (req: Request, res: Response) => {
  const ok = sessionManager.deleteSession(sid(req));
  res.json({ ok });
});

// 12. Search
apiRouter.get('/search', (req: Request, res: Response) => {
  const q = String(req.query.q || '');
  const matches = searchSessions(q);
  res.json({ sessions: matches });
});

// 13. Git info
apiRouter.get('/git', async (req: Request, res: Response) => {
  const cwd = String(req.query.cwd || '');
  const info = await getGitInfo(cwd);
  res.json({ git: info });
});

// 14. Suggest/Pick/Browse folders
apiRouter.get('/folders', (req: Request, res: Response) => {
  const rawPath = String(req.query.path || '').trim();
  const base = path.resolve(rawPath ? rawPath.replace(/^~/, os.homedir()) : os.homedir());
  try {
    if (!fs.existsSync(base)) {
      // A 404 lets the folder browser say the folder doesn't exist instead of
      // showing it as an empty folder.
      res.status(404).json({ error: `There's no folder at ${base}.` });
      return;
    }

    const stat = fs.statSync(base);
    if (!stat.isDirectory()) {
      res.json({
        current: path.dirname(base),
        parent: path.dirname(base) === '/' ? null : path.dirname(path.dirname(base)),
        isGit: false,
        recent: [],
        entries: [],
      });
      return;
    }

    const items = fs.readdirSync(base, { withFileTypes: true });
    const ignored = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'Pods']);
    const dirs = items
      .filter((i) => i.isDirectory() && !i.name.startsWith('.') && !ignored.has(i.name))
      .map((i) => {
        const fullPath = path.join(base, i.name);
        const isGit = fs.existsSync(path.join(fullPath, '.git'));
        return {
          name: i.name,
          path: fullPath,
          isGit,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const isGit = fs.existsSync(path.join(base, '.git'));
    const parent = base === '/' ? null : path.dirname(base);

    // Get recent session workspaces
    const sessions = store.getAll();
    const recentWorkspaces = Array.from(
      new Set(
        sessions
          .map((s) => s.cwd)
          .filter((cwd) => cwd && fs.existsSync(cwd))
      )
    ).slice(0, 8);

    res.json({
      current: base,
      parent,
      isGit,
      recent: recentWorkspaces,
      entries: dirs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to read directory' });
  }
});

// 14b. Native System Folder Picker (macOS Finder dialog)
apiRouter.post('/browse-native-folder', async (_req: Request, res: Response) => {
  if (process.platform !== 'darwin') {
    res.json({ supported: false, error: 'Native folder dialog only available on macOS' });
    return;
  }
  try {
    const script = 'POSIX path of (choose folder with prompt "Select Project Working Directory")';
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 60000 });
    const selected = stdout.trim().replace(/\/$/, '');
    res.json({ supported: true, selected });
  } catch (err: any) {
    if (err.message && (err.message.includes('User canceled') || err.message.includes('-128'))) {
      res.json({ supported: true, canceled: true });
    } else {
      res.json({ supported: false, error: err.message });
    }
  }
});

// 15. Subscriptions & Account Info
apiRouter.get('/subscriptions', (_req: Request, res: Response) => {
  try {
    const subscriptions = getVendorSubscriptions();
    res.json({ subscriptions });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get subscriptions' });
  }
});

// 16. Update Credentials / Auth Config
apiRouter.post('/subscriptions/config', (req: Request, res: Response) => {
  try {
    const { anthropicApiKey, openaiApiKey, geminiApiKey, preferredAuthMode } = req.body;
    const updated = saveStoredCredentials({
      anthropicApiKey,
      openaiApiKey,
      geminiApiKey,
      preferredAuthMode,
    });
    // Never echo raw API keys back to the browser
    res.json({ success: true, credentials: maskCredentials(updated), subscriptions: getVendorSubscriptions() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save credentials' });
  }
});

// 16b. Refresh Provider Rate Limits on Demand
apiRouter.post('/subscriptions/refresh-limits', async (_req: Request, res: Response) => {
  try {
    await Promise.all([refreshClaudeRateLimitsAsync(), refreshCodexRateLimitsAsync()]);
    res.json({ success: true, subscriptions: getVendorSubscriptions() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to refresh limits' });
  }
});

// 17. Aggregated Usage Report across vendors and sessions
apiRouter.get('/usage/summary', (_req: Request, res: Response) => {
  try {
    const summary = getUsageSummary();
    res.json({ usage: summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get usage summary' });
  }
});

// 18. Specific Session Usage Breakdown
apiRouter.get('/sessions/:id/usage', (req: Request, res: Response) => {
  try {
    const session = sessionManager.getSession(sid(req));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const cost = calculateSessionCost(session);
    res.json({
      sessionCost: cost,
      usage: session.usage,
      model: session.model,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get session usage' });
  }
});

// 19. Local Network (LAN) Access Info
async function networkInfo(req: Request) {
  const local = isLocalClient(req);
  // Re-reading interfaces rebinds LAN listeners, so only the host machine triggers it
  const lan = local ? await lanAccess.refresh() : lanAccess.status();
  const token = getOrCreateToken();
  return {
    port: lan.port,
    host: lan.host,
    lanEnabled: lan.enabled,
    token,
    ips: lan.addresses,
    localUrl: `http://127.0.0.1:${lan.port}`,
    networkUrls: lan.addresses.map((ip) => `http://${ip}:${lan.port}?token=${token}`),
    // Same addresses, labelled (Wi-Fi, VM bridge...) and best first, for the QR code picker
    lanInterfaces: (await describeLanAddresses(lan.addresses)).map((iface) => ({
      ...iface,
      url: `http://${iface.address}:${lan.port}?token=${token}`,
    })),
    lanErrors: lan.errors,
    // Only the machine running the server may change who else can reach it
    canToggle: local && !lan.lockedReason,
    lockedReason: lan.lockedReason,
  };
}

apiRouter.get('/network', async (req: Request, res: Response) => {
  res.json(await networkInfo(req));
});

apiRouter.post('/network/lan', async (req: Request, res: Response) => {
  if (!isLocalClient(req)) {
    res.status(403).json({ error: 'LAN access can only be changed on the computer running CodePit' });
    return;
  }
  const { enabled } = req.body ?? {};
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' });
    return;
  }
  if (lanAccess.status().lockedReason) {
    res.status(409).json({ error: lanAccess.status().lockedReason });
    return;
  }
  try {
    await lanAccess.setEnabled(enabled);
    res.json(await networkInfo(req));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to change LAN access' });
  }
});

function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function maskCredentials<T>(creds: T): T {
  if (!creds || typeof creds !== 'object') return creds;
  const out: Record<string, unknown> = { ...(creds as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (/key|token|secret/i.test(key)) out[key] = maskSecret(out[key]);
  }
  return out as T;
}

