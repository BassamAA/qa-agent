import * as fs from 'fs';
import * as path from 'path';
import { http } from '../utils/httpClient.js';
import { getTableSchema } from '../utils/supabaseClient.js';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';

export async function runDataChecks(ctx: AppContext): Promise<CheckResult[]> {
  return Promise.all([
    checkInputValidation(ctx),
    checkDatabaseConstraints(ctx),
    checkRaceConditions(ctx),
    checkUnboundedQueries(ctx),
  ]);
}

// ─── Check: Input Validation ──────────────────────────────────────────────────

async function checkInputValidation(ctx: AppContext): Promise<CheckResult> {
  const name = 'input-validation';
  const start = Date.now();
  const findings: Finding[] = [];

  const apiRoutes = discoverMutationRoutes(ctx.rootDir);

  const maliciousPayloads = [
    { label: 'empty body',       body: {} },
    { label: 'SQL injection',    body: { email: "' OR 1=1 --", name: "'; DROP TABLE users; --" } },
    { label: 'oversized string', body: { email: 'a'.repeat(10_000), name: 'b'.repeat(10_000) } },
    { label: 'type confusion',   body: { email: 12345, name: null, age: 'not-a-number' } },
    { label: 'XSS attempt',      body: { name: '<script>alert(1)</script>', bio: '"><img src=x onerror=alert(1)>' } },
  ];

  for (const route of apiRoutes.slice(0, 10)) {
    const url = `${ctx.appUrl}${route}`;

    for (const { label, body } of maliciousPayloads) {
      try {
        const resp = await http.post(url, body, { timeoutMs: 5000 });
        // A 500 means the invalid input reached the server and caused an unhandled error
        if (resp.status === 500) {
          findings.push({
            id: makeId('data', `validation-${route}`),
            category: 'data',
            severity: 'high',
            title: `API route crashes on invalid input (${label})`,
            description: `POST ${route} returned HTTP 500 when sent ${label}. The server is not validating input before processing, causing unhandled exceptions that can reveal stack traces and destabilize the app.`,
            evidence: `POST ${url} with ${label} → HTTP 500\nResponse: ${resp.body.slice(0, 300)}`,
            impact: `Malformed requests can crash your API, expose internal error details, and in some cases be exploited for DoS attacks.`,
            fix: `Add input validation using Zod at the start of your route handler:\n\nconst schema = z.object({ email: z.string().email(), name: z.string().min(1).max(255) });\nconst result = schema.safeParse(await req.json());\nif (!result.success) return NextResponse.json({ error: result.error }, { status: 400 });`,
            file: routeToFilePath(ctx.rootDir, route),
            autoFixable: true,
            fixTemplate: 'addValidation',
            checkName: name,
            timestamp: new Date().toISOString(),
          });
          break; // one finding per route
        }
        // A 200 on SQL injection or XSS input is concerning too
        if (resp.ok && (label === 'SQL injection' || label === 'XSS attempt')) {
          findings.push({
            id: makeId('data', `injection-${route}`),
            category: 'data',
            severity: 'high',
            title: `API route accepts potentially dangerous input without validation`,
            description: `POST ${route} returned HTTP 200 for a ${label} payload without validation rejection.`,
            evidence: `POST ${url} with ${label} → HTTP ${resp.status}`,
            impact: `Dangerous input is reaching your business logic. If not sanitized at the DB layer, this could enable SQL injection or stored XSS.`,
            fix: `Validate and sanitize all user input before processing. Use parameterized queries and avoid constructing SQL with string concatenation.`,
            file: routeToFilePath(ctx.rootDir, route),
            autoFixable: false,
            checkName: name,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      } catch { /* skip */ }
    }
  }

  return { name, category: 'data', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Database Constraints ──────────────────────────────────────────────

async function checkDatabaseConstraints(ctx: AppContext): Promise<CheckResult> {
  const name = 'db-constraints';
  const start = Date.now();
  const findings: Finding[] = [];

  if (!ctx.hasSupabase) {
    return { name, category: 'data', status: 'skipped', findings, duration: Date.now() - start };
  }

  const sensitiveTables = ['users', 'profiles', 'accounts', 'orders'];

  for (const table of sensitiveTables) {
    const schema = await getTableSchema(ctx, table);
    if (schema.length === 0) continue;

    const criticalColumns = schema.filter((col) =>
      /email|user_id|owner_id|amount|price/.test(col.column) && col.nullable
    );

    for (const col of criticalColumns) {
      findings.push({
        id: makeId('data', `constraint-${table}-${col.column}`),
        category: 'data',
        severity: 'medium',
        title: `Column "${table}.${col.column}" allows NULL values`,
        description: `The column "${col.column}" in table "${table}" has no NOT NULL constraint. Critical business columns should be required at the database level, not just validated by the app.`,
        evidence: `Schema: ${table}.${col.column} → type: ${col.type}, nullable: true`,
        impact: `If app-level validation fails or is bypassed, NULL values can be inserted, causing null pointer errors, broken email sends, and corrupted business data.`,
        fix: `Add a NOT NULL constraint:\n\nALTER TABLE ${table} ALTER COLUMN ${col.column} SET NOT NULL;\n\nAlso ensure existing rows are cleaned up first if any have null values.`,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { name, category: 'data', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Race Conditions ───────────────────────────────────────────────────

async function checkRaceConditions(ctx: AppContext): Promise<CheckResult> {
  const name = 'race-conditions';
  const start = Date.now();
  const findings: Finding[] = [];

  // Look for non-idempotent endpoints that could be hit in parallel
  const mutationRoutes = discoverMutationRoutes(ctx.rootDir);
  const idempotencyRoutes = mutationRoutes.filter((r) =>
    /subscribe|enroll|purchase|register|signup|create/.test(r)
  );

  for (const route of idempotencyRoutes.slice(0, 3)) {
    const url = `${ctx.appUrl}${route}`;
    const testPayload = { email: `race-test-${Date.now()}@example.com`, test: true };

    try {
      // Fire 5 simultaneous identical requests
      const requests = Array.from({ length: 5 }, () =>
        http.post(url, testPayload, { timeoutMs: 5000 })
      );
      const responses = await Promise.all(requests);
      const successCount = responses.filter((r) => r.status === 200 || r.status === 201).length;

      if (successCount > 1) {
        findings.push({
          id: makeId('data', `race-${route}`),
          category: 'data',
          severity: 'high',
          title: `Possible race condition: multiple simultaneous requests to ${route} all succeed`,
          description: `${successCount} out of 5 simultaneous identical requests to ${route} returned success. Without database-level uniqueness constraints or idempotency keys, this can cause duplicate records.`,
          evidence: `5 concurrent POST ${url} → ${successCount} returned 2xx`,
          impact: `Users could be double-charged, double-enrolled, or have duplicate accounts created if they click a button quickly or their network retries the request.`,
          fix: `Add a UNIQUE constraint at the database level for the relevant column, or use an idempotency key pattern:\n\n// Add to your handler\nconst idempotencyKey = req.headers.get('Idempotency-Key');\nif (idempotencyKey) {\n  const existing = await checkIdempotency(idempotencyKey);\n  if (existing) return NextResponse.json(existing);\n}`,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch { /* skip */ }
  }

  // Static analysis: look for non-transactional multi-step mutations
  const sourceFiles = findSourceFiles(ctx.rootDir);
  for (const file of sourceFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Look for multiple await db calls without transaction
    const awaitDbCalls = (content.match(/await\s+(?:prisma|db|supabase)\.\w+\./g) ?? []).length;
    const hasTransaction = /\$transaction|BEGIN|COMMIT|transaction\(/.test(content);

    if (awaitDbCalls >= 3 && !hasTransaction && /api|route|action/.test(rel)) {
      findings.push({
        id: makeId('data', `transaction-${rel}`),
        category: 'data',
        severity: 'medium',
        title: `Multiple database operations without a transaction`,
        description: `${rel} performs ${awaitDbCalls} database operations sequentially without wrapping them in a transaction. If one operation fails mid-way, the database is left in a partial state.`,
        evidence: `${awaitDbCalls} await db/prisma/supabase calls found without $transaction or BEGIN/COMMIT`,
        impact: `Partial writes can corrupt your data. For example, creating a user and then their profile separately — if the profile creation fails, you have a user with no profile.`,
        fix: `Wrap related operations in a transaction:\n\nawait prisma.$transaction(async (tx) => {\n  const user = await tx.user.create(...);\n  await tx.profile.create({ data: { userId: user.id, ... } });\n});`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { name, category: 'data', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Unbounded Queries ─────────────────────────────────────────────────

async function checkUnboundedQueries(ctx: AppContext): Promise<CheckResult> {
  const name = 'unbounded-queries';
  const start = Date.now();
  const findings: Finding[] = [];

  const sourceFiles = findSourceFiles(ctx.rootDir);

  for (const file of sourceFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Look for .findMany() or .select() without .limit() / .take()
    const hasFindMany = /\.findMany\s*\(\s*\{(?!\s*take:)/m.test(content) ||
                        /\.findMany\s*\(\s*\)/m.test(content);
    const hasSelectAll = /\.select\s*\(\s*['"`]\*['"`]\s*\)(?![\s\S]{0,100}\.limit\()/m.test(content);

    if ((hasFindMany || hasSelectAll) && /api|route|action/.test(rel)) {
      findings.push({
        id: makeId('data', `unbounded-${rel}`),
        category: 'data',
        severity: 'medium',
        title: `Unbounded database query — no pagination or limit`,
        description: `${rel} fetches records without a LIMIT or pagination constraint. As your data grows, this query will become slow and expensive.`,
        evidence: hasFindMany
          ? `findMany() without { take: N } in ${rel}`
          : `.select('*') without .limit(N) in ${rel}`,
        impact: `A table with 100k+ rows will cause slow responses, high DB load, and potential Vercel function timeouts. At scale this becomes a denial-of-service vector.`,
        fix: `Add pagination to all data-fetching queries:\n\n// Prisma\nconst items = await prisma.item.findMany({ take: 50, skip: offset });\n\n// Supabase\nconst { data } = await supabase.from('items').select('*').range(offset, offset + 49);`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { name, category: 'data', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function discoverMutationRoutes(rootDir: string): string[] {
  const routes: string[] = [];
  const appApiDir = path.join(rootDir, 'app', 'api');
  const pagesApiDir = path.join(rootDir, 'pages', 'api');

  walkForFiles(appApiDir, (f) => f.endsWith('route.ts') || f.endsWith('route.js'), routes);
  walkForFiles(pagesApiDir, (f) => f.endsWith('.ts') || f.endsWith('.js'), routes);

  return routes
    .map((f) => filePathToRoute(rootDir, f))
    .filter((r): r is string => r !== null)
    .filter((r) => /create|update|delete|register|subscribe|purchase|submit/.test(r));
}

function routeToFilePath(rootDir: string, route: string): string | undefined {
  const withoutApi = route.replace(/^\/api\//, '');
  const candidates = [
    path.join('app', 'api', withoutApi, 'route.ts'),
    path.join('pages', 'api', `${withoutApi}.ts`),
  ];
  return candidates.find((c) => fs.existsSync(path.join(rootDir, c))) ?? candidates[0];
}

function walkForFiles(dir: string, matcher: (n: string) => boolean, results: string[]): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walkForFiles(fp, matcher, results);
      else if (e.isFile() && matcher(e.name)) results.push(fp);
    }
  } catch { /* dir doesn't exist */ }
}

function filePathToRoute(rootDir: string, filePath: string): string | null {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const appMatch = /^app\/(.*?)\/route\.[tj]s$/.exec(rel);
  if (appMatch) return `/${appMatch[1]}`;
  const pagesMatch = /^pages\/(.*?)\.[tj]s$/.exec(rel);
  if (pagesMatch) return `/${pagesMatch[1]}`;
  return null;
}

function findSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) results.push(fp);
      }
    } catch { /* skip */ }
  }
  walk(rootDir);
  return results;
}
