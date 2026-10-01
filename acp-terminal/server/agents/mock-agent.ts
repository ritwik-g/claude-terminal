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
  /** The client takes subagent sessions (AIR nativeSubagentSessions), as Codex's adapter checks. */
  private subagentSessions = false;
  /** The client draws forms (ACP elicitation, form mode), as Claude's adapter checks before AskUserQuestion. */
  private forms = false;
  private clientCapabilities: unknown = null;

  async initialize(params: any) {
    const air = params?.clientCapabilities?._meta?.jetbrains?.air;
    this.subagentSessions = Array.isArray(air?.capabilities) && air.capabilities.includes('nativeSubagentSessions');
    this.forms = params?.clientCapabilities?.elicitation?.form != null;
    this.clientCapabilities = params?.clientCapabilities ?? null;
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

    // "stubborn" ignores a cancel and ends the turn cleanly anyway, as an agent may when the cancel comes too late
    if (/\bstubborn\b/.test(lower)) {
      await new Promise((r) => setTimeout(r, 400));
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished regardless.' } },
      });
      return { stopReason: 'end_turn' as const };
    }

    // "subagent" hands work to a subagent the way Codex's adapter reports it to a client that takes
    // subagent sessions: subagent_spawned, then the subagent's own session, then subagent_state_update.
    // "subagent permission" also has the subagent ask for approval.
    if (/\bsubagent\b/.test(lower)) {
      const root = params.sessionId;
      const send = (update: Record<string, unknown>, sessionId = root) => cx.notify(acp.methods.client.session.update, { sessionId, update });
      const say = (text: string, sessionId = root) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId);
      if (!this.subagentSessions) {
        await say('This client does not take subagent sessions.');
        return { stopReason: 'end_turn' as const };
      }
      const tag = crypto.randomUUID().slice(0, 8);
      const explorer = `thread-explorer-${tag}`;
      const checker = `thread-checker-${tag}`;
      await say('Handing this to a subagent. ');
      await send({ sessionUpdate: 'subagent_spawned', subagentSessionId: explorer, name: 'Explorer', task: 'Find the config files', capabilities: {} });
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking for config files.' } }, explorer);
      const callId = `call-sub-${tag}`;
      await send({ sessionUpdate: 'tool_call', toolCallId: callId, title: 'ls config', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls config' } }, explorer);
      if (/\bpermission\b/.test(lower)) {
        const res = await cx.request(acp.methods.client.session.requestPermission, {
          sessionId: explorer,
          toolCall: { toolCallId: callId, title: 'Run ls config', kind: 'execute', status: 'pending' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
          ],
        });
        if (res?.outcome?.outcome !== 'selected' || res.outcome.optionId !== 'allow') {
          await send({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed', rawOutput: { error: 'Rejected' } }, explorer);
          await send({ sessionUpdate: 'subagent_state_update', subagentSessionId: explorer, state: 'failed' });
          await say('The subagent was not allowed to look.');
          return { stopReason: 'end_turn' as const };
        }
      }
      await send({ sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed', rawOutput: { output: 'a.json\nb.json\nc.json' } }, explorer);
      // The subagent's own plan and usage are not the conversation's
      await send({ sessionUpdate: 'plan', entries: [{ content: 'Subagent plan step', priority: 'medium', status: 'pending' }] }, explorer);
      await send({ sessionUpdate: 'usage_update', used: 99999, size: 400000 }, explorer);
      // A subagent of the subagent, stopped before it finishes
      await send({ sessionUpdate: 'subagent_spawned', subagentSessionId: checker, name: 'Checker', task: 'Double-check the list', capabilities: {} }, explorer);
      await say('Checking the list.', checker);
      await send({ sessionUpdate: 'subagent_state_update', subagentSessionId: checker, state: 'cancelled' }, explorer);
      await say('Found 3 config files.', explorer);
      await send({ sessionUpdate: 'subagent_state_update', subagentSessionId: explorer, state: 'completed' });
      await say('The subagent found 3 config files.');
      return { stopReason: 'end_turn' as const };
    }

    // "client capabilities" reports what the client advertised at initialize
    if (/\bclient capabilities\b/.test(lower)) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Client capabilities: ${JSON.stringify(this.clientCapabilities)}` } },
      });
      return { stopReason: 'end_turn' as const };
    }

    // "ask me" asks a form the way Claude's AskUserQuestion does (a single select with its own
    // "Other" box, a multi-select), plus a required free-text field, and says what came back.
    // "ask me plainly" asks without a tool call, as an MCP server's elicitation would;
    // "ask me quickly" takes the question back after a moment, as Codex's answer timer does.
    if (/\bask me\b/.test(lower)) {
      const send = (update: Record<string, unknown>) => cx.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
      const say = (text: string) => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (!this.forms) {
        await say('This client cannot show forms, so I will ask in chat instead.');
        return { stopReason: 'end_turn' as const };
      }
      const toolCallId = /\bplainly\b/.test(lower) ? undefined : `call-ask-${crypto.randomUUID().slice(0, 8)}`;
      if (toolCallId) {
        await send({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'AskUserQuestion',
          kind: 'other',
          status: 'pending',
          rawInput: { questions: [{ question: 'Which database should I use?', header: 'Database' }, { question: 'Which features should I build?', header: 'Features', multiSelect: true }] },
          _meta: { claudeCode: { toolName: 'AskUserQuestion' } },
        });
      }
      const timer = new AbortController();
      if (/\bquickly\b/.test(lower)) setTimeout(() => timer.abort(), 300);
      const res = await cx.request(acp.methods.client.elicitation.create, {
        mode: 'form',
        sessionId: params.sessionId,
        ...(toolCallId ? { toolCallId } : {}),
        message: 'Please answer the following questions.',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: {
              type: 'string',
              title: 'Database',
              description: 'Which database should I use?',
              oneOf: [
                { const: 'Postgres', title: 'Postgres', description: 'Relational, the safe default' },
                { const: 'SQLite', title: 'SQLite', description: 'One file, no server', _meta: { '_claude/askUserQuestionOption': { preview: '```sql\nCREATE TABLE notes (id INTEGER PRIMARY KEY);\n```' } } },
              ],
            },
            question_0_custom: {
              type: 'string',
              title: 'Other',
              description: 'Type your own answer, or add a note to the option you chose above (optional).',
              _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } },
            },
            question_1: {
              type: 'array',
              title: 'Features',
              description: 'Which features should I build?',
              items: { anyOf: [{ const: 'Auth', title: 'Auth' }, { const: 'Search', title: 'Search' }, { const: 'Export', title: 'Export' }] },
            },
            name: { type: 'string', title: 'Project name', description: 'What should the project be called?', minLength: 2, maxLength: 40 },
          },
          required: ['question_0', 'name'],
        },
      }, { cancellationSignal: timer.signal }).catch((err: unknown) => {
        if (timer.signal.aborted) return null;
        throw err;
      });
      // The client may still answer the withdrawn request (with cancel) before it is dropped
      if (res === null || timer.signal.aborted) {
        await say('No answer in time, so I went with the defaults.');
        return { stopReason: 'end_turn' as const };
      }
      if (res?.action === 'accept') {
        const c = (res.content ?? {}) as Record<string, unknown>;
        const features = Array.isArray(c.question_1) && c.question_1.length ? c.question_1.join(', ') : 'none';
        const other = typeof c.question_0_custom === 'string' ? `; note=${c.question_0_custom}` : '';
        if (toolCallId) await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { answers: c } });
        await say(`You answered: database=${c.question_0}; features=${features}; name=${c.name}${other}`);
        return { stopReason: 'end_turn' as const };
      }
      if (res?.action === 'decline') {
        if (toolCallId) await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { answers: {} } });
        await say('You skipped the questions.');
        return { stopReason: 'end_turn' as const };
      }
      if (toolCallId) await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { error: 'Tool use aborted' } });
      await say('The question was cancelled.');
      return { stopReason: 'cancelled' as const };
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
