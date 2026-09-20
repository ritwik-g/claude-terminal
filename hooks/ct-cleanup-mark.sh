#!/usr/bin/env bash
#
# Mark this Claude Code session "cleaned up" in claude-terminal.
#
# Runs as a UserPromptSubmit hook. Claude Code pipes the prompt as typed and
# the session id in on stdin; when the prompt is a cleanup invocation this
# PATCHes that session's state in the claude-terminal server — exactly what
# pressing `c` in the app does, so the row gets its tint and chip and turns up
# under the Cleanup filter without you having to remember the keystroke.
#
# Never blocks, never speaks, never fails a prompt. The app not being running,
# a missing token, a session the server has not scanned yet: every one of them
# is a reason to do nothing, not to interrupt what you were actually typing.
set -uo pipefail

# What counts as a cleanup invocation, matched against the prompt as typed.
# The slash command alone, so nothing is ever marked by accident. To catch
# prose as well, widen it — at the cost of false positives on prompts like
# "clean up the dead code in utils.ts":
#
#   TRIGGER='^[[:space:]]*(/cleanup|clean[ -]?up)([[:space:]]|$)'
#
TRIGGER='^[[:space:]]*/cleanup([[:space:]]|$)'

PORT="${CT_PORT:-7777}"
TOKEN_FILE="$HOME/.claude-terminal/token"

payload=$(cat)

# No jq, no parse. Bailing beats guessing at JSON with a regex.
command -v jq >/dev/null 2>&1 || exit 0

# stderr discarded: a payload this cannot parse is not something the person
# typing needs told about, and a hook that prints is a hook that interrupts.
prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)

[ -n "$session" ] || exit 0
printf '%s' "$prompt" | grep -Eq "$TRIGGER" || exit 0

# The server mints a fresh token per run and writes it 0600. No token means no
# server, or one we are not entitled to drive.
[ -r "$TOKEN_FILE" ] || exit 0
token=$(cat "$TOKEN_FILE")

curl -sS --max-time 5 -X PATCH \
  -H 'Content-Type: application/json' \
  -H "x-ct-token: $token" \
  --data '{"cleanup":true}' \
  "http://127.0.0.1:${PORT}/api/sessions/${session}/state" >/dev/null 2>&1 || true

exit 0
