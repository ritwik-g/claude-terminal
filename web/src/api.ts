import type { Artifact, CompletionEvent, RestoreCandidate, Session, UserState } from '../../server/types';
import type { UsageSnapshot } from '../../server/usage';
import { authHeaders } from './token';

export interface UsagePayload {
  usage: UsageSnapshot | null;
  refreshing: boolean;
  refreshable?: boolean;
}

export interface SessionsPayload {
  sessions: Session[];
  tags: string[];
  counts: Record<string, number>;
  scannedAt: number;
  scanMs: number;
  storeReadOnly: boolean;
  restore: RestoreCandidate[];
  completions: CompletionEvent[];
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  sessions: (force = false) => json<SessionsPayload>(`/api/sessions${force ? '?force=1' : ''}`),

  patchState: (id: string, patch: Partial<UserState>) =>
    json<{ id: string; user: UserState }>(`/api/sessions/${encodeURIComponent(id)}/state`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  startTerm: (body: { id: string; sessionId: string | null; cwd: string; cols: number; rows: number }) =>
    json<{ term: unknown }>('/api/terms', { method: 'POST', body: JSON.stringify(body) }),

  artifacts: (id: string) =>
    json<{ artifacts: Artifact[] }>(`/api/sessions/${encodeURIComponent(id)}/artifacts`),

  /** Run one of Claude Code's own slash commands inside a terminal we own. */
  termCommand: (id: string, command: 'branch' | 'rename', arg?: string) =>
    json<{ ok: boolean; sent: string }>(`/api/terms/${encodeURIComponent(id)}/command`, {
      method: 'POST',
      body: JSON.stringify(arg === undefined ? { command } : { command, arg }),
    }),

  /** Sessions whose MESSAGE TEXT matches — the part the payload does not carry. */
  search: (q: string) =>
    json<{ ids: string[]; q: string }>(`/api/search?q=${encodeURIComponent(q)}`),

  clearRestore: () => json<{ ok: boolean }>('/api/restore', { method: 'DELETE' }),

  /** Cached usage windows. Cheap — reads a file, starts nothing. */
  usage: () => json<UsagePayload>('/api/usage'),

  /** Starts a throwaway Claude Code session to bring the numbers up to date. */
  refreshUsage: () => json<UsagePayload>('/api/usage/refresh', { method: 'POST' }),

  killTerm: (id: string, hard = false) =>
    json<{ ok: boolean }>(`/api/terms/${encodeURIComponent(id)}${hard ? '?hard=1' : ''}`, {
      method: 'DELETE',
    }),
};
