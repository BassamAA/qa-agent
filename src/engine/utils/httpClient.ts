// ─── HTTP Client ──────────────────────────────────────────────────────────────
// Thin wrapper around fetch with timing, cookie support, and easy auth helpers

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: <T>() => T | null;
  durationMs: number;
  ok: boolean;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  token?: string;
  timeoutMs?: number;
  followRedirects?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function httpRequest(
  url: string,
  options: RequestOptions = {}
): Promise<HttpResponse> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'qa-agent/1.0',
    ...options.headers,
  };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  let body: string | undefined;
  if (options.body) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
    });
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - start;
  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
    json: <T>() => {
      try {
        return JSON.parse(responseBody) as T;
      } catch {
        return null;
      }
    },
    durationMs,
    ok: response.ok,
  };
}

// ─── Convenience wrappers ──────────────────────────────────────────────────────

export const http = {
  get: (url: string, opts?: RequestOptions) =>
    httpRequest(url, { ...opts, method: 'GET' }),

  post: (url: string, body: Record<string, unknown>, opts?: RequestOptions) =>
    httpRequest(url, { ...opts, method: 'POST', body }),

  put: (url: string, body: Record<string, unknown>, opts?: RequestOptions) =>
    httpRequest(url, { ...opts, method: 'PUT', body }),

  delete: (url: string, opts?: RequestOptions) =>
    httpRequest(url, { ...opts, method: 'DELETE' }),

  patch: (url: string, body: Record<string, unknown>, opts?: RequestOptions) =>
    httpRequest(url, { ...opts, method: 'PATCH', body }),
};

// ─── Parallel request helper ──────────────────────────────────────────────────

export async function parallelRequests(
  requests: Array<{ url: string; options?: RequestOptions }>,
  concurrency = 5
): Promise<HttpResponse[]> {
  const results: HttpResponse[] = [];

  for (let i = 0; i < requests.length; i += concurrency) {
    const batch = requests.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ url, options }) => httpRequest(url, options))
    );
    results.push(...batchResults);
  }

  return results;
}
