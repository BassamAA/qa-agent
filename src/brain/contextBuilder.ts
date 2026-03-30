import type { ScanResult, BrainContext, TestFramework } from '../types/index.js';

// ─── Context Builder ──────────────────────────────────────────────────────────
// Assembles scanner outputs into a compact, structured context object
// to be serialized and sent to the LLM. Keeps token count reasonable
// by trimming verbose/redundant fields.

const MAX_FILES_IN_CONTEXT = 80;
const MAX_UNTESTED_FILES = 40;
const MAX_RISK_FILES = 30;
const MAX_TEST_FILES = 20;

export function buildContext(
  scan: ScanResult,
  options: {
    targetFiles?: string[];
    userGoal?: string;
    existingTestFramework?: TestFramework;
  } = {}
): BrainContext {
  return {
    scan: trimScanResult(scan),
    targetFiles: options.targetFiles,
    userGoal: options.userGoal,
    existingTestFramework: options.existingTestFramework ?? scan.tests.framework,
  };
}

function trimScanResult(scan: ScanResult): ScanResult {
  // Trim file map to avoid overwhelming the LLM
  const allFiles = Object.entries(scan.fileMap);
  const trimmedFileMap = Object.fromEntries(
    allFiles
      .sort(([, a], [, b]) => b.size - a.size) // sort by size desc
      .slice(0, MAX_FILES_IN_CONTEXT)
      .map(([k, v]) => [
        k,
        {
          path: v.path,
          absolutePath: v.absolutePath,
          size: v.size,
          lineCount: v.lineCount,
          language: v.language,
          imports: v.imports.slice(0, 20),
          exports: v.exports.slice(0, 20),
        },
      ])
  );

  return {
    ...scan,
    fileMap: trimmedFileMap,
    risks: scan.risks.slice(0, MAX_RISK_FILES),
    tests: {
      ...scan.tests,
      testFiles: scan.tests.testFiles.slice(0, MAX_TEST_FILES),
      untestedSourceFiles: scan.tests.untestedSourceFiles.slice(0, MAX_UNTESTED_FILES),
    },
  };
}

// ─── Context Serializer ───────────────────────────────────────────────────────
// Produces a structured, human-readable JSON representation

export interface SerializedContext {
  project: {
    rootDir: string;
    scannedAt: string;
    summary: ScanResult['summary'];
  };
  stack: ScanResult['stack'];
  existingTests: {
    framework: string;
    totalFiles: number;
    hasUnit: boolean;
    hasIntegration: boolean;
    hasE2E: boolean;
    configFiles: string[];
    untestedFiles: string[];
  };
  ci: {
    platform: string;
    hasTestAutomation: boolean;
    hasCoverageReporting: boolean;
  };
  riskProfile: {
    critical: Array<{ path: string; score: number; reasons: string[] }>;
    high: Array<{ path: string; score: number; reasons: string[] }>;
    untestedCritical: string[];
  };
  sourceFiles: Array<{
    path: string;
    language: string;
    lineCount: number;
    imports: string[];
    exports: string[];
  }>;
  userGoal?: string;
  targetFiles?: string[];
}

export function serializeContext(ctx: BrainContext): SerializedContext {
  const { scan } = ctx;

  const critical = scan.risks.filter((r) => r.recommendation === 'critical');
  const high = scan.risks.filter((r) => r.recommendation === 'high');
  const untestedSet = new Set(scan.tests.untestedSourceFiles);
  const untestedCritical = critical.filter((r) => untestedSet.has(r.path)).map((r) => r.path);

  const sourceFiles = Object.values(scan.fileMap)
    .filter((f) => !f.path.includes('test') && !f.path.includes('spec'))
    .map((f) => ({
      path: f.path,
      language: f.language,
      lineCount: f.lineCount,
      imports: f.imports.slice(0, 15),
      exports: f.exports.slice(0, 15),
    }))
    .sort((a, b) => b.lineCount - a.lineCount)
    .slice(0, 60);

  return {
    project: {
      rootDir: scan.rootDir,
      scannedAt: scan.scannedAt,
      summary: scan.summary,
    },
    stack: scan.stack,
    existingTests: {
      framework: scan.tests.framework,
      totalFiles: scan.tests.totalTests,
      hasUnit: scan.tests.hasUnit,
      hasIntegration: scan.tests.hasIntegration,
      hasE2E: scan.tests.hasE2E,
      configFiles: scan.tests.configFiles,
      untestedFiles: scan.tests.untestedSourceFiles.slice(0, MAX_UNTESTED_FILES),
    },
    ci: {
      platform: scan.ci.platform,
      hasTestAutomation: scan.ci.hasTestAutomation,
      hasCoverageReporting: scan.ci.hasCoverageReporting,
    },
    riskProfile: {
      critical: critical.slice(0, 15).map((r) => ({
        path: r.path,
        score: r.score,
        reasons: r.reasons,
      })),
      high: high.slice(0, 15).map((r) => ({
        path: r.path,
        score: r.score,
        reasons: r.reasons,
      })),
      untestedCritical,
    },
    sourceFiles,
    userGoal: ctx.userGoal,
    targetFiles: ctx.targetFiles,
  };
}
