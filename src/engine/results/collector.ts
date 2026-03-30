import type {
  Finding,
  CheckResult,
  CategorySummary,
  EngineResult,
  FindingCategory,
} from './types.js';

// ─── Result Collector ─────────────────────────────────────────────────────────

export class ResultCollector {
  private findings: Finding[] = [];
  private checkResults: CheckResult[] = [];
  private startedAt: string;
  private appName: string;
  private appUrl: string;
  private rootDir: string;
  private appStarted = true;
  private appStartError?: string;

  constructor(opts: { appName: string; appUrl: string; rootDir: string }) {
    this.appName = opts.appName;
    this.appUrl = opts.appUrl;
    this.rootDir = opts.rootDir;
    this.startedAt = new Date().toISOString();
  }

  addCheckResult(result: CheckResult): void {
    this.checkResults.push(result);
    this.findings.push(...result.findings);
  }

  setAppStartError(error: string): void {
    this.appStarted = false;
    this.appStartError = error;
  }

  build(): EngineResult {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(this.startedAt).getTime();

    const categorySummaries = buildCategorySummaries(this.checkResults);
    const healthScore = calculateHealthScore(this.findings);

    return {
      appName: this.appName,
      appUrl: this.appUrl,
      rootDir: this.rootDir,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      findings: this.findings.sort(severityOrder),
      checkResults: this.checkResults,
      categorySummaries,
      healthScore,
      appStarted: this.appStarted,
      appStartError: this.appStartError,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_LIST: FindingCategory[] = ['auth', 'data', 'payment', 'api', 'config', 'frontend'];

function buildCategorySummaries(
  checkResults: CheckResult[]
): Record<FindingCategory, CategorySummary> {
  const summaries = {} as Record<FindingCategory, CategorySummary>;

  for (const cat of CATEGORY_LIST) {
    const catChecks = checkResults.filter((r) => r.category === cat);
    summaries[cat] = {
      category: cat,
      checksRun: catChecks.length,
      passed: catChecks.filter((r) => r.status === 'passed').length,
      failed: catChecks.filter((r) => r.status === 'failed').length,
      skipped: catChecks.filter((r) => r.status === 'skipped').length,
      findings: catChecks.flatMap((r) => r.findings),
    };
  }

  return summaries;
}

function calculateHealthScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    switch (f.severity) {
      case 'critical': score -= 15; break;
      case 'high':     score -= 8;  break;
      case 'medium':   score -= 3;  break;
      case 'low':      score -= 1;  break;
    }
  }
  return Math.max(0, score);
}

const SEVERITY_WEIGHT: Record<Finding['severity'], number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

function severityOrder(a: Finding, b: Finding): number {
  return SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
}
