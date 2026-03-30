import { exec } from 'child_process';
import { promisify } from 'util';
import type { Finding } from '../engine/results/types.js';

const execAsync = promisify(exec);

// ─── Build Verifier ───────────────────────────────────────────────────────────

export interface BuildResult {
  passed: boolean;
  error?: string;
  duration: number;
}

export async function verifyBuild(rootDir: string): Promise<BuildResult> {
  const start = Date.now();
  try {
    await execAsync('npm run build', {
      cwd: rootDir,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 120_000, // 2 min max
    });
    return { passed: true, duration: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { passed: false, error, duration: Date.now() - start };
  }
}

// ─── Type Check ───────────────────────────────────────────────────────────────

export async function verifyTypeCheck(rootDir: string): Promise<BuildResult> {
  const start = Date.now();
  try {
    await execAsync('npx tsc --noEmit', { cwd: rootDir, timeout: 60_000 });
    return { passed: true, duration: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { passed: false, error, duration: Date.now() - start };
  }
}

// ─── Finding Re-checker ───────────────────────────────────────────────────────
// Re-runs a lightweight static check to confirm the fix was applied

export async function verifyFix(
  rootDir: string,
  _finding: Finding,
  _fixedFilePath: string
): Promise<boolean> {
  // For now, verify via TypeScript compilation
  // In a full implementation, this would re-run the specific check
  const { passed } = await verifyTypeCheck(rootDir);
  return passed;
}
