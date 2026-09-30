# CodePit (then ACP Terminal): UI/UX and functional gap audit (2026-09-29)

Method: drove the app in headless Chrome against an isolated server
(`ACP_APP_DIR=/tmp/…`, empty `/tmp` workspaces, the built-in demo agent),
walked every screen at desktop and mobile widths, and cross-checked the
findings with a read-through of `server/**` and `web/src/**`.

Status key: **Fixed** (on branch `acp-ux-gaps`), **Open** (not addressed yet).

## Security

| # | Gap | Where | Status |
|---|-----|-------|--------|
| S1 | Any LAN client could skip token auth by sending `x-test-remote-ip: 127.0.0.1`; the server binds `0.0.0.0` by default, so this allowed remote shell and agent access | `server/cli.ts` | Fixed |
| S2 | Loopback requests were trusted with no Origin check: any web page open in the user's browser could drive `/ws/terminal/<id>` (a login shell) or form-POST `/api/sessions` | `server/cli.ts`, `server/ws.ts` | Fixed |
| S3 | A malformed `Host` header on a WebSocket upgrade crashed the server, with no auth needed | `server/ws.ts` | Fixed |
| S4 | Agent markdown was rendered unsanitized via `dangerouslySetInnerHTML`: `<img onerror>` and `javascript:` links from prompt-injected repo content could run script and read the token | `MarkdownContent.tsx` | Fixed |
| S5 | `POST /subscriptions/config` echoed raw API keys back | `server/api.ts` | Fixed |

## Functional

| # | Gap | Where | Status |
|---|-----|-------|--------|
| F1 | A missing working directory returned a cryptic 500 ("ACP connection closed") but still saved a zombie session ranked **Needs You** | `server/api.ts`, `session-mgr.ts` | Fixed |
| F2 | `AgentTurnExecutionCard` returned before calling its hooks, so a turn that gained its first tool call mid-stream could crash React; with no error boundary, the app went blank | `SessionDetail.tsx` | Fixed |
| F3 | A turn blocked on approval showed "✓ Done" and "Ready for your input · Turn completed" | `SessionDetail.tsx` | Fixed |
| F4 | Pending permission cards were never cleared on cancel, agent error, agent exit or restart, so a dead approval card stayed up; the ACP outcome `rejected` is invalid | `session-mgr.ts`, `client-host.ts` | Fixed |
| F5 | Turns over 60s were marked finished mid-run because `lastActivityAt` only updated at prompt start/end | `session-mgr.ts` | Fixed |
| F6 | The background poller re-saved every session every 10s and bumped `updatedAt`, which broke recency ranking | `session-mgr.ts`, `git.ts` | Fixed |
| F7 | The event WebSocket never reconnected: after a server restart the open transcript silently stopped updating | `web/src/api.ts`, `App.tsx` | Fixed |
| F8 | Deleting a session left it on screen and editable | `App.tsx`, `SessionDetail.tsx` | Fixed |
| F9 | LAN clients got 401 on the live terminal and on image attachments because no token was sent | `TerminalDrawer.tsx`, `SessionDetail.tsx` | Fixed |
| F10 | ACP conformance: `terminal/output` shape, `env` array spread as an object, `readTextFile` ignoring line/limit, only one pending permission kept | `client-host.ts`, `pty-manager.ts` | Fixed |
| F11 | Agent-created terminals leaked past session delete, stop and shutdown; a stopped agent's exit handler could remove its replacement | `client-host.ts`, `session-mgr.ts` | Fixed |
| F12 | The demo agent the README promises "out of the box" never appeared in the UI: `/api/agents` always passed `includeMock=false` | `server/api.ts` | Fixed |
| F13 | Uploads went to `~/.acp-terminal/uploads` regardless of `ACP_APP_DIR` | `server/api.ts` | Fixed |
| F14 | Snoozing was supported by the ranker but impossible from the UI | `SessionDetail.tsx` | Fixed |
| F15 | The web code was effectively not type-checked (root `NodeNext` config, 94 errors hiding real ones); the server had 27 errors, some real | `tsconfig.json` | Fixed |

## Keyboard and accessibility

| # | Gap | Status |
|---|-----|--------|
| K1 | Cmd/Ctrl+C (copying transcript text) toggled the session's cleanup mark | Fixed |
| K2 | The README documents `p` (cycle priority), but it wasn't implemented | Fixed |
| K3 | Shortcuts fired behind open modals; j/k ignored the sidebar's filtered order and didn't scroll the card into view | Fixed |
| K4 | Esc did nothing while typing inside a modal, and Esc on an open dropdown closed the whole dialog | Fixed |
| K5 | No focus rings, no aria labels on icon-only buttons, no dialog roles, session cards not keyboard reachable, `--text-dim` at 3.7:1 contrast | Fixed |

## UX

| # | Gap | Status |
|---|-----|--------|
| U1 | An empty workspace said "No sessions match the filter"; the first paint showed "No Session Selected" while loading | Fixed |
| U2 | New session defaulted the working directory to `$HOME` and could overwrite a path the user had started typing | Fixed |
| U3 | The Finder button opened a dialog on the host machine even for LAN clients | Fixed |
| U4 | The Switch modal said "Git branch: main (0 uncommitted files)" for folders that aren't git repos | Fixed |
| U5 | Quick-action chips offered "Proceed with PR" whenever a reply contained "pr" inside any word (approval, prompt…) | Fixed |
| U6 | Sending while the agent worked silently cancelled the running turn | Fixed (confirm) |
| U7 | Rename sent twice (Enter + blur) and accepted empty titles | Fixed |
| U8 | The conversation yanked back to the bottom on every streamed chunk while you read earlier turns | Fixed |
| U9 | Search had no debounce or ordering, so stale responses could win; it had no loading or error state | Fixed |
| U10 | The LAN modal rendered inline (missing overlay class), squashing the layout; it listed URLs even when the server only listens on loopback | Fixed |
| U11 | Sidebar tab counts changed with the active tab; crashed sessions were counted but filtered out | Fixed |
| U12 | Mobile opened on an empty session pane with no way back to the list | Fixed |
| U13 | The detail header showed no folder for non-git sessions | Fixed |
| U14 | The demo agent was priced at Sonnet rates | Fixed |

## Follow-up round (same day)

| # | Change | Status |
|---|--------|--------|
| R1 | Agent turns were one merged blob ("…instead.I'll work…"). Turns are now ordered segments; each message is its own block, with tool calls between them as compact rows | Fixed |
| R2 | Subagents were invisible. Claude's Agent/Task calls render as subagent cards with their steps, task and report; their calls and replies attach to the spawning call even after the turn ends | Fixed |
| R3 | Running work was hard to see. A strip above the conversation shows the agent's plan (todo list) with progress plus running or background subagents and commands | Fixed |
| R4 | The Live Terminal showed an empty shell: Claude Code and Codex run commands in-process. The client now asks for `terminal_output` meta, and the Terminal tab shows every agent command with output and exit code, next to your own shell | Fixed |
| R5 | LAN access was on by default | Fixed (opt-in via `ACP_LAN=1`) |
| R6 | Focus could leave dialogs | Fixed (shared `<Modal>` with focus trap) |
| R7 | Long transcripts re-rendered every turn on every chunk | Fixed (memoized turn bodies; the newest 120 turns render, older ones on demand) |
| R8 | Visual polish: emoji-heavy chrome, a crowded header, score noise, loud banners | Fixed: SVG icons, a header with an overflow menu, plain state labels, a quieter status row, redesigned sidebar cards and composer |

## Closing round

| # | Change | Status |
|---|--------|--------|
| C1 | The attention score was a raw list of rules ("needs_you base (+100)"). Ranking now returns plain-language factors ("Waiting for your approval", "3 uncommitted files", "Active 25 minutes ago") and a one-sentence summary; the state popover shows them and explains how the sidebar orders sessions, and the sidebar row tooltip shows the summary | Fixed |
| C2 | Background commands stayed "Background" forever. The adapter does send AIR `async_task_*` updates, but they are not in the ACP schema, so the SDK dropped them (logging a validation error). The client now takes them off the wire before the SDK parses anything, settles the call as done, failed or stopped, and replaces the "running in background" notice with the command's real output. Background work still running when the agent stops, exits or the server restarts is marked stopped | Fixed |
| C3 | Found while fixing C2: the SDK resolves a prompt response before it has finished handling the updates sent just ahead of it, so the last message or tool call of a turn could land in a separate turn (and the next prompt's first call in the previous one). The turn now ends one macrotask later, after those updates are handled | Fixed |

## Still open

Nothing from this audit.
