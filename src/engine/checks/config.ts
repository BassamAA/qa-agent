import * as fs from 'fs';
import * as path from 'path';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';

export async function runConfigChecks(ctx: AppContext): Promise<CheckResult[]> {
  return Promise.all([
    checkHardcodedSecrets(ctx),
    checkNextConfig(ctx),
    checkEnvSeparation(ctx),
    checkMissingEnvVars(ctx),
  ]);
}

// ─── Check: Hardcoded Secrets ─────────────────────────────────────────────────

async function checkHardcodedSecrets(ctx: AppContext): Promise<CheckResult> {
  const name = 'hardcoded-secrets';
  const start = Date.now();
  const findings: Finding[] = [];

  const secretPatterns = [
    { re: /sk_live_[a-zA-Z0-9]{24,}/, label: 'Stripe live secret key', severity: 'critical' as const },
    { re: /sk_test_[a-zA-Z0-9]{24,}/, label: 'Stripe test secret key', severity: 'high' as const },
    { re: /whsec_[a-zA-Z0-9]{24,}/, label: 'Stripe webhook secret', severity: 'high' as const },
    { re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/, label: 'Hardcoded JWT token', severity: 'critical' as const },
    { re: /service_role['":\s]+ey[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/, label: 'Supabase service role JWT', severity: 'critical' as const },
    { re: /password\s*[:=]\s*['"][^'"]{8,}['"]/, label: 'Hardcoded password', severity: 'high' as const },
    { re: /secret\s*[:=]\s*['"][a-zA-Z0-9+/]{20,}={0,2}['"]/, label: 'Hardcoded secret string', severity: 'high' as const },
    { re: /AKIA[0-9A-Z]{16}/, label: 'AWS Access Key ID', severity: 'critical' as const },
  ];

  const sourceFiles = findSourceFiles(ctx.rootDir, ['.ts', '.tsx', '.js', '.jsx', '.json']);

  for (const file of sourceFiles) {
    const rel = path.relative(ctx.rootDir, file);
    // Skip .env files (those are expected to have secrets but shouldn't be in git)
    if (rel.startsWith('.env')) continue;
    // Skip test fixtures and example files
    if (/\.(example|sample|test|spec)\.|__fixtures__|__mocks__/.test(rel)) continue;

    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    for (const { re, label, severity } of secretPatterns) {
      const match = re.exec(content);
      if (match) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        const masked = match[0].slice(0, 8) + '...' + match[0].slice(-4);
        findings.push({
          id: makeId('config', `secret-${rel}`),
          category: 'config',
          severity,
          title: `Hardcoded ${label} found in source code`,
          description: `${rel}:${lineNum} contains what appears to be a ${label} hardcoded in source. This will be committed to git and exposed to anyone with repo access.`,
          evidence: `${rel}:${lineNum} — matched: ${masked}`,
          impact: `Hardcoded secrets in git are permanent (git history) even after removal. Any developer, contractor, or repo breach exposes this credential.`,
          fix: `Move this value to an environment variable:\n\n1. Add to .env.local: MY_SECRET=<value>\n2. In code: process.env.MY_SECRET\n3. Add .env.local to .gitignore if not already\n4. Rotate the compromised credential immediately`,
          file: rel,
          line: lineNum,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break; // one finding per file
      }
    }
  }

  return { name, category: 'config', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Next.js Configuration ────────────────────────────────────────────

async function checkNextConfig(ctx: AppContext): Promise<CheckResult> {
  const name = 'next-config';
  const start = Date.now();
  const findings: Finding[] = [];

  const configPaths = [
    path.join(ctx.rootDir, 'next.config.js'),
    path.join(ctx.rootDir, 'next.config.ts'),
    path.join(ctx.rootDir, 'next.config.mjs'),
  ];

  let configContent: string | null = null;
  let configFile: string | null = null;
  for (const cp of configPaths) {
    try { configContent = fs.readFileSync(cp, 'utf-8'); configFile = cp; break; } catch { /* try next */ }
  }

  if (!configContent || !configFile) {
    // No next config — flag it
    findings.push({
      id: makeId('config', 'no-next-config'),
      category: 'config',
      severity: 'low',
      title: `No next.config.js found`,
      description: `A next.config.js file is missing. This is where you configure security headers, redirects, and other important settings.`,
      evidence: `next.config.js / next.config.ts / next.config.mjs not found in project root`,
      impact: `Without explicit security headers configuration, your app may lack important protections like CSP, X-Frame-Options, and HSTS.`,
      fix: `Create next.config.js with security headers:\n\nconst securityHeaders = [\n  { key: 'X-Frame-Options', value: 'DENY' },\n  { key: 'X-Content-Type-Options', value: 'nosniff' },\n  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },\n];\n\nmodule.exports = { async headers() { return [{ source: '/(.*)', headers: securityHeaders }] } };`,
      autoFixable: false,
      checkName: name,
      timestamp: new Date().toISOString(),
    });
    return { name, category: 'config', status: 'failed', findings, duration: Date.now() - start };
  }

  const relConfig = path.relative(ctx.rootDir, configFile);

  // Check for security headers
  if (!/headers\s*\(\s*\)/.test(configContent)) {
    findings.push({
      id: makeId('config', 'missing-security-headers'),
      category: 'config',
      severity: 'medium',
      title: `Security headers not configured in next.config.js`,
      description: `${relConfig} does not define a headers() function. Your app is missing important security headers like X-Frame-Options, X-Content-Type-Options, and CSP.`,
      evidence: `No headers() function found in ${relConfig}`,
      impact: `Missing security headers make your app vulnerable to clickjacking, MIME type sniffing attacks, and make CSP enforcement impossible.`,
      fix: `Add security headers to ${relConfig}:\n\nasync headers() {\n  return [{\n    source: '/(.*)',\n    headers: [\n      { key: 'X-Frame-Options', value: 'DENY' },\n      { key: 'X-Content-Type-Options', value: 'nosniff' },\n      { key: 'Permissions-Policy', value: 'camera=(), microphone=()' },\n    ]\n  }];\n}`,
      file: relConfig,
      autoFixable: false,
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  // Check for dangerous settings
  if (/dangerouslyAllowSVG.*true/.test(configContent)) {
    findings.push({
      id: makeId('config', 'dangerous-svg'),
      category: 'config',
      severity: 'medium',
      title: `dangerouslyAllowSVG is enabled`,
      description: `${relConfig} enables dangerouslyAllowSVG for Next.js Image optimization. SVG files can contain embedded scripts.`,
      evidence: `dangerouslyAllowSVG: true found in ${relConfig}`,
      impact: `Malicious SVG images could execute JavaScript in the browser context of your domain.`,
      fix: `Remove dangerouslyAllowSVG: true, or add contentSecurityPolicy alongside it:\ncontentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;"`,
      file: relConfig,
      autoFixable: false,
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  return { name, category: 'config', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Env Separation ────────────────────────────────────────────────────

async function checkEnvSeparation(ctx: AppContext): Promise<CheckResult> {
  const name = 'env-separation';
  const start = Date.now();
  const findings: Finding[] = [];

  // Check if .env or .env.local is in git (not just .gitignore)
  const gitignorePath = path.join(ctx.rootDir, '.gitignore');
  let gitignoreContent = '';
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* no gitignore */ }

  const envFiles = ['.env', '.env.local', '.env.production'];
  for (const envFile of envFiles) {
    const envPath = path.join(ctx.rootDir, envFile);
    if (!fs.existsSync(envPath)) continue;

    if (!gitignoreContent.includes(envFile) && !gitignoreContent.includes('.env')) {
      findings.push({
        id: makeId('config', `env-in-git-${envFile}`),
        category: 'config',
        severity: 'critical',
        title: `${envFile} is not in .gitignore`,
        description: `The file ${envFile} exists but is not listed in .gitignore. It may have already been committed to git, exposing all secrets to anyone with repo access.`,
        evidence: `${envFile} exists, not found in .gitignore`,
        impact: `All secrets in ${envFile} (database URLs, API keys, JWT secrets) are visible in git history permanently.`,
        fix: `1. Add to .gitignore:\n.env\n.env.local\n.env.*.local\n\n2. Remove from git tracking:\ngit rm --cached ${envFile}\n\n3. Rotate ALL secrets in the file immediately`,
        file: '.gitignore',
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Check for NEXT_PUBLIC_ prefixed secrets (exposed to browser)
  const publicEnvPatterns = [
    /NEXT_PUBLIC_.*SECRET/i,
    /NEXT_PUBLIC_.*PRIVATE/i,
    /NEXT_PUBLIC_.*SERVICE_ROLE/i,
    /NEXT_PUBLIC_.*PASSWORD/i,
    /NEXT_PUBLIC_STRIPE_SECRET/i,
  ];

  for (const envFile of ['.env', '.env.local', '.env.example']) {
    const content = tryReadFile(path.join(ctx.rootDir, envFile));
    if (!content) continue;

    for (const pattern of publicEnvPatterns) {
      const match = pattern.exec(content);
      if (match) {
        findings.push({
          id: makeId('config', `public-secret-${envFile}`),
          category: 'config',
          severity: 'critical',
          title: `Secret variable exposed as NEXT_PUBLIC_ in ${envFile}`,
          description: `${match[0].split('=')[0]} in ${envFile} has the NEXT_PUBLIC_ prefix, which embeds it in client-side JavaScript bundles. This exposes the secret to all users.`,
          evidence: `${envFile}: ${match[0].split('=')[0]}`,
          impact: `The secret is visible in your deployed JS bundle. Anyone can view it in DevTools → Sources.`,
          fix: `Remove the NEXT_PUBLIC_ prefix. Only access it server-side (API routes, server actions, middleware):\nprocess.env.MY_SECRET (server-only)\nNever: process.env.NEXT_PUBLIC_MY_SECRET for secrets`,
          file: envFile,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  return { name, category: 'config', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Missing Env Vars ──────────────────────────────────────────────────

async function checkMissingEnvVars(ctx: AppContext): Promise<CheckResult> {
  const name = 'missing-env-vars';
  const start = Date.now();
  const findings: Finding[] = [];

  const exampleEnvPath = path.join(ctx.rootDir, '.env.example');
  const exampleContent = tryReadFile(exampleEnvPath);
  if (!exampleContent) {
    return { name, category: 'config', status: 'skipped', findings, duration: Date.now() - start };
  }

  const exampleVars = parseEnvKeys(exampleContent);
  const localContent = tryReadFile(path.join(ctx.rootDir, '.env.local')) ??
                       tryReadFile(path.join(ctx.rootDir, '.env')) ?? '';
  const localVars = new Set(parseEnvKeys(localContent));

  const missing = exampleVars.filter((v) => !localVars.has(v) && !process.env[v]);

  if (missing.length > 0) {
    findings.push({
      id: makeId('config', 'missing-vars'),
      category: 'config',
      severity: 'high',
      title: `${missing.length} required environment variable(s) missing`,
      description: `Variables defined in .env.example but not found in .env.local or environment: ${missing.join(', ')}`,
      evidence: `Missing: ${missing.join('\n- ')}`,
      impact: `Your app cannot be run from a fresh clone. CI/CD deployments will fail, and new developers will be blocked. Some missing vars may cause runtime crashes.`,
      fix: `Copy .env.example to .env.local and fill in the missing values:\ncp .env.example .env.local\n# Then edit .env.local and add: ${missing.slice(0, 3).join(', ')}`,
      file: '.env.example',
      autoFixable: false,
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  return { name, category: 'config', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findSourceFiles(rootDir: string, extensions: string[]): string[] {
  const results: string[] = [];
  const extSet = new Set(extensions);
  function walk(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (extSet.has(path.extname(e.name))) results.push(fp);
      }
    } catch { /* skip */ }
  }
  walk(rootDir);
  return results;
}

function tryReadFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function parseEnvKeys(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.split('=')[0]?.trim())
    .filter((k): k is string => !!k && !k.startsWith('#') && k.length > 0);
}
