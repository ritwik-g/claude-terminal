<p align="center"><img src="build/icon.png" width="112" alt="CodePit icon: a pit board showing a terminal prompt"></p>

# CodePit

**A pit wall for your coding agents.**

CodePit is a vendor-agnostic, attention-ranked workspace for AI coding agents, powered by the Agent Client Protocol (ACP). Like a race team's pit wall, it watches every car on track and calls in the one that needs you.

Work seamlessly across **Claude Code**, **OpenAI Codex**, **Google Gemini**, and custom agents from a single unified interface. When you hit a quota or rate limit on one provider, failover to another with a single click while preserving your repository context, git state, and active goal.

---

## Why CodePit?

CodePit grew out of Claude Terminal, which pioneered **attention ranking**—sorting AI coding sessions by *who needs you right now* rather than recency. But Claude Terminal was bound to Claude Code's internal disk formats (`~/.claude/projects/` and `~/.claude/sessions/`).

**CodePit** (called ACP Terminal while it was being built) rebuilds that concept on top of the open **Agent Client Protocol (ACP)** (standardized by Zed Industries and JetBrains):

1. **Vendor Agnostic**: Switch between Anthropic Claude Code, OpenAI Codex, and Google Gemini based on task complexity, pricing, or rate-limit exhaustion.
2. **First-Class Attention Ranking**: Sessions transition cleanly through *Blocked*, *Needs you*, *Working*, *Parked*, and *Quiet* based on real JSON-RPC protocol events rather than transcript heuristics.
3. **One-Click Failover**: When your 5-hour Claude quota runs out, switch your active workspace directly to Codex. Your working directory, uncommitted git changes, and recent goal are automatically handed over.
4. **First-Class Permissions & Approvals**: Sensitive operations (`terminal/create`, file edits, questions) surface at the very top of your queue with explicit Approve / Reject controls.
5. **Real Terminal Integration**: The ACP client implements `terminal/*` methods using native PTYs and embeds `@xterm/xterm` in the same window.

---

## Feature Comparison

| Feature | Claude Terminal (where it started) | CodePit |
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
                      │     CodePit Web UI (React + Vite)      │
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
- Ships pre-installed and needs no configuration or API keys. It is hidden from the agent picker unless you start the server with `CODEPIT_ENABLE_MOCK=1` (it is always listed under `NODE_ENV=test`).
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

## MCP Servers and Plugins

Open **MCP and plugins** in the sidebar (or type `/mcp` in the composer) to give your agents extra tools.

- **Configure once, use everywhere.** Servers are stored in `<CODEPIT_APP_DIR>/mcp.json` (owner-only permissions) and passed to the agent in ACP `session/new` every time an agent starts. Changes apply the next time an agent starts; stop and start a running agent to pick them up.
- **Transports.** `stdio` (a local command), streamable `http`, and legacy `sse`. Each agent only gets the transports it advertises in `mcpCapabilities`: Claude Code takes all three, Codex takes stdio and HTTP. The session header shows how many servers an agent got, and why any were skipped.
- **Scope.** A server goes to all agents or to one agent. Turn it off with the switch to keep its settings without using it.
- **Secrets.** Environment variables with secret-looking names and all HTTP header values are masked in the API and the UI after saving. Leave a masked value alone when editing to keep it.
- **`${workspace}`** in a command argument, environment value or URL becomes the session's folder when the agent starts.
- **Test connection** runs the MCP handshake (`initialize`, then `tools/list`) and lists the server's tools, so a wrong command, URL or token shows up before a session needs it.
- **Catalog.** One-click presets for Filesystem (scoped to the session folder), GitHub (GitHub's hosted MCP server, needs a personal access token), Memory (a knowledge graph kept in the app dir), Brave Search, SQLite and PostgreSQL (read-only mode, needs `uvx`).
- **Antigravity** runs through its desktop app, which reads MCP servers from its own settings rather than from the session. Each server row offers the matching `agy mcp add` command to copy.
- **Agent plugins and skills** is a read-only view of what each agent loads by itself: Claude Code plugins, skills and user-scope MCP servers (`~/.claude`, `~/.claude.json`), Codex plugins, skills and MCP servers (`~/.codex`), and Antigravity skills, plugins and MCP servers (`~/.gemini`, `agy plugin list`, `agy mcp list`). Only names, versions and descriptions are shown, never tokens.

The Built-in Demo Agent answers a prompt containing "mcp" with the servers it received, which is handy for checking scope and transport filtering. A prompt containing "background" starts a command that finishes two seconds after the turn, the way Claude Code reports background shells.

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
Open **http://127.0.0.1:7890** in your browser. Only this machine can connect; see [LAN access](#5-access-from-other-devices-lan) to allow other devices.

### 4. Development Mode (Hot Reloading)
```bash
# Terminal 1: Backend server
npm run dev

# Terminal 2: Web frontend
npm run dev:web
```
Open **http://127.0.0.1:5280**.

### 5. Access from Other Devices (LAN)
By default the server listens on `127.0.0.1` only, so nothing else on your network can reach it. To use it from a phone, tablet, or another laptop, open the **LAN access** dialog from the sidebar and turn on **Allow devices on your network**. It takes effect immediately (no restart) and is remembered in `~/.codepit/settings.json`; turning it off disconnects every LAN device at once. The switch only works on the computer running the server; other devices see it read-only.

When LAN access is on, the server keeps its loopback listener and adds one per network interface, and the dialog shows a pre-authenticated URL for each plus the access token. Requests from other machines must carry the token (`?token=` in the URL or the `x-codepit-token` header), and cross-origin requests are rejected. Enable it only on networks you trust.

To decide at startup instead, `CODEPIT_LAN=1 npm start` (or `CODEPIT_LAN=0`) overrides the saved setting for that run.

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `7890` | HTTP and WebSocket port |
| `CODEPIT_LAN` | unset | `1` / `0` turns LAN access on or off for this run, overriding the saved setting |
| `HOST` | `127.0.0.1` | Explicit bind address; overrides `CODEPIT_LAN` and locks the LAN switch in the UI |
| `CODEPIT_APP_DIR` | `~/.codepit` | Where sessions, credentials and the access token are stored |
| `CODEPIT_ENABLE_MOCK` | unset | `1` lists the built-in demo agent in the agent picker |

**Upgrading from before the rename:** the first time CodePit starts, it moves `~/.acp-terminal` to `~/.codepit`, leaves a link at the old path, and updates the file paths saved in your sessions, so everything carries over. It never merges folders: if `~/.codepit` already exists, it is used as is. Quit any older build still running before the first start. The old `ACP_*` variable names and the `x-acp-token` header are still accepted; the `CODEPIT_*` names win when both are set.

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
