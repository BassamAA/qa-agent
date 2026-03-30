import type { EngineResult, AppContext } from './results/types.js';
import { ResultCollector } from './results/collector.js';
import { buildAppContext } from './runner.js';
import { runAuthChecks } from './checks/auth.js';
import { runDataChecks } from './checks/data.js';
import { runPaymentChecks } from './checks/payment.js';
import { runAPIChecks } from './checks/api.js';
import { runConfigChecks } from './checks/config.js';
import { runFrontendChecks } from './checks/frontend.js';

// ─── Engine Options ───────────────────────────────────────────────────────────

export interface EngineOptions {
  url?: string;
  skipCategories?: Array<'auth' | 'data' | 'payment' | 'api' | 'config' | 'frontend'>;
  onProgress?: (phase: string, detail?: string) => void;
}

// ─── Main Engine ──────────────────────────────────────────────────────────────

export async function runEngine(
  rootDir: string,
  options: EngineOptions = {}
): Promise<EngineResult> {
  const { onProgress, skipCategories = [] } = options;
  const skip = new Set(skipCategories);

  // 1. Start the app / connect to URL
  onProgress?.('setup', 'Starting application...');
  const { ctx, stop, appStarted, appStartError } = await buildAppContext(rootDir, {
    url: options.url,
  });

  const collector = new ResultCollector({
    appName: ctx.appName,
    appUrl: ctx.appUrl,
    rootDir: ctx.rootDir,
  });

  if (!appStarted && appStartError) {
    collector.setAppStartError(appStartError);
  }

  try {
    // 2. Run all check categories in parallel where possible
    const checkPhases: Array<{
      name: string;
      runner: (ctx: AppContext) => Promise<import('./results/types.js').CheckResult[]>;
    }> = [
      { name: 'auth',     runner: runAuthChecks },
      { name: 'data',     runner: runDataChecks },
      { name: 'payment',  runner: runPaymentChecks },
      { name: 'api',      runner: runAPIChecks },
      { name: 'config',   runner: runConfigChecks },
      { name: 'frontend', runner: runFrontendChecks },
    ];

    for (const phase of checkPhases) {
      if (skip.has(phase.name as typeof skipCategories[number])) continue;

      onProgress?.(phase.name, `Running ${phase.name} checks...`);
      try {
        const results = await phase.runner(ctx);
        for (const result of results) {
          collector.addCheckResult(result);
        }
      } catch (err) {
        // Don't let one category's failure stop the rest
        collector.addCheckResult({
          name: phase.name,
          category: phase.name as import('./results/types.js').FindingCategory,
          status: 'error',
          findings: [],
          duration: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    onProgress?.('cleanup', 'Shutting down test app...');
    await stop();
  }

  return collector.build();
}

export type { EngineResult, AppContext };
