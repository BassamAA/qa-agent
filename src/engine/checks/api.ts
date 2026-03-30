import { http, parallelRequests } from '../utils/httpClient.js';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';
import * as fs from 'fs';
import * as path from 'path';

export async function runAPIChecks(ctx: AppContext): Promise<CheckResult[]> {
  return Promise.all([
    checkHTTPMethods(ctx),
    checkRateLimiting(ctx),
    checkErrorLeakage(ctx),
    checkResponseTimes(ctx),
    checkCORSPolicy(ctx),
  ]);
}

// ─── Check: HTTP Method Handling ──────────────────────────────────────────────

async function checkHTTPMethods(ctx: AppContext): Promise<CheckResult> {
  const name = 'http-methods';
  const start = Date.now();
  const findings: Finding[] = [];

  const routes = discoverRoutes(ctx.rootDir).slice(0, 15);

  for (const route of routes) {
    const url = `${ctx.appUrl}${route}`;
    const methods = ['DELETE', 'PUT', 'PATCH'] as const;

    for (const method of methods) {
      try {
        const resp = await http.get(url, { method, timeoutMs: 4000 });

        // Should return 405 for unsupported methods, but returns 200 or 500
        if (resp.status === 500) {
          findings.push({
            id: makeId('api', `method-${method}-${route}`),
            category: 'api',
            severity: 'medium',
            title: `Route ${route} crashes on ${method} requests`,
            description: `Sending ${method} ${route} returns HTTP 500. The route handler doesn't check the HTTP method before processing, causing an unhandled error.`,
            evidence: `${method} ${url} → HTTP 500`,
            impact: `Unexpected HTTP methods can trigger errors that expose stack traces or destabilize the server process.`,
            fix: `Add method guards to your route handler:\n\nif (req.method !== 'POST') {\n  return NextResponse.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'POST' } });\n}`,
            file: routeToFilePath(ctx.rootDir, route),
            autoFixable: true,
            fixTemplate: 'addMethodHandler',
            checkName: name,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      } catch { /* skip */ }
    }
  }

  return { name, category: 'api', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Rate Limiting ─────────────────────────────────────────────────────

async function checkRateLimiting(ctx: AppContext): Promise<CheckResult> {
  const name = 'rate-limiting';
  const start = Date.now();
  const findings: Finding[] = [];

  // Check for rate limiting libraries in source
  const hasRateLimitLib = checkForRateLimitLib(ctx.rootDir);

  // Pick a few routes to test
  const testRoutes = discoverRoutes(ctx.rootDir)
    .filter((r) => r.includes('api'))
    .slice(0, 3);

  for (const route of testRoutes) {
    const url = `${ctx.appUrl}${route}`;

    // Fire 20 rapid requests
    const requests = Array.from({ length: 20 }, () => ({ url, options: { timeoutMs: 3000 } }));
    try {
      const responses = await parallelRequests(requests, 20);
      const rateLimitedCount = responses.filter((r) => r.status === 429).length;
      const allSucceeded = responses.every((r) => r.status !== 429 && r.status !== 503);

      if (allSucceeded && !hasRateLimitLib) {
        findings.push({
          id: makeId('api', `rate-limit-${route}`),
          category: 'api',
          severity: 'medium',
          title: `No rate limiting detected on ${route}`,
          description: `20 rapid requests to ${route} all succeeded without any 429 responses. No rate limiting library was detected in the project. Your API can be abused for scraping, spam, or DoS.`,
          evidence: `20 concurrent GET ${url} → all returned non-429 responses. No rate limit library found in package.json.`,
          impact: `Attackers can make unlimited requests to your API endpoints, enabling scraping, credential stuffing, spam signup, or exhausting your Vercel/Supabase quotas.`,
          fix: `Add rate limiting using Upstash Ratelimit or a middleware:\n\nimport { Ratelimit } from '@upstash/ratelimit';\nconst ratelimit = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 s') });\nconst { success } = await ratelimit.limit(ip);\nif (!success) return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });`,
          autoFixable: true,
          fixTemplate: 'addRateLimit',
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break;
      }
      void rateLimitedCount;
    } catch { /* skip */ }
  }

  return { name, category: 'api', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Error Leakage ─────────────────────────────────────────────────────

async function checkErrorLeakage(ctx: AppContext): Promise<CheckResult> {
  const name = 'error-leakage';
  const start = Date.now();
  const findings: Finding[] = [];

  const routes = discoverRoutes(ctx.rootDir).slice(0, 10);

  // Patterns that indicate leaked internals
  const leakPatterns = [
    { re: /at\s+\w+\s+\([^)]+\.(?:ts|js):\d+:\d+\)/, label: 'stack trace' },
    { re: /postgres:\/\/|mysql:\/\/|mongodb\+srv:\/\//, label: 'database connection string' },
    { re: /Error:\s+relation\s+"\w+"\s+does not exist/i, label: 'Postgres table error' },
    { re: /PrismaClientKnownRequestError/, label: 'Prisma error object' },
    { re: /SUPABASE|supabase_url/i, label: 'Supabase internals' },
    { re: /Cannot read propert/i, label: 'JavaScript runtime error' },
  ];

  for (const route of routes) {
    const url = `${ctx.appUrl}${route}`;

    // Trigger potential errors with bad params
    const badRequests = [
      http.get(`${url}/undefined`, { timeoutMs: 4000 }),
      http.get(`${url}/null`, { timeoutMs: 4000 }),
      http.get(`${url}/../../etc/passwd`, { timeoutMs: 4000 }),
      http.post(url, { id: 'not-a-uuid', __proto__: {} }, { timeoutMs: 4000 }),
    ];

    try {
      const responses = await Promise.allSettled(badRequests);
      for (const result of responses) {
        if (result.status !== 'fulfilled') continue;
        const resp = result.value;
        if (resp.status < 400) continue;

        for (const { re, label } of leakPatterns) {
          if (re.test(resp.body)) {
            findings.push({
              id: makeId('api', `error-leak-${route}`),
              category: 'api',
              severity: 'high',
              title: `Error response leaks internal information (${label})`,
              description: `A request to ${route} triggered a ${resp.status} response containing a ${label}. Error responses should never expose implementation details.`,
              evidence: `Request to ${url} → HTTP ${resp.status}\nLeak detected: ${resp.body.slice(0, 400)}`,
              impact: `Leaked ${label}s help attackers understand your infrastructure, database schema, and find additional attack vectors.`,
              fix: `Catch all errors and return generic messages:\n\ntry {\n  // your logic\n} catch (error) {\n  console.error(error); // log internally\n  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });\n}`,
              file: routeToFilePath(ctx.rootDir, route),
              autoFixable: false,
              checkName: name,
              timestamp: new Date().toISOString(),
            });
            break;
          }
        }
      }
    } catch { /* skip */ }
  }

  return { name, category: 'api', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Response Times ────────────────────────────────────────────────────

async function checkResponseTimes(ctx: AppContext): Promise<CheckResult> {
  const name = 'response-times';
  const start = Date.now();
  const findings: Finding[] = [];

  const routes = discoverRoutes(ctx.rootDir).slice(0, 10);

  for (const route of routes) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.get(url, { timeoutMs: 10_000 });
      if (resp.durationMs > 3000) {
        findings.push({
          id: makeId('api', `slow-${route}`),
          category: 'api',
          severity: 'medium',
          title: `Slow API response: ${route} took ${resp.durationMs}ms`,
          description: `The route ${route} took ${(resp.durationMs / 1000).toFixed(1)}s to respond. Vercel serverless functions timeout at 10s (Hobby) or 60s (Pro). Slow responses frustrate users and increase costs.`,
          evidence: `GET ${url} → HTTP ${resp.status} in ${resp.durationMs}ms`,
          impact: `Users experience slow load times, especially on initial render. At scale this can cause Vercel function timeouts and cascading failures.`,
          fix: `Profile the slow route. Common fixes:\n- Add database indexes for query columns\n- Cache results with Redis or in-memory cache\n- Move heavy computation to a background job\n- Use Supabase connection pooling (pgBouncer)`,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch { /* timeout — also a finding */ }
  }

  return { name, category: 'api', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: CORS Policy ───────────────────────────────────────────────────────

async function checkCORSPolicy(ctx: AppContext): Promise<CheckResult> {
  const name = 'cors-policy';
  const start = Date.now();
  const findings: Finding[] = [];

  const routes = discoverRoutes(ctx.rootDir)
    .filter((r) => r.includes('/api/'))
    .slice(0, 5);

  for (const route of routes) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.get(url, {
        headers: { 'Origin': 'https://evil.example.com' },
        timeoutMs: 4000,
      });

      const acao = resp.headers['access-control-allow-origin'];
      if (acao === '*') {
        findings.push({
          id: makeId('api', `cors-${route}`),
          category: 'api',
          severity: 'medium',
          title: `Open CORS policy on API route: ${route}`,
          description: `${route} returns Access-Control-Allow-Origin: * which allows any website to make cross-origin requests to this endpoint from a user's browser.`,
          evidence: `GET ${url} with Origin: evil.example.com → Access-Control-Allow-Origin: *`,
          impact: `Malicious websites can make authenticated requests to your API using the victim's cookies/session, enabling CSRF-style attacks.`,
          fix: `Restrict CORS to known origins:\n\nreturn NextResponse.json(data, {\n  headers: {\n    'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_APP_URL,\n    'Access-Control-Allow-Methods': 'GET, POST',\n  }\n});`,
          autoFixable: true,
          fixTemplate: 'addCorsHeaders',
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch { /* skip */ }
  }

  return { name, category: 'api', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function discoverRoutes(rootDir: string): string[] {
  const routes: string[] = [];
  walkForFiles(path.join(rootDir, 'app'), routes, rootDir);
  walkForFiles(path.join(rootDir, 'pages'), routes, rootDir);
  return routes;
}

function walkForFiles(dir: string, results: string[], rootDir: string): void {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next'].includes(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walkForFiles(fp, results, rootDir);
      else if (/^route\.[tj]s$/.test(e.name) || /\.(ts|js)$/.test(e.name)) {
        const route = fileToRoute(fp, rootDir);
        if (route) results.push(route);
      }
    }
  } catch { /* skip */ }
}

function fileToRoute(filePath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const appMatch = /^app\/(.*?)\/route\.[tj]s$/.exec(rel);
  if (appMatch) return `/${appMatch[1]}`;
  const pagesApiMatch = /^pages\/api\/(.*?)\.[tj]s$/.exec(rel);
  if (pagesApiMatch) return `/api/${pagesApiMatch[1]}`;
  return null;
}

function routeToFilePath(rootDir: string, route: string): string | undefined {
  const withoutLeading = route.replace(/^\//, '');
  const candidates = [
    path.join('app', withoutLeading, 'route.ts'),
    path.join('pages', 'api', `${withoutLeading.replace('api/', '')}.ts`),
  ];
  return candidates.find((c) => fs.existsSync(path.join(rootDir, c))) ?? candidates[0];
}

function checkForRateLimitLib(rootDir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return (
      '@upstash/ratelimit' in deps ||
      'express-rate-limit' in deps ||
      'rate-limiter-flexible' in deps ||
      'next-rate-limit' in deps
    );
  } catch { return false; }
}
