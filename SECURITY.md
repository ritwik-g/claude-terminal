# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/ritwik-g/claude-terminal/security/advisories/new)
rather than opening a public issue.

This is a personal project maintained in spare time. Expect an acknowledgement
within a week. There is no bounty.

## What this app actually does

Understanding the trust model makes it easier to judge whether something is a
bug or the intended design:

- It runs **entirely on your machine**. It makes no outbound network requests of
  its own — no telemetry, no analytics, no update check, no error reporting.
- It **reads** `~/.claude/` — your Claude Code transcripts and the live session
  registry. That is its whole input, and transcripts contain your real work. It
  also reads `~/.claude.json`, Claude Code's config file, for the cached usage
  numbers shown in the header.
- It **writes** to `~/.claude-terminal/` — ranking state, a scan cache, and the
  scrollback of terminals it started.
- To refresh the usage figure it **starts a throwaway `claude` session** — in an
  empty directory in your temp dir, never a project of yours — sends `/usage`,
  and reads the result out of Claude Code's config. That session talks to
  Anthropic, exactly as running `/usage` yourself does; this app still sends
  nothing anywhere. It runs at most every 10 minutes and only while the window
  is on screen. It submits no prompt, so it costs no tokens, runs no tool, and
  leaves no transcript.
- It **binds a local HTTP server** on `127.0.0.1` and **spawns PTYs** running
  `claude`. The Electron window is a client of that server.

## Known limitations

These are documented rather than fixed, so you can decide if they matter to you:

- **The local server trusts every caller on your machine.** Requests are gated
  against DNS rebinding and hostile web pages (loopback `Host` plus a
  same-origin `Origin`, and a per-run token), but any process running as *you*
  can read that token and drive the app. On a single-user laptop this is the
  same privilege boundary your shell already has.
- **Releases are ad-hoc signed, not notarized.** Apple Developer ID signing
  requires a paid membership this project does not have. Verify downloads
  against the published `SHA256SUMS` and the build provenance attestation, or
  build from source — the README explains both.
- **It depends on undocumented Claude Code internals** (transcript record
  shapes, `~/.claude/sessions/<pid>.json`, the cached usage payload in
  `~/.claude.json`). Those can change without notice — `npm run probe:usage`
  checks the usage path in isolation when it looks like it has.

## Scope

In scope: anything that lets a *remote* page, another local user, or a hostile
repository or transcript gain access it should not have.

Out of scope: the fact that a process already running as your user can reach
the local server; unsigned release binaries; and anything requiring physical
access to an unlocked machine.
