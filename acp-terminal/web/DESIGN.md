# CodePit design system

CodePit is a workspace where one person supervises several AI coding agents.
The UI should feel like a calm, precise professional tool (think Linear, Raycast,
Zed): dense but readable, quiet by default, and loud only when something needs
the user.

## Principles

1. **Attention first.** Sessions that need the user (approval, their turn) stand
   out; everything else recedes. Colour is reserved for state, not decoration.
2. **Quiet chrome, rich content.** Borders are hairlines, surfaces differ by one
   step, and there are no gradients or glows on chrome. The agent's work
   (messages, tool calls, diffs, terminal output) is the visual focus.
3. **One way to do each thing.** Use the components in `web/src/ui` for buttons,
   badges, fields, tabs, switches, segmented controls, choice cards, progress
   bars, stats and empty states. Don't restyle raw elements that a primitive covers.
4. **Both themes, always.** Every colour comes from `design/tokens.css`. Never
   hard-code hex or rgba values in components or CSS. Check your screens in
   dark and in light (`document.documentElement.dataset.theme = 'light'`).
5. **No emoji in the interface.** Use `<Icon name=…>` from
   `components/Icons.tsx`, and add icons there (lucide-style 24px strokes) if one
   is missing. Vendor identity uses `VendorIcon`. Agent- or user-written content
   may contain emoji; that's fine.
6. **Plain language.** Write "Your turn", not "NEEDS_YOU (140)". Use sentence
   case for labels and buttons. Say what a button does ("Start session", not
   "Launch"). Error messages say what happened and what to do next.
7. **Keyboard and screen reader friendly.** Every interactive element is a
   `<button>`, `<a>` or form control; icon-only buttons have `aria-label`
   (`IconButton` enforces this); focus is visible; dialogs use `Modal`.

## Tokens (design/tokens.css)

| Group | Tokens |
| --- | --- |
| Backgrounds | `--bg` (app), `--bg-subtle` (sidebar), `--surface`, `--surface-2` (hover/raised), `--surface-3` (active), `--surface-inset` (inputs, code, terminal), `--overlay` |
| Borders | `--border`, `--border-strong`, `--focus-ring` |
| Text | `--text`, `--text-2` (secondary), `--text-3` (tertiary/meta), `--text-on-accent` |
| Accent | `--accent` (text/icons), `--accent-solid` (fills), `--accent-soft`, `--accent-border` |
| Status | `--ok`, `--warn`, `--danger`, `--info`, each with `-soft` and `-border` |
| Code | `--code-bg`, `--code-text` |
| Type | `--font-ui`, `--font-mono`, `--text-xs` 11 / `-sm` 12 / `-base` 13 / `-md` 14 / `-lg` 16 / `-xl` 20 / `-2xl` 26 |
| Space | `--space-1` 4 … `--space-8` 32 (4px grid) |
| Radius | `--radius-xs` 4, `-sm` 6, default 8, `-lg` 12, `-xl` 16, `-full` |
| Elevation | `--shadow-sm`, `--shadow`, `--shadow-lg` (popovers and dialogs only) |
| Layout | `--sidebar-width` 300, `--content-max` 860, `--header-height` 56 |

The tone classes `.tone-neutral|accent|ok|warn|danger|info` set `--tone`,
`--tone-soft` and `--tone-border` for custom elements.

## Session states

| State | Label | Tone |
| --- | --- | --- |
| blocked | Needs approval | danger |
| needs_you | Your turn | warn |
| working | Working | accent (pulsing dot) |
| parked | Parked | neutral |
| quiet | Idle | neutral |
| snoozed | Snoozed | info |
| crashed | Crashed | danger |
| agent stopped (isAgentRunning === false) | Agent stopped | neutral |

## Type and density

- Base text 13px; conversation prose 14px / 1.65. Monospace for commands,
  paths, model ids and code.
- Controls: 32px (md) or 26px (sm) tall. Headers 56px.
- Section titles are 14px semibold, never ALL CAPS except tiny group labels
  (11px, letter-spacing 0.05em, `--text-3`).

## Layout

- App shell: sidebar (`--bg-subtle`, 300px) + main (`--bg`).
- Conversation column max-width `--content-max`, centred, with the composer
  aligned to the same column.
- Dialogs: `Modal` with a header (title + optional description + close button),
  a body with 16–24px padding, and a footer with actions right-aligned (primary
  last). Widths: 480 (simple), 640 (forms), 880 (dashboards).

## Components (web/src/ui)

`Button` (primary | secondary | ghost | danger | danger-ghost; sm | md | lg;
icon, loading), `IconButton`, `Badge`, `StatusDot`, `Card`, `Field` + `Input` +
`Textarea`, `Segmented`, `ChoiceCard`, `Switch`, `Tabs`, `Kbd`, `EmptyState`,
`Progress`, `Stat`, `SectionHeader`, plus `Icon` and `Spinner`. Also available:
`components/Menu.tsx` (overflow menu) and `components/Modal.tsx` (dialog shell).

## Brand

- The name is **CodePit**, one word. Tagline: "A pit wall for your coding agents".
- Motor racing is flavour only: the icon, a tooltip, an empty state. State labels
  and buttons stay plain ("Your turn", not "Box, box").
- The icon is a pit board showing `>_`. Sources are `build/icon.svg` and
  `build/icon-small.svg` (16 and 32 px); `node scripts/render-icons.mjs`
  regenerates the PNG and `.icns`. The favicon and sidebar logo use
  `web/public/favicon.svg` via `components/BrandMark.tsx`.

## Seeing your work

```bash
ACP_APP_DIR=/tmp/<you>/app npx tsx scripts/seed-ui-fixtures.ts
npx vite build
ACP_APP_DIR=/tmp/<you>/app PORT=<port> ACP_ENABLE_MOCK=1 npx tsx server/cli.ts
```

The seeded sessions cover every state, split messages, a subagent, a plan, a
failed command and an 80-exchange transcript. For live approvals and streaming,
start a Built-in Demo Agent session and send "please run a command".
