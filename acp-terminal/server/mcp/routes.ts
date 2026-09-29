import fs from 'node:fs';
import os from 'node:os';
import { Router, type Request, type Response } from 'express';
import { hasAgent } from '../agents/registry.js';
import {
  McpConfigError,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  setMcpServerEnabled,
  toView,
  updateMcpServer,
} from './config.js';
import { listPresets, presetToInput } from './presets.js';
import { probeMcpServer } from './probe.js';
import { inspectEcosystems } from './inspect.js';

export const mcpRouter = Router();

const id = (req: Request) => String(req.params.id);

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof McpConfigError) {
    res.status(err.message === 'MCP server not found' ? 404 : 400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error)?.message || fallback });
}

function checkScope(scope: unknown): void {
  if (scope !== undefined && scope !== 'all' && !hasAgent(scope)) throw new McpConfigError(`Unknown agent: ${String(scope)}`);
}

mcpRouter.get('/servers', (_req, res) => {
  res.json({ servers: listMcpServers().map(toView) });
});

mcpRouter.post('/servers', (req, res) => {
  try {
    checkScope(req.body?.scope);
    res.json({ server: toView(createMcpServer(req.body ?? {})) });
  } catch (err) {
    fail(res, err, 'Failed to add the MCP server');
  }
});

mcpRouter.post('/servers/from-preset', (req, res) => {
  try {
    const { presetId, inputs, scope } = req.body ?? {};
    checkScope(scope);
    res.json({ server: toView(createMcpServer(presetToInput(String(presetId), inputs, scope ?? 'all'))) });
  } catch (err) {
    fail(res, err, 'Failed to add the preset');
  }
});

mcpRouter.put('/servers/:id', (req, res) => {
  try {
    checkScope(req.body?.scope);
    res.json({ server: toView(updateMcpServer(id(req), req.body ?? {})) });
  } catch (err) {
    fail(res, err, 'Failed to save the MCP server');
  }
});

mcpRouter.patch('/servers/:id/enabled', (req, res) => {
  try {
    res.json({ server: toView(setMcpServerEnabled(id(req), Boolean(req.body?.enabled))) });
  } catch (err) {
    fail(res, err, 'Failed to update the MCP server');
  }
});

mcpRouter.delete('/servers/:id', (req, res) => {
  if (!deleteMcpServer(id(req))) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  res.json({ ok: true });
});

mcpRouter.post('/servers/:id/test', async (req, res) => {
  const server = getMcpServer(id(req));
  if (!server) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  // ${workspace} resolves to the folder the user is looking at, else the home folder
  const cwd = typeof req.body?.cwd === 'string' && fs.existsSync(req.body.cwd) && fs.statSync(req.body.cwd).isDirectory()
    ? req.body.cwd
    : os.homedir();
  res.json({ result: await probeMcpServer(server, cwd), cwd });
});

mcpRouter.get('/presets', (_req, res) => {
  res.json({ presets: listPresets() });
});

mcpRouter.get('/ecosystems', async (req, res) => {
  try {
    res.json({ ecosystems: await inspectEcosystems(req.query.refresh === '1') });
  } catch (err) {
    fail(res, err, 'Failed to inspect agent plugins');
  }
});
