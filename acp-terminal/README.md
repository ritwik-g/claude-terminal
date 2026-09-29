# ACP Terminal

**A vendor-agnostic, attention-ranked workspace for AI coding agents powered by the Agent Client Protocol (ACP).**

Work seamlessly across **Claude Code**, **OpenAI Codex**, **Google Gemini**, and custom agents from a single unified interface. When you hit a quota or rate limit on one provider, failover to another with a single click while preserving your repository context, git state, and active goal.

---

## Why ACP Terminal?

Claude Terminal pioneered **attention ranking**—sorting AI coding sessions by *who needs you right now* rather than recency. But it was bound to Claude Code's internal disk formats (`~/.claude/projects/` and `~/.claude/sessions/`).

**ACP Terminal** re-architects that concept on top of the open **Agent Client Protocol (ACP)** (standardized by Zed Industries and JetBrains):

1. **Vendor Agnostic**: Switch between Anthropic Claude Code, OpenAI Codex, and Google Gemini based on task complexity, pricing, or rate-limit exhaustion.
2. **First-Class Attention Ranking**: Sessions transition cleanly through *Blocked*, *Needs you*, *Working*, *Parked*, and *Quiet* based on real JSON-RPC protocol events rather than transcript heuristics.
3. **One-Click Failover**: When your 5-hour Claude quota runs out, switch your active workspace directly to Codex. Your working directory, uncommitted git changes, and recent goal are automatically handed over.
4. **First-Class Permissions & Approvals**: Sensitive operations (`terminal/create`, file edits, questions) surface at the very top of your queue with explicit Approve / Reject controls.
5. **Real Terminal Integration**: The ACP client implements `terminal/*` methods using native PTYs and embeds `@xterm/xterm` in the same window.

---

## Feature Comparison

| Feature | Original Claude Terminal | ACP Terminal |
| :--- | :--- | :--- |
| **Agent Support** | Claude Code only | **Claude Code, OpenAI Codex, Gemini CLI, & Custom ACP Agents** |
| **Attention Ranking** | *Needs you / Working / Parked / Quiet / Snoozed* | **Identical 5-tier attention ranking + inspectable score reasons** |
| **Quota Failover** | None (blocked when Anthropic quota runs out) | **One-click failover to Codex / alternative provider** |
| **Permissions / Approvals** | Scraped from transcript tails (`AskUserQuestion`) | **Native ACP `session/requestPermission` protocol dialogs** |
| **Tool Execution** | Run inside Claude CLI subprocess | **Client-hosted `terminal/create` and `fs/*` with safety controls** |
| **Terminal View** | Embedded raw PTY for `claude --resume` | **Embedded `@xterm/xterm` pane with real-time command output** |
| **Git Awareness** | Detects branch, uncommitted files, unpushed commits | **Identical native git scanner influencing attention score** |
| **Keyboard Navigation** | `j`/`k`, `/`, `Enter`, `p`, `s`, `c` | **Full keyboard-first workflow (`j`/`k`, `/`, `Enter`, `c`, `p`)** |

---

## Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │   ACP Terminal Web UI (React + Vite)   │
                      │   • Attention-Ranked Sidebar           │
                      │   • Embedded @xterm/xterm Pane         │
                      │   • Approval / Permission Banners      │
                      └───────────────────┬────────────────────┘
                                          │ HTTP / WebSockets
                      ┌───────────────────▼────────────────────┐
                      │          Express & Node Server         │
                      │   • Session Manager & Ranking Engine   │
                      │   • Native Git Status Scanner          │
                      │   • PTY Manager (terminal execution)   │
                      │   • Local State Store                  │
                      └───────────────────┬────────────────────┘
                                          │ ACP (JSON-RPC over stdio)
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
     ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
     │   Claude Code ACP    │  │    Codex CLI ACP     │  │   Built-in Mock ACP  │
     │     (@anthropic)     │  │       (@openai)      │  │    (Local Testing)   │
     └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

### The ACP Handshake & Event Flow
1. **Initialize**: Client negotiates capabilities (`clientCapabilities.terminal: true`, `clientCapabilities.fs: { readTextFile, writeTextFile }`).
2. **Session Creation**: Client issues `session/new` with repository `cwd` and `mcpServers: []`.
3. **Turn Execution**: Client sends `session/prompt` with content blocks.
4. **Streaming Updates**: Agent sends `session/update` notifications:
   - `agent_thought_chunk`: Reasoning traces.
   - `agent_message_chunk`: Formatted assistant text.
   - `tool_call` & `tool_call_update`: Command execution and file operations.
   - `usage_update`: Context token count and window size.
5. **Permissions & Approvals**: When the agent wants to execute a terminal command, it sends `session/requestPermission`. The session immediately jumps to the top of **Needs You** as `blocked` until the user approves or denies.

---

## Supported Agents

### 1. Built-in Demo Agent (`mock`)
- Ships pre-installed and needs no configuration or API keys. It is hidden from the agent picker unless you start the server with `ACP_ENABLE_MOCK=1` (it is always listed under `NODE_ENV=test`).
- Fully exercises the ACP spec: streaming thoughts, generating text, requesting permissions, and running terminal commands.

### 2. OpenAI Codex ACP (`codex`)
- Powered by `@agentclientprotocol/codex-acp`.
- Requires `OPENAI_API_KEY` set in your environment:
  ```bash
  export OPENAI_API_KEY="sk-..."
  ```

### 3. Anthropic Claude Code ACP (`claude`)
- Powered by `@agentclientprotocol/claude-agent-acp` or `claude-acp`.
- Requires `ANTHROPIC_API_KEY` set in your environment:
  ```bash
  export ANTHROPIC_API_KEY="sk-ant-..."
  ```

### 4. Custom Agents
Any agent exposing an ACP JSON-RPC interface via `stdio` can be registered in `server/agents/registry.ts`.

---

## Quick Start

### 1. Install Dependencies
```bash
cd acp-terminal
npm install
```

### 2. Run the Verification Tests
Verify protocol compatibility, attention ranking, and failover:
```bash
npm test
npm run smoke
```

Type-check the server and the web client:
```bash
npm run typecheck
```

### 3. Build & Start the Server
```bash
npm run build
npm start
```
Open **http://127.0.0.1:7890** in your browser.

### 4. Development Mode (Hot Reloading)
```bash
# Terminal 1: Backend server
npm run dev

# Terminal 2: Web frontend
npm run dev:web
```
Open **http://127.0.0.1:5280**.

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `j` / `↓` | Select next session |
| `k` / `↑` | Select previous session |
| `Enter` | Open selected session (mobile) / submit prompt |
| `⌘N` / `Ctrl+N` | New session |
| `/` | Open full-text search modal across all sessions |
| `p` | Cycle priority (`P0` → `P1` → `P2` → Normal) |
| `c` | Toggle cleanup mark |
| `Esc` | Close the topmost dropdown or dialog |

Single-key shortcuts are ignored while typing, while a dialog is open, inside the terminal, and when combined with ⌘/Ctrl/Alt, so ⌘C still copies.

---

## License
MIT
