import express, { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { listAgents } from './agents/registry.js';
import { sessionManager } from './acp/session-mgr.js';
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
import { getLocalNetworkIps } from './network.js';
import { getOrCreateToken } from './paths.js';

export const apiRouter = Router();

// Static directory for uploaded files and pictures
const uploadsBaseDir = path.join(os.homedir(), '.acp-terminal', 'uploads');
fs.mkdirSync(uploadsBaseDir, { recursive: true });
apiRouter.use('/attachments', express.static(uploadsBaseDir));

// 1. List registered agents
apiRouter.get('/agents', (req: Request, res: Response) => {
  const includeMock = req.query.includeMock === 'true';
  res.json({ agents: listAgents(includeMock) });
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
    const targetCwd = path.resolve(cwd.replace(/^~/, os.homedir()));
    const session = await sessionManager.createSession({
      agentId,
      cwd: targetCwd,
      title,
      model,
      initialPrompt,
    });
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create session' });
  }
});

// 4. Get full session detail
apiRouter.get('/sessions/:id', (req: Request, res: Response) => {
  const session = sessionManager.getSession(req.params.id);
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
    // sendPrompt runs asynchronously in host
    sessionManager.sendPrompt(req.params.id, prompt || '', attachments).catch((err) => {
      console.error(`[api] Error executing prompt for ${req.params.id}:`, err);
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Cancel prompt (stop active turn)
apiRouter.post('/sessions/:id/cancel', async (req: Request, res: Response) => {
  try {
    await sessionManager.cancelPrompt(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6b. Stop / Park underlying agent subprocess & terminal
apiRouter.post('/sessions/:id/stop', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.stopSessionAgent(req.params.id);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6c. Start / Resume underlying agent subprocess
apiRouter.post('/sessions/:id/start', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.startSessionAgent(req.params.id);
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
    const ok = await sessionManager.resolvePermission(req.params.id, optionId);
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
    const newSession = await sessionManager.switchAgent(req.params.id, targetAgentId, {
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
    const result = await sessionManager.rollbackSession(req.params.id, {
      turnId,
      action: action || 'revert_to_this',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Compact conversation context in current session
apiRouter.post('/sessions/:id/compact', async (req: Request, res: Response) => {
  try {
    const session = await sessionManager.compactSession(req.params.id);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const session = await sessionManager.setSessionAgent(req.params.id, agentId, model, effort, contextMode);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update thinking / reasoning effort in current session
apiRouter.patch('/sessions/:id/effort', async (req: Request, res: Response) => {
  try {
    const { effort } = req.body;
    if (!effort) {
      res.status(400).json({ error: 'effort is required' });
      return;
    }
    const session = await sessionManager.setSessionEffort(req.params.id, effort);
    res.json({ session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Update user annotations (priority, pin, snooze, tags, cleanup)
apiRouter.patch('/sessions/:id/annotations', (req: Request, res: Response) => {
  const updated = sessionManager.updateAnnotations(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session: updated });
});

// 10. Rename session title
apiRouter.patch('/sessions/:id/title', (req: Request, res: Response) => {
  const session = store.get(req.params.id);
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
  const ok = sessionManager.deleteSession(req.params.id);
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
      res.json({
        current: base,
        parent: base === '/' ? null : path.dirname(base),
        isGit: false,
        recent: [],
        entries: [],
      });
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
    res.json({ success: true, credentials: updated, subscriptions: getVendorSubscriptions() });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to save credentials' });
  }
});

// 16b. Refresh Provider Rate Limits on Demand
apiRouter.post('/subscriptions/refresh-limits', async (_req: Request, res: Response) => {
  try {
    await refreshClaudeRateLimitsAsync();
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
    const session = sessionManager.getSession(req.params.id);
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
apiRouter.get('/network', (_req: Request, res: Response) => {
  const token = getOrCreateToken();
  const port = Number(process.env.PORT || 7890);
  const ips = getLocalNetworkIps();
  res.json({
    port,
    token,
    ips,
    localUrl: `http://127.0.0.1:${port}`,
    networkUrls: ips.map((ip) => `http://${ip}:${port}?token=${token}`),
  });
});

