import * as fs from 'fs';
import * as path from 'path';
import type { Finding } from '../engine/results/types.js';

// ─── Fix Templates ────────────────────────────────────────────────────────────
// Each template receives the original file content and returns the patched content.
// Returns null if the fix cannot be applied (already fixed, or file not found).

export type FixTemplate =
  | 'addAuthCheck'
  | 'addValidation'
  | 'addRateLimit'
  | 'addErrorBoundary'
  | 'addLoadingState'
  | 'fixEnvExposure'
  | 'addMethodHandler'
  | 'addCorsHeaders'
  | 'addMetaTags';

export interface ApplyResult {
  success: boolean;
  filePath: string;
  originalContent: string;
  newContent: string;
  error?: string;
}

// ─── Applier ──────────────────────────────────────────────────────────────────

export async function applyFix(
  rootDir: string,
  finding: Finding
): Promise<ApplyResult | null> {
  if (!finding.autoFixable || !finding.fixTemplate) return null;

  const template = finding.fixTemplate as FixTemplate;
  const targetFile = finding.file ? path.join(rootDir, finding.file) : null;

  switch (template) {
    case 'addAuthCheck':
      return targetFile ? applyAddAuthCheck(targetFile) : null;
    case 'addValidation':
      return targetFile ? applyAddValidation(targetFile) : null;
    case 'addRateLimit':
      return targetFile ? applyAddRateLimit(targetFile) : null;
    case 'addErrorBoundary':
      return applyAddErrorBoundary(rootDir, finding);
    case 'addLoadingState':
      return applyAddLoadingState(rootDir, finding);
    case 'fixEnvExposure':
      return targetFile ? applyFixEnvExposure(targetFile) : null;
    case 'addMethodHandler':
      return targetFile ? applyAddMethodHandler(targetFile) : null;
    case 'addCorsHeaders':
      return targetFile ? applyAddCorsHeaders(targetFile) : null;
    case 'addMetaTags':
      return applyAddMetaTags(rootDir);
    default:
      return null;
  }
}

// ─── Individual Fix Appliers ──────────────────────────────────────────────────

async function applyAddAuthCheck(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  // Already has auth check
  if (/getServerSession|auth\(\)|currentUser\(\)|createClient/.test(content)) {
    return fail(filePath, 'Auth check already present');
  }

  // Detect the export pattern
  const exportMatch = /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/m.exec(content);
  if (!exportMatch) return fail(filePath, 'Could not find route handler export');

  const methodName = exportMatch[1];
  const insertBefore = `export async function ${methodName}(`;
  const authImport = `import { getServerSession } from 'next-auth';\nimport { authOptions } from '@/lib/auth';\n`;
  const authCheck = `
  const session = await getServerSession(authOptions);
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
`;

  let newContent = content;

  // Add import if not present
  if (!content.includes('getServerSession')) {
    newContent = authImport + newContent;
  }

  // Add auth check at start of handler
  const handlerBodyStart = newContent.indexOf(insertBefore);
  if (handlerBodyStart === -1) return fail(filePath, 'Could not locate handler body');

  const braceIdx = newContent.indexOf('{', handlerBodyStart);
  if (braceIdx === -1) return fail(filePath, 'Could not locate handler opening brace');

  newContent = newContent.slice(0, braceIdx + 1) + authCheck + newContent.slice(braceIdx + 1);

  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddValidation(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  if (/z\.object|z\.string|safeParse/.test(content)) {
    return fail(filePath, 'Zod validation already present');
  }

  const zodImport = `import { z } from 'zod';\n`;
  const schema = `
const requestSchema = z.object({
  // TODO: Define your expected fields
  id: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().min(1).max(255).optional(),
});
`;

  let newContent = content;
  if (!content.includes("from 'zod'")) {
    newContent = zodImport + newContent;
  }

  // Add schema before first export
  const firstExport = newContent.search(/export\s+(?:async\s+)?function/);
  if (firstExport === -1) return fail(filePath, 'Could not find export to insert schema before');

  newContent = newContent.slice(0, firstExport) + schema + '\n' + newContent.slice(firstExport);

  // Add validation at start of POST handler body
  const postMatch = /export\s+async\s+function\s+POST\s*\([^)]*\)\s*\{/m.exec(newContent);
  if (postMatch) {
    const insertAt = postMatch.index + postMatch[0].length;
    const validationBlock = `
  const body = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request', details: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;
`;
    newContent = newContent.slice(0, insertAt) + validationBlock + newContent.slice(insertAt);
  }

  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddRateLimit(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  if (/ratelimit|rate.limit/i.test(content)) {
    return fail(filePath, 'Rate limiting already present');
  }

  const rateLimitImport = `import { headers } from 'next/headers';\n`;
  const rateLimitBlock = `
  // Basic rate limiting — replace with @upstash/ratelimit for production
  const headersList = headers();
  const ip = headersList.get('x-forwarded-for') ?? 'anonymous';
  void ip; // Use ip with your rate limit store
`;

  let newContent = content;
  if (!content.includes("from 'next/headers'")) {
    newContent = rateLimitImport + newContent;
  }

  const firstHandler = /export\s+async\s+function\s+(?:GET|POST|PUT|DELETE)\s*\([^)]*\)\s*\{/m.exec(newContent);
  if (!firstHandler) return fail(filePath, 'Could not find route handler');

  const insertAt = firstHandler.index + firstHandler[0].length;
  newContent = newContent.slice(0, insertAt) + rateLimitBlock + newContent.slice(insertAt);

  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddErrorBoundary(rootDir: string, _finding: Finding): Promise<ApplyResult> {
  // Find the route segment directories from the finding
  const errorTemplate = `'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-gray-500">{error.message}</p>
      <button
        onClick={reset}
        className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      >
        Try again
      </button>
    </div>
  );
}
`;

  // Determine target directory
  const appDir = path.join(rootDir, 'app');
  const errorPath = path.join(appDir, 'error.tsx');

  if (fs.existsSync(errorPath)) {
    return fail(errorPath, 'error.tsx already exists');
  }

  writeFile(errorPath, errorTemplate);
  return ok(errorPath, '', errorTemplate);
}

async function applyAddLoadingState(rootDir: string, finding: Finding): Promise<ApplyResult> {
  const loadingTemplate = `export default function Loading() {
  return (
    <div className="flex min-h-[400px] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
    </div>
  );
}
`;

  const targetDir = finding.file
    ? path.join(rootDir, path.dirname(finding.file))
    : path.join(rootDir, 'app');

  const loadingPath = path.join(targetDir, 'loading.tsx');

  if (fs.existsSync(loadingPath)) {
    return fail(loadingPath, 'loading.tsx already exists');
  }

  try { fs.mkdirSync(targetDir, { recursive: true }); } catch { /* already exists */ }
  writeFile(loadingPath, loadingTemplate);
  return ok(loadingPath, '', loadingTemplate);
}

async function applyFixEnvExposure(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  // Replace NEXT_PUBLIC_ service role references
  const newContent = content
    .replace(/process\.env\.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/g, 'process.env.SUPABASE_SERVICE_ROLE_KEY')
    .replace(/process\.env\.NEXT_PUBLIC_STRIPE_SECRET_KEY/g, 'process.env.STRIPE_SECRET_KEY');

  if (newContent === content) return fail(filePath, 'No NEXT_PUBLIC_ secret references found');

  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddMethodHandler(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  // Find which methods are NOT exported and add 405 handlers
  const exportedMethods = new Set<string>();
  const methodRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(content)) !== null) {
    exportedMethods.add(m[1]);
  }

  const allMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  const missingMethods = allMethods.filter((method) => !exportedMethods.has(method));

  if (missingMethods.length === 0) {
    return fail(filePath, 'All common methods already handled');
  }

  const handlers = missingMethods
    .map((method) => `\nexport function ${method}() {\n  return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: [...exportedMethods].join(', ') } });\n}`)
    .join('\n');

  const newContent = content + handlers;
  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddCorsHeaders(filePath: string): Promise<ApplyResult> {
  const content = tryRead(filePath);
  if (!content) return fail(filePath, 'File not found');

  if (/Access-Control-Allow-Origin.*NEXT_PUBLIC_APP_URL/.test(content)) {
    return fail(filePath, 'CORS headers already configured');
  }

  // Replace wildcard CORS with specific origin
  const newContent = content.replace(
    /'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/g,
    `'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_APP_URL ?? '*'`
  );

  if (newContent === content) return fail(filePath, 'No wildcard CORS found to fix');

  writeFile(filePath, newContent);
  return ok(filePath, content, newContent);
}

async function applyAddMetaTags(rootDir: string): Promise<ApplyResult> {
  const layoutPath = path.join(rootDir, 'app', 'layout.tsx');
  const content = tryRead(layoutPath);
  if (!content) return fail(layoutPath, 'app/layout.tsx not found');

  if (/export\s+const\s+metadata/.test(content)) {
    return fail(layoutPath, 'Metadata already exported');
  }

  const metadataBlock = `
export const metadata = {
  title: {
    default: 'Your App Name',
    template: '%s | Your App Name',
  },
  description: 'Your app description',
  openGraph: {
    title: 'Your App Name',
    description: 'Your app description',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

`;

  // Insert after imports
  const lastImportIdx = findLastImportIndex(content);
  const insertAt = lastImportIdx === -1 ? 0 : lastImportIdx;
  const newContent = content.slice(0, insertAt) + '\n' + metadataBlock + content.slice(insertAt);

  writeFile(layoutPath, newContent);
  return ok(layoutPath, content, newContent);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryRead(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function ok(filePath: string, originalContent: string, newContent: string): ApplyResult {
  return { success: true, filePath, originalContent, newContent };
}

function fail(filePath: string, error: string): ApplyResult {
  return { success: false, filePath, originalContent: '', newContent: '', error };
}

function findLastImportIndex(content: string): number {
  const lines = content.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i] ?? '')) lastImportLine = i;
  }
  if (lastImportLine === -1) return 0;
  return lines.slice(0, lastImportLine + 1).join('\n').length + 1;
}
