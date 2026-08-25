# claude-terminal

An attention-ranked workspace for Claude Code sessions, with embedded terminals.

`clsm` answers *"what sessions do I have?"*. This answers *"which one needs me
right now, and can I get into it without leaving this window?"*

## The problem

Sessions accumulate. Some are ad-hoc and short-lived (a PR review, a customer
issue). Some are long-running explorations. Some get parked for a later day.
A flat, recency-sorted list can't tell those apart, so finding the session that
actually needs attention means opening several and reading them.

## What it does

**Ranks by attention, not recency.** Sessions are grouped into *Needs you /
Working / Parked / Quiet / Snoozed*, and every session carries a `reasons` trail
explaining its position — the ranking is always inspectable, never a black box.

The signals are derived, so the list stays useful with no upkeep:

| Signal | Where it comes from |
|---|---|
| Waiting on you | live process is `idle`, or the last assistant turn ended with `stop_reason: end_turn` |
| Working now | Claude Code's own `busy` status |
| Stopped mid tool-call | last transcript entry is an unresolved `tool_use` |
| Work left behind | uncommitted files / unpushed commits **attributable to this session** |
| Has a PR | `pr-link` entries in the transcript |

**Errands vs explorations, derived.** Every session is classified by shape —
`⚡ errand` (short, single-purpose: a PR review, a quick question), `◆ task`, or
`∞ thread` (a long-running exploration carried across days) — and you can filter
by it. The thresholds come from the real distribution rather than intuition:
across 134 sessions, span is strongly bimodal at p25 = 28 minutes and
p75 = 4.75 days.

**Manual state is an override, never load-bearing.** Tags, P0/P1/P2, pin and
snooze all exist, but the tool works fully if you never touch them. Tags become
filter chips as soon as you create one; priority colours the row's left edge,
because it outranks every derived signal and you should be able to see why a row
is on top.

**Embedded terminals, no tmux.** The server holds the PTYs directly, so xterm.js
gets native scrolling, a real scrollbar, and search across the whole buffer.
Raw output is logged to `~/.claude-terminal/logs/` so scrollback survives a
reload. Sessions survive closing the window; they do not survive the daemon
being killed, which is the deliberate trade for the scrolling.

**A dropped connection is not a dropped session.** The socket is closed by a
laptop sleep or any network gap, but the PTY on the other side is fine — so the
pane reconnects on its own with backoff and replays its scrollback, and says so
rather than looking frozen. Nothing in the recovery path touches the running
process.

## Install

**macOS** — grab the `.dmg` for your chip from
[Releases](https://github.com/ritwik-g/claude-terminal/releases)
(`mac-arm64` for Apple Silicon, `mac-x64` for Intel), open it, and drag
**Claude Terminal** to Applications. It is **not code-signed**, so Gatekeeper
will refuse the first launch. Either right-click the app and choose *Open*, or:

```bash
xattr -cr "/Applications/Claude Terminal.app"
```

Quitting the app (⌘Q) stops the server and closes every terminal it started —
it asks first if any are still running. Sessions in your own terminals are never
affected.

**Build it yourself:**

```bash
npm install
npm run dist:mac     # -> release/*.dmg and release/*.zip (host architecture)
npm run app          # run the desktop app from source
```

**Cutting a release.** `.github/workflows/release.yml` builds macOS arm64,
macOS x64 and a Linux AppImage on their own native runners — one per
architecture, which is far more reliable for a native module than
cross-compiling — and attaches every installer to a GitHub Release:

```bash
npm version patch          # or edit package.json
git push --follow-tags     # tag v* triggers the workflow
```

There is also a `workflow_dispatch` trigger, so a release can be re-cut without
moving a tag.

### Headless / Linux

There is no packaged Linux app yet (`npm run dist:linux` builds an AppImage but
is untested). The server runs fine without Electron — use your own browser:

```bash
npm install                 # postinstall repairs node-pty's broken arm64 prebuild
bin/claude-terminal         # builds if needed, starts the server, opens a window
bin/claude-terminal status  # is it running, and as which pid
bin/claude-terminal stop    # SIGTERM the real listener (flushes tags, closes PTYs)
```

> **Native module note.** `node-pty` must be compiled for whichever runtime is
> loading it, and Electron's ABI differs from Node's — so the app and the CLI
> cannot share one build. `npm run dist` restores the Node build when it
> finishes; `npm run app` switches to the Electron build. If the CLI ever dies
> with a version mismatch, `npm run rebuild:node` puts it back.
>
> Builds also need a Python with `distutils`, which was removed in 3.12.
> `scripts/find-python.mjs` locates a usable one automatically (on macOS,
> `/usr/bin/python3`).

Or during development, with hot reload:

```bash
npm run dev          # server on :7777, Vite on :5273
```

Check the indexer against your real data, and smoke-test the API:

```bash
npm run doctor   # what the scanner sees: titles, states, live registry, timings
npm run smoke    # 35 black-box API checks; never spawns a real session
```

## Keys

| Key | Action |
|---|---|
| `j` / `k` | move down / up |
| `Enter` | open an embedded terminal |
| `/` | search titles, prompts, tags, branches, PRs |
| `p` | cycle priority |
| `x` | pin |
| `t` | add a tag |
| `s` | snooze 4h |
| `r` | refresh |
| `Cmd+F` | search inside the terminal |

Keys never fire while the terminal has focus — Escape is the most-pressed key in
Claude Code, and it belongs to the session, not to this app.

Use **+ New** to start a fresh session in any directory. It runs before Claude
has registered a session id, and adopts itself into the list once it does.

## Testing conventions

**Do functional and click testing in Chrome, against `http://localhost:7777`.**
The Electron window and the browser render the *same* page from the *same*
server, so anything about behaviour — clicking rows, keyboard shortcuts, filters,
opening a terminal, reconnect — is far easier to drive and inspect there.
Synthetic clicks into a packaged macOS app (System Events) are unreliable and
tell you less when they fail.

**Verify the packaged app with a simple screenshot instead.** What the `.app`
build needs to prove is only what packaging can break:

1. it launches at all,
2. the window renders and everything is visible (no blank page, no missing
   assets, nothing overlapping — this is how the traffic-lights-over-the-brand
   bug was caught),
3. its embedded server answers (`curl localhost:7777/api/health`),
4. a PTY actually spawns from inside the bundle — the asar/spawn-helper path.

```bash
open -a "Claude Terminal"
curl -s localhost:7777/api/health
# window bounds, then capture just that region
osascript -e 'tell application "System Events" to tell process "Claude Terminal" \
  to get {position, size} of front window'
screencapture -x -R"<x>,<y>,<w>,<h>" /tmp/app.png
```

Both need macOS **Accessibility** (for window bounds) and **Screen Recording**
(for the capture) granted to the terminal — they are separate toggles in
System Settings > Privacy & Security.

## Where state lives

Everything this tool owns is under `~/.claude-terminal/` — `state.json` (tags,
priority, pins, snoozes), `index-cache.json`, and `logs/`. It **never writes to
`~/.claude`**; that directory is read-only as far as this tool is concerned.

If `state.json` exists but cannot be read, the server refuses to write over it
and goes read-only for the session, saying so in the UI. A whole-file
write-then-rename over a file you failed to load is the one way a tool like this
silently destroys everything you hand-entered.

## Notes

- **Sessions already running elsewhere cannot be attached.** Resuming a live
  session would put two clients on one transcript, so the UI blocks it and tells
  you the pid instead.
- **Spawned sessions get a cleaned environment.** Claude Code's own session
  markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_*`,
  `CLAUDE_EFFORT`, …) are stripped before spawning. Inheriting them silently
  disables transcript saving and leaks the parent's messaging channel. Because
  the spawn goes through a login shell, anything you export from your own shell
  config is still applied.
- Indexing 1200+ transcripts across ~600MB takes well under a second. Files
  under ~1.25MB are read whole; larger ones are sampled head+tail. Results are
  cached by mtime+size, so a refresh costs single-digit milliseconds.
- **The list order is frozen while your pointer is over it.** The ranking is
  genuinely live — scores decay, sessions flip busy/idle, git state changes on
  every save — so without this a row can move between seeing it and clicking it.
  Contents still update; only positions hold still, and only while you're aiming.
- The server refuses cross-origin requests and non-loopback Hosts. "Bound to
  localhost" is not a boundary against a *browser*: WebSockets are exempt from
  CORS, so any page you visit could otherwise have typed into a live session.

## Prior art

`clsm` ([claude-session-manager](https://github.com/ritwik-g/claude-session-manager))
covers browsing, searching and deleting sessions, and is where the transcript
parsing approach came from. This is a separate tool because it is stateful and
owns processes — a different blast radius.
