import * as fs from 'fs';
import * as path from 'path';
import { http } from '../utils/httpClient.js';
import { createTestUser, deleteTestUser, createAnonClient } from '../utils/supabaseClient.js';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';

// ─── Auth Checks ──────────────────────────────────────────────────────────────

export async function runAuthChecks(ctx: AppContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await checkUnauthenticatedAPIAccess(ctx));
  results.push(await checkProtectedPageRendering(ctx));
  results.push(await checkTokenStorage(ctx));
  results.push(await checkSupabaseRLSPresence(ctx));
  results.push(await checkServiceRoleKeyExposure(ctx));
  results.push(await checkIDORVulnerability(ctx));

  return results;
}

// ─── Check: Unauthenticated API Access ────────────────────────────────────────

async function checkUnauthenticatedAPIAccess(ctx: AppContext): Promise<CheckResult> {
  const name = 'unauthenticated-api-access';
  const start = Date.now();
  const findings: Finding[] = [];

  // Discover API routes
  const apiRoutes = discoverAPIRoutes(ctx.rootDir);
  const sensitiveRoutes = apiRoutes.filter(isSensitiveRoute);

  for (const route of sensitiveRoutes.slice(0, 20)) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.get(url, { timeoutMs: 5000 });

      // A 200 on a sensitive route with no auth is a finding
      if (resp.ok && isDataResponse(resp.body)) {
        findings.push({
          id: makeId('auth', 'unauth-api'),
          category: 'auth',
          severity: 'critical',
          title: `Unprotected API route returns data without authentication`,
          description: `The route ${route} returned HTTP ${resp.status} with data payload when called with no authentication token. Any visitor can access this endpoint.`,
          evidence: `GET ${url} → HTTP ${resp.status}\nResponse (first 300 chars): ${resp.body.slice(0, 300)}`,
          impact: `Any unauthenticated user can retrieve data from ${route}. Depending on what data is returned, this could expose user records, PII, or business data.`,
          fix: `Add authentication middleware to ${route}. In Next.js App Router, check for a session at the top of your route handler:\n\nconst session = await getServerSession(authOptions);\nif (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });`,
          file: routeToFilePath(ctx.rootDir, route),
          autoFixable: true,
          fixTemplate: 'addAuthCheck',
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Timeout or connection error — app not responding, skip
    }
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Check: Protected Page Renders Before Redirect ────────────────────────────

async function checkProtectedPageRendering(ctx: AppContext): Promise<CheckResult> {
  const name = 'protected-page-rendering';
  const start = Date.now();
  const findings: Finding[] = [];

  const protectedPaths = discoverProtectedPages(ctx.rootDir);

  for (const pagePath of protectedPaths.slice(0, 10)) {
    const url = `${ctx.appUrl}${pagePath}`;
    try {
      // Disable redirect following to see the raw response
      const resp = await http.get(url, { followRedirects: false, timeoutMs: 5000 });

      // If we get a 200 with HTML content on a protected page, it's a finding
      if (resp.status === 200 && resp.body.length > 1000 && !isLoginPage(resp.body)) {
        findings.push({
          id: makeId('auth', 'page-render'),
          category: 'auth',
          severity: 'high',
          title: `Protected page renders content before auth check`,
          description: `The page ${pagePath} returns HTTP 200 with content when accessed without authentication. This may indicate the auth check is client-side only.`,
          evidence: `GET ${url} → HTTP ${resp.status} (${resp.body.length} bytes)\nPage content rendered without auth token.`,
          impact: `Users can see page structure and potentially content fragments before the client-side redirect kicks in. SEO crawlers may also index protected content.`,
          fix: `Move auth check to the server. In Next.js App Router, redirect in the page component or layout:\n\nconst session = await getServerSession();\nif (!session) redirect('/login');`,
          file: pagePathToFilePath(ctx.rootDir, pagePath),
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // skip
    }
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Check: Token Storage (httpOnly vs localStorage) ─────────────────────────

async function checkTokenStorage(ctx: AppContext): Promise<CheckResult> {
  const name = 'token-storage';
  const start = Date.now();
  const findings: Finding[] = [];

  // Look for localStorage token storage patterns in source files
  const jsFiles = findSourceFiles(ctx.rootDir, ['.ts', '.tsx', '.js', '.jsx']);
  const dangerousPatterns = [
    { re: /localStorage\.setItem\s*\(\s*['"][^'"]*token[^'"]*['"]/i, label: 'token in localStorage' },
    { re: /localStorage\.setItem\s*\(\s*['"][^'"]*jwt[^'"]*['"]/i, label: 'JWT in localStorage' },
    { re: /localStorage\.setItem\s*\(\s*['"][^'"]*session[^'"]*['"]/i, label: 'session in localStorage' },
    { re: /localStorage\.setItem\s*\(\s*['"][^'"]*auth[^'"]*['"]/i, label: 'auth data in localStorage' },
  ];

  for (const file of jsFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const relativePath = path.relative(ctx.rootDir, file);

    for (const { re, label } of dangerousPatterns) {
      const match = re.exec(content);
      if (match) {
        const line = getLineNumber(content, match.index);
        findings.push({
          id: makeId('auth', 'token-storage'),
          category: 'auth',
          severity: 'high',
          title: `Auth token stored in localStorage (XSS vulnerable)`,
          description: `${label} found in ${relativePath}. localStorage is accessible to any JavaScript on the page — a successful XSS attack can steal all tokens.`,
          evidence: `${relativePath}:${line}\n${match[0].trim()}`,
          impact: `If an attacker injects JavaScript (via XSS), they can read localStorage and steal the authentication token, fully impersonating the user.`,
          fix: `Use httpOnly cookies for token storage instead. With Next.js + Supabase: configure Supabase Auth to use cookies (the @supabase/ssr package handles this automatically).`,
          file: relativePath,
          line,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break; // one finding per file
      }
    }
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Check: Supabase RLS Presence ────────────────────────────────────────────

async function checkSupabaseRLSPresence(ctx: AppContext): Promise<CheckResult> {
  const name = 'supabase-rls';
  const start = Date.now();
  const findings: Finding[] = [];

  if (!ctx.hasSupabase) {
    return { name, category: 'auth', status: 'skipped', findings, duration: Date.now() - start };
  }

  const anonClient = createAnonClient(ctx);
  if (!anonClient) {
    return { name, category: 'auth', status: 'skipped', findings, duration: Date.now() - start };
  }

  // Try to query common sensitive tables as anon
  const sensitiveTables = ['users', 'profiles', 'accounts', 'orders', 'payments', 'subscriptions'];

  for (const table of sensitiveTables) {
    try {
      const { data, error } = await anonClient.from(table).select('*').limit(5);

      if (!error && data && data.length > 0) {
        findings.push({
          id: makeId('auth', `rls-${table}`),
          category: 'auth',
          severity: 'critical',
          title: `Supabase table "${table}" readable without authentication (RLS missing)`,
          description: `The "${table}" table returned ${data.length} row(s) when queried with the anon key and no user session. Row Level Security (RLS) is likely not enabled or policies are too permissive.`,
          evidence: `Queried "public.${table}" as anonymous user → returned ${data.length} row(s)\nFirst row keys: ${Object.keys(data[0] as object).join(', ')}`,
          impact: `Any anonymous visitor can read all ${table} records from your database. This is a critical data exposure vulnerability.`,
          fix: `Enable RLS on the ${table} table and add a restrictive policy:\n\nALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;\nCREATE POLICY "Users can only see their own data" ON ${table}\n  FOR SELECT USING (auth.uid() = user_id);`,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Table doesn't exist or other error — skip
    }
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Check: Service Role Key Exposure ─────────────────────────────────────────

async function checkServiceRoleKeyExposure(ctx: AppContext): Promise<CheckResult> {
  const name = 'service-role-exposure';
  const start = Date.now();
  const findings: Finding[] = [];

  const clientFiles = findSourceFiles(ctx.rootDir, ['.ts', '.tsx', '.js', '.jsx'])
    .filter((f) => {
      const rel = path.relative(ctx.rootDir, f);
      // Client-side files: app/**/page.tsx, components/**, hooks/**
      return (
        rel.includes('components') ||
        rel.includes('hooks') ||
        (rel.startsWith('app') && (rel.endsWith('page.tsx') || rel.endsWith('page.jsx'))) ||
        rel.startsWith('pages') && !rel.includes('api')
      );
    });

  const serviceRoleKey = ctx.supabaseServiceRoleKey;
  if (!serviceRoleKey) {
    return { name, category: 'auth', status: 'skipped', findings, duration: Date.now() - start };
  }

  for (const file of clientFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    if (
      content.includes('SERVICE_ROLE') ||
      content.includes('service_role') ||
      (serviceRoleKey.length > 10 && content.includes(serviceRoleKey.slice(0, 20)))
    ) {
      const relativePath = path.relative(ctx.rootDir, file);
      findings.push({
        id: makeId('auth', 'service-role-exposed'),
        category: 'auth',
        severity: 'critical',
        title: `Supabase service_role key used in client-side code`,
        description: `${relativePath} appears to reference the Supabase service_role key. The service_role key bypasses ALL Row Level Security policies — it must never be used in client-side code.`,
        evidence: `Pattern found in client-side file: ${relativePath}`,
        impact: `Anyone who opens DevTools can read the service_role key and bypass all RLS policies, reading or writing any data in your database.`,
        fix: `Remove SUPABASE_SERVICE_ROLE_KEY from all client-side code. Only use it in server-side code (API routes, server actions, middleware). Use NEXT_PUBLIC_SUPABASE_ANON_KEY on the client.`,
        file: relativePath,
        autoFixable: true,
        fixTemplate: 'fixEnvExposure',
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Check: IDOR (Insecure Direct Object Reference) ──────────────────────────

async function checkIDORVulnerability(ctx: AppContext): Promise<CheckResult> {
  const name = 'idor-vulnerability';
  const start = Date.now();
  const findings: Finding[] = [];

  // Create two test users, test if user A can access user B's data
  if (!ctx.hasSupabase) {
    return { name, category: 'auth', status: 'skipped', findings, duration: Date.now() - start };
  }

  const userA = await createTestUser(ctx);
  const userB = await createTestUser(ctx);

  if (!userA || !userB) {
    return { name, category: 'auth', status: 'skipped', findings, duration: Date.now() - start };
  }

  try {
    const userAPaths = [`/api/users/${userB.id}`, `/api/profile/${userB.id}`, `/api/account/${userB.id}`];

    for (const apiPath of userAPaths) {
      const url = `${ctx.appUrl}${apiPath}`;
      try {
        const resp = await http.get(url, { token: userA.accessToken, timeoutMs: 5000 });

        if (resp.ok && isDataResponse(resp.body)) {
          findings.push({
            id: makeId('auth', 'idor'),
            category: 'auth',
            severity: 'critical',
            title: `IDOR: User A can access User B's data`,
            description: `Authenticated as User A (${userA.email}), calling ${apiPath} with User B's ID (${userB.id}) returned a 200 response with data. The API is not verifying that the requesting user owns the requested resource.`,
            evidence: `GET ${url} with User A token → HTTP ${resp.status}\nResponse: ${resp.body.slice(0, 300)}`,
            impact: `Any authenticated user can read any other user's data by guessing or brute-forcing user IDs. This exposes all user data to horizontal privilege escalation.`,
            fix: `Compare the requested resource's owner_id against the authenticated user's session ID:\n\nconst session = await getServerSession();\nif (resource.userId !== session.user.id) {\n  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });\n}`,
            file: routeToFilePath(ctx.rootDir, apiPath),
            autoFixable: false,
            checkName: name,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      } catch { /* skip */ }
    }
  } finally {
    await Promise.all([
      deleteTestUser(ctx, userA.id),
      deleteTestUser(ctx, userB.id),
    ]);
  }

  return {
    name,
    category: 'auth',
    status: findings.length > 0 ? 'failed' : 'passed',
    findings,
    duration: Date.now() - start,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function discoverAPIRoutes(rootDir: string): string[] {
  const routes: string[] = [];
  const appDir = path.join(rootDir, 'app');
  const pagesDir = path.join(rootDir, 'pages', 'api');

  // Next.js App Router
  walkForRouteFiles(appDir, rootDir, routes, (f) => f === 'route.ts' || f === 'route.js');
  // Next.js Pages Router
  walkForRouteFiles(pagesDir, rootDir, routes, (f) => f.endsWith('.ts') || f.endsWith('.js'));

  return routes.map(filePathToRoute).filter(Boolean) as string[];
}

function walkForRouteFiles(
  dir: string,
  rootDir: string,
  results: string[],
  matcher: (name: string) => boolean
): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkForRouteFiles(fullPath, rootDir, results, matcher);
      } else if (entry.isFile() && matcher(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch { /* dir doesn't exist */ }
}

function filePathToRoute(filePath: string): string | null {
  // Convert Next.js file path to URL path
  const normalized = filePath.replace(/\\/g, '/');
  const appMatch = /\/app\/(.*?)\/route\.[tj]s$/.exec(normalized);
  if (appMatch) return `/api/${appMatch[1]}`.replace(/\/api\/api\//, '/api/');

  const pagesMatch = /\/pages\/api\/(.*?)\.[tj]s$/.exec(normalized);
  if (pagesMatch) return `/api/${pagesMatch[1]}`;

  return null;
}

function routeToFilePath(rootDir: string, route: string): string | undefined {
  const withoutApi = route.replace(/^\/api\//, '');
  const candidates = [
    path.join('app', 'api', withoutApi, 'route.ts'),
    path.join('app', 'api', withoutApi, 'route.js'),
    path.join('pages', 'api', `${withoutApi}.ts`),
    path.join('pages', 'api', `${withoutApi}.js`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(rootDir, c))) return c;
  }
  return candidates[0];
}

function discoverProtectedPages(rootDir: string): string[] {
  const pages: string[] = [];
  const protectedDirs = ['dashboard', 'settings', 'account', 'profile', 'admin'];
  const appDir = path.join(rootDir, 'app');

  for (const dir of protectedDirs) {
    const fullDir = path.join(appDir, dir);
    if (fs.existsSync(fullDir)) {
      pages.push(`/${dir}`);
    }
  }
  return pages;
}

function pagePathToFilePath(rootDir: string, pagePath: string): string | undefined {
  const candidates = [
    path.join('app', pagePath, 'page.tsx'),
    path.join('app', pagePath, 'page.jsx'),
    path.join('pages', `${pagePath}.tsx`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(rootDir, c))) return c;
  }
  return undefined;
}

function isSensitiveRoute(route: string): boolean {
  const lower = route.toLowerCase();
  return /user|account|profile|order|payment|invoice|subscription|admin|billing/.test(lower);
}

function isDataResponse(body: string): boolean {
  if (body.length < 5) return false;
  try { JSON.parse(body); return true; } catch { return false; }
}

function isLoginPage(html: string): boolean {
  return /login|sign.?in|password/i.test(html.slice(0, 2000));
}

function findSourceFiles(rootDir: string, extensions: string[]): string[] {
  const results: string[] = [];
  const extSet = new Set(extensions);

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extSet.has(path.extname(entry.name))) {
          results.push(fullPath);
        }
      }
    } catch { /* skip */ }
  }

  walk(rootDir);
  return results;
}

function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}
