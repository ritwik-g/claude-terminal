import fs from 'node:fs';
import { ensurePrivateDir, getAppDir, getSettingsFile, FILE_MODE } from './paths.js';
import { getPricingForModel } from './subscriptions.js';
import type { AcpSession, AutoCompactSetting, TurnMessage } from './types.js';

/** Thresholds offered for "Compact when finished", in percent of the context window. */
export const AUTO_COMPACT_THRESHOLDS = [30, 50, 70] as const;
export const DEFAULT_AUTO_COMPACT: AutoCompactSetting = { enabled: false, thresholdPercent: 50 };

/**
 * Sent to agents without their own compaction. The reply becomes the summary
 * the restarted agent gets as its first context, so it has to stand on its own.
 */
export const HANDOFF_SUMMARY_PROMPT = [
  'Your context is about to be reset. Write a handoff summary so that you can carry on from it alone, with no other record of this conversation.',
  'Do not use any tools or change any files; answer from what you already know.',
  'Use these headings:',
  '## Goal: what the user is trying to achieve, in their words where it matters.',
  '## Decisions: choices made and why, including approaches that were tried and dropped.',
  '## Files changed: each path and what changed in it.',
  '## Current state: what works, what is broken or unverified, and anything still in progress.',
  '## Next steps: what to do next, in order.',
  'Keep facts, names, numbers and paths exact. Reply with the summary only.',
].join('\n');

// A handoff summary is context for the next agent, not a transcript; keep it bounded.
const SUMMARY_CAP = 16_000;

export function capSummary(text: string): string {
  const t = text.trim();
  return t.length > SUMMARY_CAP ? `${t.slice(0, SUMMARY_CAP)}\n…[summary truncated]` : t;
}

/** Turns written by the old local-only compaction: one system turn holding the note. */
function isLegacyCompactionTurn(turn: TurnMessage): boolean {
  return turn.role === 'system' && !turn.compaction && turn.id.startsWith('compact-') && Boolean(turn.content);
}

/**
 * The newest compaction that left a summary, and its index in `turns`. Earlier
 * turns are covered by that summary. A compaction without a summary (a native
 * one whose agent sent none) cannot stand in for the turns before it, so the
 * search carries on past it to an older checkpoint, or to the start.
 */
export function latestCompaction(turns: TurnMessage[]): { index: number; summary: string } | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const c = turn.compaction;
    if (turn.role === 'system' && c?.status === 'completed' && c.summary?.trim()) {
      return { index: i, summary: c.summary.trim() };
    }
    if (isLegacyCompactionTurn(turn)) return { index: i, summary: turn.content!.trim() };
  }
  return null;
}

/** The session's context window: what the agent reports when known, else the model table. */
export function contextWindowFor(session: AcpSession): number {
  if (session.contextWindow && session.contextWindow > 0) return session.contextWindow;
  return getPricingForModel(session.model).contextWindow;
}

export interface AutoCompactInput {
  setting?: AutoCompactSetting;
  /** How the turn ended; only 'end_turn' is a clean finish. */
  stopReason?: string;
  queuedCount: number;
  backgroundRunning: boolean;
  pendingPermission: boolean;
  contextTokens: number;
  contextWindow: number;
}

/** Whether a finished turn should be followed by an automatic compaction, and why not when it shouldn't. */
export function autoCompactDecision(input: AutoCompactInput): { compact: boolean; reason: string; waitForBackground?: boolean } {
  const { setting } = input;
  if (!setting?.enabled) return { compact: false, reason: 'off' };
  if (input.stopReason !== 'end_turn') return { compact: false, reason: `turn ended with ${input.stopReason ?? 'no stop reason'}` };
  if (input.queuedCount > 0) return { compact: false, reason: 'queued messages still to send' };
  if (input.pendingPermission) return { compact: false, reason: 'waiting for approval' };
  // Decided again once that work settles, with this turn's stop reason
  if (input.backgroundRunning) return { compact: false, reason: 'background work still running', waitForBackground: true };
  if (!(input.contextWindow > 0) || !(input.contextTokens > 0)) return { compact: false, reason: 'context use unknown' };
  const percent = (input.contextTokens / input.contextWindow) * 100;
  if (percent < setting.thresholdPercent) {
    return { compact: false, reason: `context at ${Math.round(percent)}%, under ${setting.thresholdPercent}%` };
  }
  return { compact: true, reason: `context at ${Math.round(percent)}%, over ${setting.thresholdPercent}%` };
}

/** Validate a setting from the API; null when it is not one. */
export function parseAutoCompact(body: unknown): AutoCompactSetting | null {
  const b = body as Partial<AutoCompactSetting> | null;
  if (!b || typeof b.enabled !== 'boolean') return null;
  const threshold = b.thresholdPercent ?? DEFAULT_AUTO_COMPACT.thresholdPercent;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 5 || threshold > 95) return null;
  return { enabled: b.enabled, thresholdPercent: Math.round(threshold) };
}

// The last choice made in any session is the default for new ones, kept in settings.json.
export function readAutoCompactDefault(): AutoCompactSetting {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
    return parseAutoCompact(parsed?.autoCompact) ?? DEFAULT_AUTO_COMPACT;
  } catch {
    return DEFAULT_AUTO_COMPACT;
  }
}

export function writeAutoCompactDefault(setting: AutoCompactSetting): void {
  ensurePrivateDir(getAppDir());
  const file = getSettingsFile();
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') current = parsed;
  } catch {
    // no settings yet
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, autoCompact: setting }, null, 2), { mode: FILE_MODE });
}
