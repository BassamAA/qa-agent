import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

const execAsync = promisify(exec);

// ─── Port Finder ──────────────────────────────────────────────────────────────

async function findFreePort(start = 3333): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(start, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : start;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      findFreePort(start + 1).then(resolve).catch(reject);
    });
  });
}

// ─── App Starter ─────────────────────────────────────────────────────────────

export interface StartResult {
  success: boolean;
  url: string;
  port: number;
  pid?: number;
  error?: string;
  missingEnvVars?: string[];
  stop: () => Promise<void>;
}

const REQUIRED_ENV_HINTS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'NEXTAUTH_URL',
];

export async function startApp(rootDir: string): Promise<StartResult> {
  const noop = async () => undefined;

  // Check for missing env vars
  const envPath = path.join(rootDir, '.env.local');
  const envExamplePath = path.join(rootDir, '.env.example');
  const missingEnvVars: string[] = [];

  const exampleContent = readFile(envExamplePath) ?? readFile(path.join(rootDir, '.env')) ?? '';
  const localContent = readFile(envPath) ?? '';

  for (const hint of REQUIRED_ENV_HINTS) {
    if (exampleContent.includes(hint) && !localContent.includes(hint)) {
      missingEnvVars.push(hint);
    }
  }

  if (missingEnvVars.length > 0) {
    return {
      success: false,
      url: '',
      port: 0,
      error: `Missing required environment variables: ${missingEnvVars.join(', ')}`,
      missingEnvVars,
      stop: noop,
    };
  }

  // Check package.json for start/dev command
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = readJSON<{ scripts?: Record<string, string> }>(pkgPath);
  if (!pkg) {
    return {
      success: false,
      url: '',
      port: 0,
      error: 'No package.json found — cannot start app',
      stop: noop,
    };
  }

  // Check node_modules
  const nodeModulesPath = path.join(rootDir, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    try {
      await execAsync('npm install', { cwd: rootDir });
    } catch (err) {
      return {
        success: false,
        url: '',
        port: 0,
        error: `npm install failed: ${String(err)}`,
        stop: noop,
      };
    }
  }

  // Build first if needed
  const hasBuildScript = pkg.scripts?.['build'];
  if (hasBuildScript) {
    try {
      await execAsync('npm run build', {
        cwd: rootDir,
        env: { ...process.env, NODE_ENV: 'production' },
      });
    } catch (err) {
      return {
        success: false,
        url: '',
        port: 0,
        error: `Build failed: ${String(err)}`,
        stop: noop,
      };
    }
  }

  const port = await findFreePort(3333);
  const startCmd = pkg.scripts?.['start'] ?? 'npx next start';

  const child = spawn('sh', ['-c', startCmd], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    stdio: 'pipe',
    detached: false,
  });

  // Wait for the app to be ready
  const ready = await waitForPort(port, 30_000);
  if (!ready) {
    child.kill();
    return {
      success: false,
      url: '',
      port,
      error: `App did not start on port ${port} within 30 seconds`,
      stop: noop,
    };
  }

  const url = `http://localhost:${port}`;
  const pid = child.pid;

  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (child.pid && isProcessRunning(child.pid)) {
      child.kill('SIGKILL');
    }
  };

  return { success: true, url, port, pid, stop };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function readJSON<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
}
