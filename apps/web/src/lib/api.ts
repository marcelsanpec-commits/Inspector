const BASE = (import.meta.env.VITE_API_URL as string) || 'http://localhost:3000';

const TOKEN_KEY = 'inspectorone.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The session token lives in localStorage rather than a cookie because the API
 * and the app are on different origins, and cross-site cookies are fragile and
 * increasingly blocked. The trade-off is that XSS can read it - which is why
 * nothing in this app ever injects untrusted HTML.
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing - the session simply won't survive a reload */
  }
}

export async function api<T = unknown>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const token = getToken();

  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;

    // An expired or revoked session should drop us back to the login screen
    // rather than leaving the UI in a half-broken state.
    if (res.status === 401) setToken(null);

    throw new ApiError(
      res.status,
      err?.code ?? 'request_failed',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }

  return data as T;
}

export const API_BASE = BASE;
