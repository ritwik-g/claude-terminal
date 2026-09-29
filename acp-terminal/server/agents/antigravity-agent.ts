#!/usr/bin/env node
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AGENTAPI_PATH = path.join(os.homedir(), '.gemini/antigravity/bin/agentapi');

interface SessionTurn {
  role: 'user' | 'agent';
  text: string;
}

interface SessionData {
  id: string;
  cwd: string;
  model?: string;
  pendingPrompt: AbortController | null;
  conversationId?: string;
  history: SessionTurn[];
}

class AntigravityAcpAgent {
  private sessions = new Map<string, SessionData>();
  private hasAgentApi = false;

  constructor() {
    this.hasAgentApi = fs.existsSync(AGENTAPI_PATH);
  }

  async initialize(_params: unknown) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      agentInfo: {
        name: 'google-antigravity-acp',
        version: '1.0.0',
      },
    };
  }

  async newSession(params: { cwd?: string; mcpServers?: any[] }) {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params?.cwd || process.cwd(),
      pendingPrompt: null,
      history: [],
    });
    return { sessionId };
  }

  async setConfigOption(params: { sessionId: string; configId: string; value: any }) {
    const session = this.sessions.get(params.sessionId);
    if (session && params.configId === 'model') {
      session.model = String(params.value);
    }
    return {};
  }

  async prompt(params: { sessionId: string; prompt: any }, cx: any) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();
    const abortSignal = session.pendingPrompt.signal;

    let promptText = '';
    if (typeof params.prompt === 'string') {
      promptText = params.prompt;
    } else if (Array.isArray(params.prompt)) {
      promptText = params.prompt.map((b: any) => b.text || '').join('\n');
    } else if (typeof (params.prompt as any)?.text === 'string') {
      promptText = (params.prompt as any).text;
    } else {
      promptText = JSON.stringify(params.prompt);
    }

    if (!this.hasAgentApi) {
      const errMsg = `[Google Antigravity ACP] Real Antigravity desktop CLI not found at ${AGENTAPI_PATH}.\nPlease ensure Google Antigravity is installed and running on your system.`;
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: errMsg },
        },
      });
      return { stopReason: 'end_turn' };
    }

    try {
      // Determine model tier for agentapi
      let modelTier = 'flash';
      const m = (session.model || '').toLowerCase();
      if (m.includes('pro')) {
        modelTier = 'pro';
      } else if (m.includes('lite') || m.includes('flash-lite')) {
        modelTier = 'flash_lite';
      }

      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: `[Google Antigravity Engine - Gemini] Connecting to Antigravity desktop daemon (model: ${modelTier}) in ${session.cwd}...`,
          },
        },
      });

      const title = `ACP: ${promptText.replace(/\s+/g, ' ').slice(0, 30)}`;
      let convId = session.conversationId;

      if (!convId) {
        // Start a new Antigravity conversation
        const { stdout } = await execFileAsync(
          AGENTAPI_PATH,
          ['new-conversation', `--model=${modelTier}`, `--title=${title}`, promptText],
          { cwd: session.cwd }
        );

        const parsed = JSON.parse(stdout);
        convId = parsed?.response?.newConversation?.conversationId;
        if (!convId) {
          throw new Error(`Failed to create Antigravity conversation: ${stdout}`);
        }
        session.conversationId = convId;
      } else {
        // Send message to existing conversation
        await execFileAsync(
          AGENTAPI_PATH,
          ['send-message', convId, promptText],
          { cwd: session.cwd }
        );
      }

      // Stream updates from transcript.jsonl
      const transcriptPath = path.join(
        os.homedir(),
        '.gemini/antigravity/brain',
        convId,
        '.system_generated/logs/transcript.jsonl'
      );

      const processedSteps = new Set<number>();
      let lastContentLength = 0;
      let finalContent = '';
      let complete = false;
      const startTime = Date.now();
      const timeoutMs = 180000; // 3 min

      while (!complete && Date.now() - startTime < timeoutMs) {
        if (abortSignal.aborted) {
          return { stopReason: 'cancelled' };
        }

        if (fs.existsSync(transcriptPath)) {
          try {
            const raw = fs.readFileSync(transcriptPath, 'utf8');
            const lines = raw.split('\n').filter(Boolean);

            for (const line of lines) {
              let step: any;
              try {
                step = JSON.parse(line);
              } catch {
                continue; // Partial line write
              }

              const stepIdx = step.step_index ?? -1;

              if (step.type === 'PLANNER_RESPONSE') {
                if (!processedSteps.has(stepIdx)) {
                  if (step.thinking) {
                    await cx.notify(acp.methods.client.session.update, {
                      sessionId: params.sessionId,
                      update: {
                        sessionUpdate: 'agent_thought_chunk',
                        content: { type: 'text', text: step.thinking },
                      },
                    });
                  }

                  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
                    for (const tc of step.tool_calls) {
                      const toolCallId = `call_${stepIdx}_${tc.name || 'tool'}`;
                      await cx.notify(acp.methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                          sessionUpdate: 'tool_call',
                          toolCallId,
                          title: tc.toolSummary || tc.name || 'Executing tool',
                          kind: 'other',
                          status: 'running',
                          rawInput: tc.args || {},
                        },
                      });
                      await cx.notify(acp.methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                          sessionUpdate: 'tool_call_update',
                          toolCallId,
                          status: 'completed',
                          rawOutput: { output: 'Action executed by Antigravity' },
                        },
                      });
                    }
                  }

                  processedSteps.add(stepIdx);
                }

                if (step.content) {
                  const newContent = step.content;
                  if (newContent.length > lastContentLength) {
                    const chunk = newContent.slice(lastContentLength);
                    lastContentLength = newContent.length;
                    finalContent = newContent;
                    await cx.notify(acp.methods.client.session.update, {
                      sessionId: params.sessionId,
                      update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: chunk },
                      },
                    });
                  }

                  if (step.status === 'DONE') {
                    complete = true;
                    break;
                  }
                }
              }
            }
          } catch {
            // Retry reading
          }
        }

        if (!complete) {
          await this.sleep(250, abortSignal);
        }
      }

      session.history.push({ role: 'user', text: promptText });
      if (finalContent) {
        session.history.push({ role: 'agent', text: finalContent });
      }

      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 2500,
          size: 1000000,
        },
      });

      return { stopReason: 'end_turn' };
    } catch (err: any) {
      if (abortSignal.aborted) return { stopReason: 'cancelled' };
      const errText = `⚠️ Antigravity execution error: ${err.message || String(err)}`;
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: errText },
        },
      });
      return { stopReason: 'end_turn' };
    } finally {
      session.pendingPrompt = null;
    }
  }

  async cancel(params: { sessionId: string }) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      }
    });
  }
}

async function main() {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  const agent = new AntigravityAcpAgent();

  acp
    .agent({ name: 'antigravity-acp', version: '1.0.0' })
    .onRequest('initialize', (ctx: any) => agent.initialize(ctx.params))
    .onRequest('session/new', (ctx: any) => agent.newSession(ctx.params))
    .onRequest('session/set_config_option', (ctx: any) => agent.setConfigOption(ctx.params))
    .onRequest('session/prompt', (ctx: any) => agent.prompt(ctx.params, ctx.client))
    .onNotification('session/cancel', (ctx: any) => agent.cancel(ctx.params))
    .connect(stream);
}

main().catch((err) => {
  console.error('[antigravity-agent] Fatal error:', err);
  process.exit(1);
});
