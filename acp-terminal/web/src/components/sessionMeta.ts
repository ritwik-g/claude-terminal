import type { AcpSession } from '../types';
import type { Tone } from '../ui';

// Shared labels and formatters for the session workspace. SessionDetail
// re-exports the public ones (STATE_LABEL, formatTime, nextPriority) because
// other areas import them from there.

export const STATE_LABEL: Record<string, string> = {
  blocked: 'Needs approval',
  needs_you: 'Your turn',
  working: 'Working',
  parked: 'Parked',
  quiet: 'Idle',
  snoozed: 'Snoozed',
  crashed: 'Crashed',
};

const STATE_TONE: Record<string, Tone> = {
  blocked: 'danger',
  needs_you: 'warn',
  working: 'accent',
  parked: 'neutral',
  quiet: 'neutral',
  snoozed: 'info',
  crashed: 'danger',
};

/** The label, tone and pulse for a session's state dot. */
export function sessionStateView(session: AcpSession): { label: string; tone: Tone; pulse: boolean } {
  if (session.isAgentRunning === false) return { label: 'Agent stopped', tone: 'neutral', pulse: false };
  return {
    label: STATE_LABEL[session.state] || session.state,
    tone: STATE_TONE[session.state] || 'neutral',
    pulse: session.state === 'working',
  };
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function nextPriority(current: 'p0' | 'p1' | 'p2' | null | undefined): 'p0' | 'p1' | 'p2' | null {
  const cycle: Record<string, 'p0' | 'p1' | 'p2' | null> = { null: 'p0', p0: 'p1', p1: 'p2', p2: null };
  return cycle[String(current ?? null)];
}

/** 33k, 1.2M: compact token counts for meters. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
