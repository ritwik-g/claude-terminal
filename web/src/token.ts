/**
 * The per-run API token.
 *
 * It arrives in the URL the launcher opened. It is deliberately not embedded in
 * the served HTML: the page is fetchable without a token — that is how the
 * renderer bootstraps — so anything baked into it would be readable by exactly
 * the local processes the token exists to keep out.
 *
 * Reloading (⌘R) re-requests a URL we have already stripped, so the token has
 * to outlive the address bar. sessionStorage is the right scope: it survives a
 * reload, dies with the tab, and never reaches another origin. It can throw
 * outright when site data is blocked, so every access is guarded.
 *
 * In dev there is no token here and none is needed — Vite serves the page and
 * proxies the API, attaching the header itself on the way through.
 */
const KEY = 'ct-token';

function stored(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

let token = stored();

const url = new URL(window.location.href);
const fromUrl = url.searchParams.get('t');
if (fromUrl) {
  token = fromUrl;
  try {
    sessionStorage.setItem(KEY, fromUrl);
  } catch {
    /* private window or blocked storage — the in-memory copy still serves this page */
  }
  // Keep it out of the address bar, history, and anything the user might copy.
  url.searchParams.delete('t');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Headers for a fetch to /api. Empty in dev, where the proxy supplies it. */
export function authHeaders(): Record<string, string> {
  return token ? { 'x-ct-token': token } : {};
}

/** Query fragment for the WebSocket, which cannot carry headers from a browser. */
export function wsTokenParam(): string {
  return token ? `&token=${encodeURIComponent(token)}` : '';
}
