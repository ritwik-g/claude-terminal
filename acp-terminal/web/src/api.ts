import type { AcpSession, AgentDescriptor, FileAttachment, SessionSummary, UserAnnotations } from './types';

function getToken(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const t = urlParams.get('token');
  if (t) {
    sessionStorage.setItem('acp_token', t);
    return t;
  }
  return sessionStorage.getItem('acp_token') || '';
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('x-acp-token', token);
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

export const api = {
  getAgents: () => request<{ agents: AgentDescriptor[] }>('/api/agents'),
  getSessions: () => request<{ sessions: SessionSummary[] }>('/api/sessions'),
  getSession: (id: string) => request<{ session: AcpSession }>(`/api/sessions/${id}`),
  createSession: (data: { agentId: string; cwd: string; title?: string; initialPrompt?: string; model?: string }) =>
    request<{ session: AcpSession }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendPrompt: (id: string, prompt: string, attachments?: FileAttachment[]) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt, attachments }),
    }),
  cancelPrompt: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/cancel`, {
      method: 'POST',
    }),
  stopSessionAgent: (id: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/stop`, {
      method: 'POST',
    }),
  startSessionAgent: (id: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/start`, {
      method: 'POST',
    }),
  resolvePermission: (id: string, optionId: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/permission`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    }),
  switchAgent: (
    id: string,
    targetAgentId: string,
    opts?: {
      model?: string;
      archivePrevious?: boolean;
      inPlace?: boolean;
      customPrompt?: string;
      skipInitialPrompt?: boolean;
      contextMode?: 'compact' | 'full' | 'none';
    }
  ) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/switch`, {
      method: 'POST',
      body: JSON.stringify({ targetAgentId, ...opts }),
    }),
  rollbackSession: (
    id: string,
    opts: {
      turnId?: string;
      action: 'revert_to_this' | 'revert_before_this' | 'undo_last';
    }
  ) =>
    request<{ session: AcpSession; restoredPrompt?: string }>(`/api/sessions/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  compactSession: (id: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/compact`, {
      method: 'POST',
    }),
  setSessionAgent: (
    id: string,
    agentId: string,
    model?: string,
    effort?: string,
    contextMode?: 'compact' | 'full' | 'none'
  ) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/agent`, {
      method: 'PATCH',
      body: JSON.stringify({ agentId, model, effort, contextMode }),
    }),
  setSessionEffort: (id: string, effort: 'off' | 'low' | 'medium' | 'high') =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/effort`, {
      method: 'PATCH',
      body: JSON.stringify({ effort }),
    }),
  updateAnnotations: (id: string, updates: Partial<UserAnnotations>) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/annotations`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
  renameSession: (id: string, title: string) =>
    request<{ session: AcpSession }>(`/api/sessions/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, {
      method: 'DELETE',
    }),
  search: (query: string) =>
    request<{ sessions: AcpSession[] }>(`/api/search?q=${encodeURIComponent(query)}`),
  getFolders: (basePath?: string) =>
    request<{
      current: string;
      parent: string | null;
      isGit: boolean;
      recent: string[];
      entries: { name: string; path: string; isGit: boolean }[];
    }>(`/api/folders?path=${encodeURIComponent(basePath || '')}`),
  browseNativeFolder: () =>
    request<{ supported: boolean; selected?: string; canceled?: boolean; error?: string }>(
      '/api/browse-native-folder',
      { method: 'POST' }
    ),
  getSubscriptions: () =>
    request<{ subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions'
    ),
  saveSubscriptionsConfig: (creds: Partial<StoredCredentials>) =>
    request<{ success: boolean; credentials: StoredCredentials; subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions/config',
      {
        method: 'POST',
        body: JSON.stringify(creds),
      }
    ),
  refreshRateLimits: () =>
    request<{ success: boolean; subscriptions: Record<'anthropic' | 'openai' | 'google', VendorSubscriptionInfo> }>(
      '/api/subscriptions/refresh-limits',
      {
        method: 'POST',
      }
    ),
  getUsageSummary: () =>
    request<{ usage: UsageReport }>('/api/usage/summary'),
  getSessionUsage: (id: string) =>
    request<{ sessionCost: SessionCostDetail; usage: any; model?: string }>(`/api/sessions/${id}/usage`),
  getNetworkInfo: () =>
    request<{
      port: number;
      token: string;
      ips: string[];
      localUrl: string;
      networkUrls: string[];
    }>('/api/network'),
};

export function connectWebSocket(
  onMessage: (msg: any) => void,
  onOpen?: () => void,
  onClose?: () => void
): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws${tokenQuery}`);

  ws.onopen = () => onOpen?.();
  ws.onclose = () => onClose?.();
  ws.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      onMessage(parsed);
    } catch {
      // ignore
    }
  };

  return ws;
}
