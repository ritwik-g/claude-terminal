#!/usr/bin/env node
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface SessionData {
  id: string;
  cwd: string;
  pendingPrompt: AbortController | null;
  mcpServers: Array<{ name: string; type?: string; command?: string; url?: string }>;
}

class MockAcpAgent {
  private sessions = new Map<string, SessionData>();

  async initialize(_params: unknown) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: true, sse: true },
      },
    };
  }

  async newSession(params: { cwd?: string; mcpServers?: SessionData['mcpServers'] }) {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params?.cwd || process.cwd(),
      pendingPrompt: null,
      mcpServers: Array.isArray(params?.mcpServers) ? params.mcpServers : [],
    });
    return { sessionId };
  }

  async prompt(params: { sessionId: string; prompt: string | unknown }, cx: any) {
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

    const lower = promptText.toLowerCase();

    // "background" starts a command that finishes after the turn, reported the way
    // Claude Code does it: AIR async_task_* updates tied to the tool call
    if (/\bbackground\b/.test(lower)) {
      const callId = `call-bg-${crypto.randomUUID().slice(0, 8)}`;
      const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
      const command = 'sleep 2 && echo background work finished';
      const outputFile = path.join(os.tmpdir(), `mock-agent-${taskId}.output`);
      const send = (update: Record<string, unknown>) => cx.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
      await send({ sessionUpdate: 'tool_call', toolCallId: callId, title: command, kind: 'execute', status: 'pending', rawInput: { command, run_in_background: true } });
      await send({ sessionUpdate: 'async_task_spawned', asyncTaskId: taskId, name: command, taskType: 'shell', toolCallId: callId, canStop: true, showInTranscript: false });
      await send({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'completed',
        rawOutput: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}`,
        _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } },
      });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started it in the background; it finishes in about two seconds.' } });
      setTimeout(() => {
        fs.writeFileSync(outputFile, 'background work finished\n');
        void send({ sessionUpdate: 'async_task_state_update', asyncTaskId: taskId, state: 'completed', toolCallId: callId, outputFilePath: outputFile }).catch(() => {});
      }, 2000);
      return { stopReason: 'end_turn' as const };
    }

    // "mcp" lists the MCP servers this session was given, so the app's injection can be checked
    if (/\bmcp\b/.test(lower)) {
      const list = session.mcpServers.length
        ? session.mcpServers
            .map((s) => `- \`${s.name}\` (${s.type ?? 'stdio'}): ${s.url ?? [s.command, ...((s as any).args ?? [])].join(' ')}`)
            .join('\n')
        : 'none';
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `MCP servers in this session:\n${list}` } },
      });
      return { stopReason: 'end_turn' as const };
    }

    try {
      // 1. Send thoughts
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: `Analyzing request: "${promptText}". Preparing task execution plan and checking workspace in ${session.cwd}...`,
          },
        },
      });

      await this.sleep(300, abortSignal);

      // 2. If prompt asks for permission or terminal command
      if (lower.includes('permission') || lower.includes('command') || lower.includes('test') || lower.includes('run')) {
        const cmd = lower.includes('test') ? 'npm test' : 'git status --short';
        const toolCallId = `call_${Date.now()}`;

        // Announce pending tool
        await cx.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Run command: \`${cmd}\``,
            kind: 'terminal',
            status: 'pending',
            rawInput: { command: cmd, cwd: session.cwd },
          },
        });

        // Request permission from client
        const permResponse = await cx.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId,
            title: `Run terminal command: \`${cmd}\``,
            kind: 'terminal',
            status: 'pending',
            rawInput: { command: cmd },
          },
          options: [
            {
              optionId: 'allow',
              name: 'Approve execution',
              kind: 'allow_once',
            },
            {
              optionId: 'deny',
              name: 'Reject execution',
              kind: 'reject_once',
            },
          ],
        });

        const outcome = permResponse?.outcome;
        if (outcome?.outcome === 'selected' && outcome.optionId === 'allow') {
          // Execute command via client's terminal capability
          let execOutput = `Running \`${cmd}\` in ${session.cwd}...\nSuccess (exit code 0)\nEverything up to date.`;
          try {
            const termRes = await cx.request(acp.methods.client.terminal.create, {
              sessionId: params.sessionId,
              command: cmd,
              cwd: session.cwd,
            });
            if (termRes?.terminalId) {
              const waitRes = await cx.request(acp.methods.client.terminal.waitForExit, {
                sessionId: params.sessionId,
                terminalId: termRes.terminalId,
              });
              // ACP: wait_for_exit returns only the exit status; output comes from terminal/output
              const outRes = await cx.request(acp.methods.client.terminal.output, {
                sessionId: params.sessionId,
                terminalId: termRes.terminalId,
              });
              if (outRes?.output) {
                execOutput = outRes.output;
              }
              if (waitRes?.exitCode != null && waitRes.exitCode !== 0) {
                execOutput += `\n(exit code ${waitRes.exitCode})`;
              }
              await cx.request(acp.methods.client.terminal.release, {
                sessionId: params.sessionId,
                terminalId: termRes.terminalId,
              });
            }
          } catch {
            // fallback simulated output if terminal client method not implemented or failed
          }

          await cx.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'completed',
              rawOutput: { output: execOutput },
            },
          });

          await cx.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Command executed with approval:\n\`\`\`bash\n${execOutput}\n\`\`\`\nLet me know what you'd like to do next!`,
              },
            },
          });
        } else {
          await cx.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'failed',
              rawOutput: { error: 'Execution denied by user.' },
            },
          });

          await cx.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `You chose not to run \`${cmd}\`. I have safely cancelled that action. How else can I assist?`,
              },
            },
          });
        }
      } else {
        // Standard conversational turn
        const chunks = [
          `I am your **ACP-connected agent** operating in \`${session.cwd}\`.\n\n`,
          `I can inspect files, run terminal commands, and perform code edits through standardized ACP JSON-RPC requests.\n\n`,
          `- **Attention Ranking**: Notice how my state transitions automatically from **Working** to **Needs You** once this response finishes.\n`,
          `- **Permission Control**: If I attempt a sensitive action (like running a shell command), I request approval from your UI first, ranking this session to the top as **Blocked**.\n`,
          `- **Multi-Agent Failover**: You can switch this session to Codex or another ACP engine anytime if your quota is exhausted!\n`,
        ];

        for (const chunk of chunks) {
          await this.sleep(150, abortSignal);
          await cx.notify(acp.methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            },
          });
        }
      }

      // 3. Emit usage update
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 1870,
          size: 200000,
        },
      });

      return { stopReason: 'end_turn' as const };
    } catch (err: any) {
      if (abortSignal.aborted) {
        return { stopReason: 'cancelled' as const };
      }
      throw err;
    } finally {
      session.pendingPrompt = null;
    }
  }

  async cancel(params: { sessionId: string }) {
    const session = this.sessions.get(params.sessionId);
    session?.pendingPrompt?.abort();
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
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const agent = new MockAcpAgent();

  acp
    .agent({ name: 'mock-acp-agent' })
    .onRequest('initialize', (ctx: any) => agent.initialize(ctx.params))
    .onRequest('session/new', (ctx: any) => agent.newSession(ctx.params))
    .onRequest('session/prompt', (ctx: any) => agent.prompt(ctx.params, ctx.client))
    .onNotification('session/cancel', (ctx: any) => agent.cancel(ctx.params))
    .connect(stream);
}

main().catch((err) => {
  console.error('[mock-agent] Fatal error:', err);
  process.exit(1);
});
