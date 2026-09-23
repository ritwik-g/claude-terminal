# Claude Terminal

**Which of your Claude Code sessions needs you right now — and get into it without leaving the window.**

Sessions pile up. Some are a quick PR review, some are week-long explorations,
some you parked on purpose. A flat, recency-sorted list can't tell those apart,
so finding the one that actually needs you means opening several and reading
them. This ranks them by attention instead, and gives you a real terminal in the
same window.

> **Not affiliated with, endorsed by, or sponsored by Anthropic.** An unofficial
> personal project that works *with* Claude Code. "Claude" is a trademark of
> Anthropic, used here only to say what this tool is for.

**Runs entirely on your machine.** It makes no network requests of its own — no
telemetry, no analytics, no update check. It reads your Claude Code transcripts
under `~/.claude/` (and never writes there), keeping its own state in
`~/.claude-terminal/`. The one thing that reaches the network is the usage
figure in the header, and only indirectly: it asks Claude Code for your usage,
and Claude Code asks Anthropic — the same call `/usage` makes when you run it
yourself. The other is **Keep warm**, and only when you turn it on for a
session: it types a one-line message into that session, which Claude Code sends
like any other turn. See [SECURITY.md](SECURITY.md) for the full trust model.

---

## What you get

| | |
|---|---|
| **Ranked by attention, not recency** | Sessions group into *Needs you / Working / Parked / Quiet / Snoozed*. Every row carries a `reasons` trail, so the ranking is always inspectable — never a black box. |
| **Questions surface first** | A session stopped on a question — a permission prompt, a multiple-choice ask, a plan waiting for approval — sorts to the top of *Needs you* and says what was asked. Nothing in it can move until you answer. |
| **Work left behind is noticed** | Uncommitted files and unpushed commits move a session up and are named on its row, but only when they belong to that session, so a shared checkout doesn't flag every session opened in it. |
| **Session types, derived** | `✓ review`, `⚡ errand`, `◆ task`, `∞ thread` — read off the transcript and filterable. No tagging required. |
| **Terminals in the same window** | Real PTYs, native scrolling, a real scrollbar, and search across the whole buffer. No tmux. |
| **Start a session anywhere** | **+ New** opens Claude Code in any folder: type a path, browse to it inline, or use the OS folder picker. The new session joins the list once Claude Code registers it. |
| **A dropped connection is not a dropped session** | After a laptop sleep or a network gap, a terminal pane reconnects on its own and replays its scrollback. The running process is never touched. |
| **Reviews link what they review** | A session opened with a review command links **every** PR it covers, not just the first. |
| **Artifacts, front and centre** | What a session *published* leads its detail pane and opens on claude.ai in a click. Revisions collapse into one row with a version count. |
| **Search that reads the conversation** | Titles, ids, tags, branches, cwds, PR numbers — **and the messages themselves**, so a phrase you remember typing finds the session. |
| **Branch and rename from the app** | Runs Claude Code's own `/branch` and `/rename` in the live session, so it stays the source of truth for its own title and lineage. |
| **Tells you when something finished** | A session that stops working raises a desktop notification and a dock badge, and puts a pulsing dot on the row until you open it. Debounced, so a gap between turns is not reported as a finish. |
| **Usage at a glance** | How much of your 5-hour window is gone and the clock time it resets at, in the header. Hover or click for both windows in full, with their reset times, and a refresh button of its own. It is the account-wide window every session shares, so it is the number that decides whether now is the time to start something big. |
| **And it warns you before it bites** | A bar across the top when a window passes 80%, or 30 minutes before one resets — with a desktop notification when the app is not focused. Both numbers are settings. |
| **…and before a session's cache runs out** | Each running session shows how long its prompt cache has left (`⏱ 34m`). When a big one is 20 minutes from expiring and isn't being kept warm, a bar and a desktop notification offer **Keep warm** and **Compact**, while the cache still makes either one cheap. Once it has expired it isn't listed, because the next turn pays for the rewrite whatever you do. The lead time, the size floor and the switch are all settings. A reminder at 12:00 and 16:00 lists every big session with a warm cache, so you can compact before lunch or the end of the day. |
| **Keep a session's cache warm while you step away** | Claude Code's prompt cache expires an hour after a session's last turn, and your next message then pays to write the whole conversation back into it. **Keep warm** (2h to 24h, or until you reply) sends a one-line message about 45 minutes after the last turn, so the cache is read, at a tenth of the price, instead of rebuilt. It only types when the session is idle, isn't showing a dialog or question, and has nothing unsent in its input box. If you've typed without sending, it warns you, and unless you dismiss the warning it turns itself off rather than type on top of your draft. |
| **Context size, where it costs** | A running session with a large context shows its size on the row (`412k`), read from the last turn's own token usage rather than the transcript's size on disk. Idle sessions don't show it, because they aren't costing anything. |
| **Triage by hand when you want to** | Priority, pin, tags and snooze are one key each. They adjust the derived ranking but never replace it, so the list still works if you never set any of them. |
| **Snoozes wake when your day does** | *tomorrow* and *next week* mean 9am on the next working day, not "+24h" and "+7d" — a Friday evening snooze comes back on Monday morning. The hour is a setting, and **custom…** takes any duration or an exact moment. Snoozing a big session whose cache would expire before it wakes asks whether to compact it first. |
| **A woken session says so** | A session whose snooze ran out rejoins the list in whatever position its score earns, which is silent. It now carries a *woke 41m* chip and a tinted edge until you open it. |
| **Mark a session cleaned up** | `c` tints the row and chips it, so the session you tidied up is findable again among a dozen that look identical. A **Cleanup** filter in the sidebar collects them, to close and archive in one pass. |
| **The cleanup mark can set itself** | Ship `/cleanup` and a one-line hook, and the session marks itself the moment you run it — see [Marking cleanup automatically](#marking-cleanup-automatically). |
| **Your working set survives a quit** | The terminals you had open are offered back on the next launch, in one click. |
| **Active only, by default** | Opens showing just what's running — one click to see everything, and searching overrides it, so nothing is ever unreachable. |
| **A list that holds still** | Rows stay in place while your pointer is over the list, so a live re-rank can't move a row before you click it. The list can be resized or hidden to give the terminal the full width. |
| **Keyboard first** | `j`/`k`, `Enter`, `/` and single keys for every triage action ([Keys](#keys)). The shortcuts never fire while the terminal has focus, so Escape always reaches the session. |

## Install

**Requires [Claude Code](https://claude.com/claude-code).** This tool reads its
transcripts and drives its sessions; it isn't useful on its own.

### macOS — download a release

Grab the `.dmg` for your chip from
[Releases](https://github.com/ritwik-g/claude-terminal/releases)
(`mac-arm64` for Apple Silicon, `mac-x64` for Intel), open it, drag
**Claude Terminal** to Applications.

**Verify it before you run it.** These builds are unsigned, so the digest is how
you tell this artifact from any other. Every release attaches `SHA256SUMS-*.txt`,
and every installer carries signed build provenance:

```bash
shasum -a 256 -c SHA256SUMS-macos-14.txt
gh attestation verify Claude.Terminal-0.4.0-mac-arm64.dmg --repo ritwik-g/claude-terminal
```

Then let macOS open it:

```bash
xattr -dr com.apple.quarantine "/Applications/Claude Terminal.app"
```

Stripping quarantine turns off Gatekeeper's check for that app permanently, so
it is worth knowing what you are running before you do it. Building from source
skips this entirely.

**You need that command, and without it macOS will tell you the app is
damaged.** It is not damaged. These builds are ad-hoc signed rather than signed
with an Apple Developer ID, because that requires a paid Developer Program
membership ($99/yr) that this project does not have. Your browser attaches
`com.apple.quarantine` to anything it downloads, and for a quarantined app
without a Developer ID signature, Gatekeeper on Apple Silicon reports
*"is damaged and can't be opened. You should move it to the Bin"* — which is
alarming, wrong, and offers no way past it.

Do **not** move it to the Bin. Run the command above, which strips the
quarantine flag from that one app, and it will open normally from then on. You
need it once per download, so it applies again after every update.

**Or let a script do all of it.** `scripts/install-release.sh` is the whole
sequence above in one command — download the build for your chip, check it
against the published digest, replace the app, strip quarantine:

```bash
scripts/install-release.sh            # latest release
scripts/install-release.sh 0.12.1     # a specific one
```

It needs the [GitHub CLI](https://cli.github.com), refuses to install anything
whose digest does not match, quits a running Claude Terminal first, and keeps
the app it is replacing until the new one is in place.

Two things that do *not* work here, though both are the usual advice:
**right-click → Open** (that path exists for apps that are signed but not
notarized — this one has no Open option at all), and a free Apple developer
account (its certificates cannot notarize, so they change nothing here).

Deleting the app bundle is harmless either way: everything the tool remembers
lives in `~/.claude-terminal/`, not in the bundle.

### Build from source — no Gatekeeper at all

An app you build on your own machine is never quarantined, so it just opens.
For a personal tool this is the path of least friction:

```bash
git clone https://github.com/ritwik-g/claude-terminal.git && cd claude-terminal
npm install
npm run dist:mac     # -> release/*.dmg and release/*.zip (host architecture)
```

Then drag **Claude Terminal** out of `release/` into Applications. Or skip
packaging entirely and run it from source with `npm run app`.

Quitting the app (⌘Q) stops the server and closes every terminal it started —
it asks first if any are still running, and offers to reopen them next launch.
Sessions in your own terminals are never affected.

### Linux / headless

Releases carry an `x86_64.AppImage`, but it has only ever been *built* — never
run — so treat it as untested. The server runs fine without Electron either
way; use your own browser:

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

**Search reaches the conversation, not just the labels.** `/` matches titles,
session ids, prompts, tags, branches, cwds and PR numbers — and the messages
themselves, so a phrase you remember typing finds the session even when nothing
in its metadata mentions it. Message text is indexed server-side and
deliberately kept out of the session payload: at ~14KB a session it would add
megabytes to every poll for something the client never renders. `/api/search`
answers that half and the results are merged with the local match.

The index is bounded — roughly 12KB of what you said and 8KB of what Claude
replied, taken from the same head+tail windows the scanner already reads. Your
own words get the larger share because they are what you actually search for.
On a 135-session corpus that is a 1.9MB index answering in under 30ms.

## Keys

| Key | Action |
|---|---|
| `j` / `k` | move down / up |
| `Enter` | open an embedded terminal |
| `/` | search titles, prompts, tags, branches, PRs |
| `p` | cycle priority |
| `x` | pin |
| `t` | add a tag |
| `c` | mark cleaned up |
| `s` | snooze 4h |
| `r` | refresh |
| `[` | hide / show the session list |
| `?` | help — every key, what each group means |
| `Cmd+F` | search inside the terminal |

Keys never fire while the terminal has focus — Escape is the most-pressed key in
Claude Code, and it belongs to the session, not to this app.

### Marking cleanup automatically

`c` marks a session cleaned up by hand. If you wind sessions down with a command
of your own, the mark can set itself instead — `hooks/` carries the two files:

```bash
mkdir -p ~/.claude/hooks ~/.claude/commands
cp hooks/ct-cleanup-mark.sh ~/.claude/hooks/
cp hooks/cleanup.md ~/.claude/commands/
```

Then register it in `~/.claude/settings.json`, merging with whatever is already
there rather than replacing it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/ct-cleanup-mark.sh",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Typing `/cleanup` in any session now marks it here, because Claude Code hands
the hook the prompt as typed and the session id, and the hook makes the same
write the `c` key makes. Sessions already open do not pick it up — settings are
read at startup — so open `/hooks` once or start a new session.

`cleanup.md` is a starting point for what the command should *do*; edit it to
match how you actually wind a session down. The hook does not read it — it only
cares that you typed `/cleanup`.

The trigger is deliberately the slash command alone, so nothing is marked by
accident: "clean up the dead code in utils.ts" does not match. `TRIGGER` at the
top of the script widens it if you would rather catch prose, at the cost of
false positives. `npm run test:hook` covers both halves of that.

It fails silently and on purpose. No app running, no token, a session the
server has not scanned: each one makes the hook exit 0 without a word, because
it stands in front of every prompt you type and a marker missed is a far
smaller problem than a prompt broken. Set `CT_PORT` if the app is not on 7777.

Use **+ New** to start a fresh session in any directory. It runs before Claude
has registered a session id, and adopts itself into the list once it does.

The list can also be dragged wider or narrower by its right edge (double-click
that edge to reset it), and hidden entirely when you want the terminal full
width. Both the width and the hidden state persist. Resizing tells the PTY its
new size only when the character grid actually changes — a drag crosses a cell
boundary a few dozen times, and sending a `SIGWINCH` per animation frame
instead would make Claude Code redraw its whole interface 60 times a second.

## How it works

The short version is above. Each of these opens up the reasoning and the
measurements behind a piece of it.

<details>
<summary><b>Ranks by attention, not recency</b></summary>

Sessions are grouped into *Needs you /
Working / Parked / Quiet / Snoozed*, and every session carries a `reasons` trail
explaining its position — the ranking is always inspectable, never a black box.

The signals are derived, so the list stays useful with no upkeep:

| Signal | Where it comes from |
|---|---|
| Stopped on a question | Claude Code's own `waiting` status (with the `waitingFor` label it reports), or an unanswered `AskUserQuestion` / `ExitPlanMode` left in the transcript |
| Waiting on you | live process is `idle` — or `shell`, idle with a background shell still running — or the last assistant turn ended with `stop_reason: end_turn` |
| Working now | Claude Code's own `busy` status |
| Stopped mid tool-call | last transcript entry is an unresolved `tool_use` that asked you nothing |
| Work left behind | uncommitted files / unpushed commits **attributable to this session** |
| Has a PR | `pr-link` entries in the transcript |
| Is a review | a review command this session ran itself, not one inherited from a branch parent |

The two question signals are deliberately independent. The live registry is the
only thing that knows about a permission prompt, which leaves no transcript
trace at all; the transcript is the only thing that still remembers a question
you walked away from weeks ago, long after the process is gone. Before this
existed, that second case was reported as *stopped mid tool-call* — an
abandoned question does leave a dangling `tool_use`, so it read as a crash,
which is the opposite of what happened.

</details>

<details>
<summary><b>Errands vs explorations, derived</b></summary>

Every session is classified by shape —
`⚡ errand` (short, single-purpose: a quick question or one-off fix), `◆ task`,
`∞ thread` (a long-running exploration carried across days), or `✓ review`
(opened with a review command, which overrides the others: what a session is
*for* outlasts how long it happened to run) — and you can filter by it. The thresholds come from the real distribution rather than intuition:
across 134 sessions, span is strongly bimodal at p25 = 28 minutes and
p75 = 4.75 days.

</details>

<details>
<summary><b>What the session produced, above what it is</b></summary>

Artifacts a session published
are listed across the top of its detail pane and open on claude.ai in a click.
Republishing an artifact keeps one entry and bumps its version count, because
the URL is the artifact's identity — a document you have revised four times is
one row marked `v4`, not four rows.

These come from two different traces, because Claude Code leaves two. A page
published from a local file writes a `frame-link` record carrying the URL, the
title and the file. An artifact created from an Artifact *type* — a deck, a
document — writes no `frame-link` at all: the URL is stated only in the tool
result, the title only on the call, so the two are paired by `tool_use_id`.
Reading `frame-link` alone showed nothing for those sessions while Claude
Code's own status line still carried the pill. A document-backed artifact is
an ordinary row; it simply has no local file behind it.

Neither goes through the shared scanner. That scanner samples the first
256KB and the last 1MB of each transcript, which is sound for titles and PR links because Claude
Code re-emits those as they change. A `frame-link` is written once, when you
publish, and never again: across this corpus 51 of the 71 artifacts in
transcripts larger than that window fall between the two sampled ranges. So
artifacts are read whole-file, on demand, for the one session you are looking
at — about 60ms for a 14MB transcript, cached on its mtime.

</details>

<details>
<summary><b>Review sessions name what they are reviewing</b></summary>

A session opened with a
review command becomes its own type — `✓ review`, filterable alongside errands,
tasks and threads — and links straight to **every** PR under review, because a
review that compares two PRs or works a stack is a normal thing to do. Because
the type is derived from intent rather than duration, it overrides the
span-based ones: a review that turned into a three-day remediation loop is
still a review, not a thread.

A session **branched off** a review does not inherit the label. `/branch`
copies the parent's conversation into the new transcript, so the parent's
`/pr-review` sits at line 0 of a branch that is reviewing nothing; the
inherited records are tagged `forkedFrom` and only commands this session ran
itself count.
Nothing here is tool-specific: commands are matched by stem — `review`,
`remediation`, `critique` — on the last colon-separated segment, so
`/pr-review`, `/code-review`, `/security-review`,
`/pr-review-toolkit:review-pr`, `/team:standard-review-lite` and
`/team:max-remediation` all land, and a new review tool works with no
change as long as its name says what it does. `remediation` is in that list
because those skills *are* review loops — they run the review repeatedly and
fix what it finds — and none of their names contain "review". The list stays
short deliberately: stems like `audit` would drag in commands that have
nothing to do with code review, and a session wrongly labelled a review is
worse than one left unlabelled.

The PR comes from the command's own arguments, and failing that from the first
PR **you** typed earlier in the session — running `/pr-review` bare after
pasting the link in an earlier message is a normal way to work, and used to
show no link at all. A PR seen only in tool output is never adopted:
transcripts are full of PR URLs in command output, and a confident wrong link
is worse than none. This is derived on every scan and
never written into your tags — an auto-applied tag could not be removed,
because the next scan would put it straight back. The PR a session is
*reviewing* stays distinct from the PR it *raised*; they are usually different,
and both show when they are.

</details>

<details>
<summary><b>Active only, by default</b></summary>

The list opens showing just the sessions Claude
is actually running right now — live in `~/.claude/sessions`, or attached to a
terminal here. Here that is 10 of 129. Attached counts as active on its own
because a session you have just opened takes a second or two to register
itself as live, and the row would otherwise vanish at the moment you opened
it. Snoozed sessions are included when they are running — a session still
working has not really been set aside, and three of the four snoozed ones
here had terminals open in them.

While the filter is applying, groups are not collapsed. Quiet and Snoozed
start collapsed, so a running session in either was counted and then hidden
behind a group header — the toggle read 8 with five rows on screen. Having
asked for only the handful that are running, there is nothing left to
collapse away; the count and the rows always agree.

It is one click to turn off, and it is a default rather than a constraint:
searching, or clicking one of the bucket counts along the top, overrides it,
so a session it hides is never a session you cannot reach. The counts
themselves are deliberately calculated *before* it applies — showing "Quiet 0"
would leave no way to discover the 78 sitting there.

</details>

<details>
<summary><b>Branch and rename, from the app</b></summary>

With a terminal open, **Branch** and

**Rename** run Claude Code's own `/branch` and `/rename` in it. The app does
not reimplement either — it types the command you would have typed, so the
session stays the only source of truth for its own title and lineage. The
route takes a command *name* rather than raw bytes, and builds the text
server-side: a newline in a rename would otherwise submit early and leave the
rest sitting at the prompt as though you had typed it.

Branching is why a terminal's session id is not learned once and kept.
`/branch` forks the session into a new id inside the *same* process, so the
PTY that started out running A is now running B. Believing the first answer
left the branched session — the one you were sitting in — with no terminal at
all, while the pane announced *"Running in another terminal"* about the very
terminal you were typing into. Claude Code keeps one registry file per pid, so
the pid always resolves to exactly one current session and re-reading it
cannot oscillate.

</details>

<details>
<summary><b>The usage warning arrives with something to do about it</b></summary>

A bar appears across the top when a window passes your threshold (80% by
default), or within your lead time of resetting (30 minutes). It fires **once**
per condition per window: the de-duplication key carries the window's own reset
timestamp, so the same 80% cannot nag you every thirty seconds, and the *next*
window's 80% is a different key and is free to fire again. Nothing has to be
cleaned up on a schedule. When the app is not focused the same thing arrives as
a desktop notification; when it is, you are already looking at the bar and a
popup would only teach you to turn popups off.

The reset warning is independent of how fresh the numbers are. A reset time is
a fixed timestamp, so it stays correct however old the reading behind it is —
where a *percentage* whose own window has already rolled over describes a window
that no longer exists, and is suppressed rather than shown.

The compact suggestions that used to ride on this bar now live on a separate
**cache bar**. Whether compacting is cheap depends on the session's prompt
cache, not on the account's window. While the cache is there, a compact reads
the context at about a tenth of the input price. After it expires, compacting
costs a full rewrite of its own. So the cache bar lists running sessions whose
cache expires within 20 minutes (and that keep-warm isn't covering), soonest
first, each with **Keep warm** and a **Compact** button that types
`/compact` at that session's prompt. It is sent the way you would type it, into
a terminal this app owns — a busy session simply queues it — and nothing waits
for a result, because the evidence arrives on its own schedule as the session's
context size dropping on a later scan.

The context chip on a row follows the same rule: it appears on a big running
session whose cache is about to expire, which is exactly when compacting is both
cheap and worth it. Size alone doesn't earn it any more. An 800k-token session
with a fresh cache has nothing to lose yet, and one whose cache has already
gone gains nothing from a compact. A session running in a terminal of your own
is still listed in the bar, because it is still spending; it just says
*elsewhere* instead of offering a button, since there is nothing here to type into.

**Break reminders.** At 12:00 and 16:00 each day (both times, and whether each
is on, are settings), a bar and a desktop notification list the running
sessions that still have a warm cache and pass the size floor, biggest first.
An hour for lunch or overnight will let those caches expire, so this is the
moment to compact them. The lunch reminder also offers **Keep warm**, which
covers a short break. The end-of-day one offers only **Compact**: keep-warm
can run for up to a day, but pinging a big context all night costs about what
the rewrite it saves would. On a Friday it asks whether you're wrapping up
for the weekend. It stays for an hour unless you dismiss it, fires once a day
even if you reopen the app, and says nothing when there is nothing to compact.

**Snoozing a big session.** Snoozing a session past the point its cache
expires first asks whether to compact it, with **Compact and snooze**, **Just
snooze** and **Cancel**. It only asks when the session is above the size floor,
its cache is still warm, a terminal here can take the `/compact`, and keep-warm
isn't covering the whole snooze. The `s` key asks too. And if keep-warm is on
and the snooze outlasts it, keep-warm stops (*snoozed*): the cache would have
expired before the session woke, so the pings in between would buy nothing. A
snooze that ends first leaves it running.

That size is read from the last assistant turn's own `usage` block —
`input + cache_creation + cache_read` — not from the transcript's size on disk.
The file counts tool output and thinking the model is no longer carrying, and
after a `/compact` it keeps growing while the context it describes has just
collapsed. Subagent turns are skipped: their `usage` is the subagent's own
conversation, which disappears with it, so counting one would make a session
that just ran a Task look enormous. The threshold is absolute rather than a
percentage of the model's limit, because the transcript does not record which
limit applies — a 1M-context run and a 200k one both write `claude-opus-5` —
and because what you are managing is cost, which tracks the size of the context
you re-send every turn, not how close it is to overflowing.

</details>

<details>
<summary><b>Keep warm, and when it will not type</b></summary>

A session's prompt cache lives for an hour from its last API call. Reading it
costs about a tenth of the normal input price and resets the hour; letting it
lapse means your next turn writes the whole conversation back in, at about
twice the price. Measured across 80 real sessions, a prompt sent within the hour
hit the cache 93% of the time (564 of 605), and one sent after it missed 140
times out of 145. That miss is what this avoids.

Turn it on from the session's **Keep warm** row: 2h, 4h, 8h, 12h, 16h, 24h, or *until I reply*
(until you next send a message, 24h at most). About 45 minutes after the last
API call, the server types a one-line message at the session's prompt, telling
Claude to reply only "ok". Roughly twenty of those cost what one cold rebuild
does, so it is worth it for a lunch break. A full day is about thirty, which
only pays off for a big context. Every option ends. It runs on the server's own clock, so a hidden or throttled
window does not delay it.

Because the ping is typed, it goes wherever the cursor is. So it is held, never
forced, unless all of these are true:

- **The prompt is free.** Claude Code's registry says `idle`, or `shell` (idle
  with a background shell still running). `busy`, a dialog, or no status yet
  holds the ping. A stuck `busy` therefore costs a missed ping, never a wrong
  one, and **Ping anyway** is there for when you can see the session really is
  idle.
- **Nothing is being asked.** An unanswered question or plan in the transcript
  holds it, whatever the registry says.
- **You have nothing unsent.** Every key you type in an app terminal passes
  through the server, so it knows when you last typed. If that is after the last
  message you sent, the input box may hold a draft, and the session shows a
  warning. **Dismiss** it if the box is empty (a stray key, a deleted draft) and
  pings carry on. Left alone, keep-warm turns itself **off** when the next ping
  is due and tells you. Turning it back on is you saying the box is empty. Keys pressed while a dialog is up go to the dialog, so they don't
  count, and neither do the focus and mouse reports a terminal sends by itself.
- **You have room.** With usage alerts on, pings pause while the 5-hour window
  is past your alert threshold.

It checks its own work. Each reply's `usage` block says whether the ping read
the cache or rewrote it. Two misses in a row on pings that should have hit turn
it off, since it is saving nothing. So does a ping that produced no turn at all,
because its text may be sitting in the input box and a second ping would pile on
top. The ping's own turn is kept out of everything else: it is not announced as
a completion, doesn't move the session's activity time, doesn't become its last
prompt, and isn't searchable.

State is in memory: restarting the app turns keep-warm off, which is also what
happens to the terminals it types into.

</details>

<details>
<summary><b>Manual state is an override, never load-bearing</b></summary>

Tags, P0/P1/P2, pin and
snooze all exist, but the tool works fully if you never touch them. A tag joins
the sidebar's tag menu as soon as you create one, where any number of them can
be filtered on at once; priority colours the row's left edge,
because it outranks every derived signal and you should be able to see why a row
is on top.

A snooze until *tomorrow* or *next week* names the next time you will be at your
desk, not an interval: it resolves to 9am (a setting) on the next working day,
skipping weekends, and is built by mutating a local `Date` rather than by adding
milliseconds so that 9am stays 9am across a DST boundary. `now + 24h` from a
Friday evening wakes on a Saturday, which is neither tomorrow nor useful.
**custom…** takes any duration or an exact moment for the cases the presets miss.

`snoozedUntil` is never cleared when it lapses — ranking simply stops honouring
it — so the record of "this was set aside until now" is still there to read.
That is what lets a woken row say *woke 41m* for a few hours instead of
rejoining the list in silence, and opening the session drops the timestamp for
good: the absence of it **is** the acknowledgement, so the marker survives a
reload without a second store of what you have seen.

</details>

<details>
<summary><b>Embedded terminals, no tmux</b></summary>

The server holds the PTYs directly, so xterm.js
gets native scrolling, a real scrollbar, and search across the whole buffer.
Raw output is logged to `~/.claude-terminal/logs/` so scrollback survives a
reload. Sessions survive closing the window; they do not survive the daemon
being killed, which is the deliberate trade for the scrolling.

</details>

<details>
<summary><b>Your working set survives a quit</b></summary>

The terminals you had open are recorded
as you open and close them, and on the next launch the app offers to reopen
them in one click — so updating it costs you a click rather than an afternoon
of remembering which four sessions you were in the middle of. The offer only
lists what will actually work: the session still exists, its directory is still
there, and it has not been picked up by a terminal of your own in the meantime.
Nothing is reopened without you asking, and dismissing it is permanent.

</details>

<details>
<summary><b>A dropped connection is not a dropped session</b></summary>

The socket is closed by a
laptop sleep or any network gap, but the PTY on the other side is fine — so the
pane reconnects on its own with backoff and replays its scrollback, and says so
rather than looking frozen. Nothing in the recovery path touches the running
process.

</details>

## Requirements

| | |
|---|---|
| **Claude Code** | Required — this tool reads its transcripts and drives its sessions. It is not useful without it. |
| **Node.js** | 20 or newer (22 recommended). Needed to run or build from source. |
| **macOS** | Fully supported. Apple Silicon and Intel; the packaged app is built for both. |
| **Linux** | The headless server (`npm start`) is supported and used. The AppImage builds but is untested. |
| **Windows** | Not supported and not tested. |

Building from source compiles `node-pty`, which needs a C++ toolchain — Xcode
Command Line Tools on macOS, `build-essential` and Python 3.11 on Linux.

## Where state lives

Everything this tool owns is under `~/.claude-terminal/` — `state.json` (tags,
priority, pins, snoozes, and the working set of open terminals),
`index-cache.json`, and `logs/`. It **never writes to
`~/.claude`**; that directory is read-only as far as this tool is concerned.

The browser keeps a little of its own: `ct.selected`, `ct.activeOnly`,
`ct.sidebarW`, `ct.sidebarOpen`, `ct.seenDone` — which completion markers you
have already looked at, so a window reload does not resurrect them — and
`ct.prefs`, the alert thresholds, compaction threshold and snooze wake hour.
Those live here rather than in `state.json` because none of them describe a
session: they are per-person, and every value is range-checked on the way back
in, so a hand-edited file cannot put the alerts into a state where they fire
constantly or never.

If `state.json` exists but cannot be read, the server refuses to write over it
and goes read-only for the session, saying so in the UI. A whole-file
write-then-rename over a file you failed to load is the one way a tool like this
silently destroys everything you hand-entered.

## Good to know

- **Completion notices are debounced, and detected server-side.** A session has
  to stay stopped for `HOLD_MS` (5s, in `server/completions.ts`) before it
  counts as finished — Claude Code reports `idle` the moment a turn ends, and
  firing on that edge announces every gap between turns. Detection runs on the
  server's own 2s tick rather than in the page, because a hidden window's
  timers are throttled to about once a minute, which is exactly when a
  notification is worth having. Set `CT_NOTIFY=0` for the badge without the
  popup. The desktop notification is suppressed while the window is focused;
  the dot on the row is not, and clears when you open the session.
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
- **The local server is gated two ways.** It refuses non-loopback Hosts and any
  Origin that is not its own, which stops a *browser*: WebSockets are exempt
  from CORS, so any page you visit could otherwise have typed into a live
  session. Headers alone stop nothing else, though — a non-browser client sets
  them freely — so the API and the socket also require a token minted at
  startup and written to `~/.claude-terminal/token` (mode 0600). That is what
  keeps a second account on the machine out. It cannot keep out a process
  already running as *you*: that process can read the token, exactly as it can
  read `~/.claude` directly. See [SECURITY.md](SECURITY.md).
- **This depends on Claude Code internals that are not a public API** —
  transcript record shapes, `~/.claude/sessions/<pid>.json`. They can change in
  any Claude Code release and this tool would need updating. That is the deal
  with a tool like this; it is worth knowing before you rely on it.

## Development

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

### Automated checks

| Command | What it covers | Needs |
|---|---|---|
| `npm run smoke` | the HTTP surface, including every input that must be *rejected* before it reaches node-pty | a running server |
| `npm run test:search` | id and text matching against your real session set — that every id is reachable, and that ordinary words do not start matching ids | a running server |
| `npm run test:restore` | the working-set round trip across two full server lifetimes | nothing |
| `npm run test:artifacts` | artifact extraction and review detection, including an artifact stranded mid-file where the sampled scanner is blind, and one published from an Artifact type that leaves no `frame-link` behind | nothing |
| `npm run test:title` | which name a row shows — that a session which cd's into a subdirectory or a worktree keeps its title instead of renaming itself to the folder it started in | nothing |
| `npm run test:branch` | that a terminal follows its session across a `/branch`, and the slash-command route the Branch and Rename buttons drive | nothing |
| `npm run test:usage` | the usage round trip — that a probe is skipped inside Claude Code's write throttle, and that a stale or another account's cache is never served as your current number | nothing |
| `npm run test:alerts` | the usage alerts, the cache-expiry warning, the snooze wake times, and context sizing — that an alert fires once per window and again in the next one, that only live, unwarmed sessions whose cache is still there are warned about, that no wake time lands on a weekend or drifts across a DST boundary, and that context sizes read out of your real transcripts are still sane | nothing |
| `npm run test:completions` | the completion watcher — that a finish is announced once it has held, a gap between turns is not, and a keep-warm ping's own turn is not either | nothing |
| `npm run test:keepwarm` | keep-warm's rules on a fake clock — that it types only into an idle (or `shell`) session with no dialog, question or unsent typing, turns itself off over a draft, and gives up on a cache that keeps missing | nothing |
| `npm run test:keepwarm-routes` | the same through the real server, a real PTY and the terminal socket, against a stub `claude`: a draft stops it, and a cleared box gets the ping as one submitted line | nothing |
| `npm run test:hook` | the cleanup hook — that it marks on the command and **not** on prose that merely says "clean up", and that it exits silently on every failure it can meet | nothing |
| `npm run probe:usage` | the usage probe against your real Claude Code, printing what came back — for when the numbers stop moving and you need to see which half broke | Claude Code, logged in |

`test:restore` builds a throwaway `HOME` with synthetic transcripts and a stub
`claude` on the PATH, because verifying it means opening terminals, quitting and
reopening — and doing that against your real sessions would resume them for
real. It never touches `~/.claude` or `~/.claude-terminal`.

`test:usage` builds a throwaway `HOME` whose stub `claude` writes a usage
payload when it is sent `/usage`, so the whole path — start a session, send the
command, read the config back — runs without a login and without touching your
real `~/.claude.json`. `probe:usage` is the opposite: it drives the real thing,
which is what you want when the question is whether Claude Code still behaves
the way the module assumes.

`test:artifacts` builds a throwaway `HOME` too, including a transcript
deliberately larger than the scanner's sampling window with its only artifact
buried in the middle. That case is the reason the module exists: swap the
whole-file read for head-only sampling and every other check in the file still
passes.

`test:title` builds a throwaway `HOME` with a synthetic live registry as well,
because the name a row shows is a negotiation between the registry and the
transcript: Claude Code's invented `<dirname>-<2-4 hex>` fallback must lose to
an ai-title, and a name you chose must win. The fallback is minted once, from
the directory the session *started* in, so the test moves sessions away from
there — which is what used to break it.

### Cutting a release
**Cutting a release.** `.github/workflows/release.yml` builds both macOS
architectures on one Apple Silicon runner and a Linux AppImage on its own, then
attaches every installer to a GitHub Release:

```bash
npm version patch          # or edit package.json
git push --follow-tags     # tag v* triggers the workflow
```

There is also a `workflow_dispatch` trigger, so a release can be re-cut without
moving a tag.

### The icon

`npm run icon` regenerates `build/icon.png`, `build/icon.icns` and the DMG
background from `scripts/icon-designs.mjs`, which holds every design that was
considered — `make-icon.mjs` only names the one that ships. There are no image
dependencies: the artwork is rasterised from geometric predicates and the PNG
is written by hand, so the options you preview are pixel-identical to what gets
packaged, with no SVG-to-raster step in between where they could diverge.

```bash
node scripts/icon-designs.mjs sheet   # contact sheet of every option, at 160px and 32px
```

Each `.icns` representation is rendered at its own resolution rather than
downscaled from the 1024 master: the stroke is a fraction of the icon size, so
rendering at 16px gives a crisp two-pixel stroke where a downscale gives a grey
smear — and 16px is what Finder's list view actually uses. That step needs
`iconutil`, so it is skipped off macOS and the committed `.icns` is kept.

## Prior art

`clsm` ([claude-session-manager](https://github.com/ritwik-g/claude-session-manager))
covers browsing, searching and deleting sessions, and is where the transcript
parsing approach came from. This is a separate tool because it is stateful and
owns processes — a different blast radius.
