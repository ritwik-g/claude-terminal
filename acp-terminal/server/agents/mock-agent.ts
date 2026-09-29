#!/usr/bin/env node
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';

interface SessionData {
  id: string;
  cwd: string;
  pendingPrompt: AbortController | null;
}

class MockAcpAgent {
  private sessions = new Map<string, SessionData>();

  async initialize(_params: unknown) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async newSession(params: { cwd?: string }) {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params?.cwd || process.cwd(),
      pendingPrompt: null,
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

        const selectedOption = permResponse?.outcome?.optionId;
        if (selectedOption === 'allow' || permResponse?.outcome?.outcome === 'selected') {
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
              if (waitRes?.output) {
                execOutput = waitRes.output;
              }
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

      return { stopReason: 'end_turn' };
    } catch (err: any) {
      if (abortSignal.aborted) {
        return { stopReason: 'cancelled' };
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
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  const agent = new MockAcpAgent();

  acp
    .agent({ name: 'mock-acp-agent', version: '1.0.0' })
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
