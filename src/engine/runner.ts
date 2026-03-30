import * as fs from 'fs';
import * as path from 'path';
import type { AppContext } from './results/types.js';
import { startApp } from './utils/appStarter.js';

// ─── Env Loader ───────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return vars;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function loadAllEnv(rootDir: string): Record<string, string> {
  // Load in priority order: .env < .env.local
  const base = loadEnvFile(path.join(rootDir, '.env'));
  const local = loadEnvFile(path.join(rootDir, '.env.local'));
  const example = loadEnvFile(path.join(rootDir, '.env.example'));

  return { ...example, ...base, ...local, ...process.env as Record<string, string> };
}

// ─── App Name ─────────────────────────────────────────────────────────────────

function getAppName(rootDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')) as { name?: string };
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }
  return path.basename(rootDir);
}

// ─── Framework Detector ───────────────────────────────────────────────────────

function detectFramework(rootDir: string): string {
  if (fs.existsSync(path.join(rootDir, 'next.config.js')) ||
      fs.existsSync(path.join(rootDir, 'next.config.ts')) ||
      fs.existsSync(path.join(rootDir, 'next.config.mjs'))) {
    return 'nextjs';
  }
  if (fs.existsSync(path.join(rootDir, 'nuxt.config.ts'))) return 'nuxtjs';
  if (fs.existsSync(path.join(rootDir, 'vite.config.ts'))) return 'vite';
  return 'unknown';
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface RunnerOptions {
  url?: string;
  port?: number;
  skipBuild?: boolean;
}

export interface RunnerResult {
  ctx: AppContext;
  stop: () => Promise<void>;
  appStarted: boolean;
  appStartError?: string;
}

export async function buildAppContext(
  rootDir: string,
  options: RunnerOptions = {}
): Promise<RunnerResult> {
  const absoluteRoot = path.resolve(rootDir);
  const envVars = loadAllEnv(absoluteRoot);
  const appName = getAppName(absoluteRoot);
  const framework = detectFramework(absoluteRoot);

  const supabaseUrl = envVars['NEXT_PUBLIC_SUPABASE_URL'] ?? envVars['SUPABASE_URL'];
  const supabaseAnonKey = envVars['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? envVars['SUPABASE_ANON_KEY'];
  const supabaseServiceRoleKey = envVars['SUPABASE_SERVICE_ROLE_KEY'];
  const stripeSecretKey = envVars['STRIPE_SECRET_KEY'];
  const stripeWebhookSecret = envVars['STRIPE_WEBHOOK_SECRET'];

  const hasSupabase = !!(supabaseUrl && supabaseAnonKey);
  const hasStripe = !!(stripeSecretKey);

  let appUrl = options.url ?? '';
  let stop: () => Promise<void> = async () => undefined;
  let appStarted = false;
  let appStartError: string | undefined;

  if (!appUrl) {
    const startResult = await startApp(absoluteRoot);
    if (startResult.success) {
      appUrl = startResult.url;
      stop = startResult.stop;
      appStarted = true;
    } else {
      appStartError = startResult.error;
      appUrl = `http://localhost:3000`; // fallback guess
    }
  } else {
    appStarted = true;
  }

  const ctx: AppContext = {
    rootDir: absoluteRoot,
    appUrl,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    stripeSecretKey,
    stripeWebhookSecret,
    hasStripe,
    hasSupabase,
    appName,
    framework,
    envVars,
  };

  return { ctx, stop, appStarted, appStartError };
}
