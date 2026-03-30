import * as path from 'path';
import type { ScanResult, ScanSummary } from '../types/index.js';
import { analyzeFiles, getLanguageBreakdown, getTotalLines } from './fileAnalyzer.js';
import { detectStack } from './stackDetector.js';
import { detectTests } from './testDetector.js';
import { detectCI } from './ciDetector.js';
import { analyzeRisks, getCriticalFiles, getHighRiskFiles, getUntestedCriticalFiles } from './riskAnalyzer.js';

export interface ScanOptions {
  additionalIgnore?: string[];
  maxDepth?: number;
  onProgress?: (stage: string, detail?: string) => void;
}

export async function scan(rootDir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteRoot = path.resolve(rootDir);
  const { onProgress } = options;

  onProgress?.('files', 'Walking directory tree...');
  const fileMap = analyzeFiles(absoluteRoot, {
    additionalIgnore: options.additionalIgnore,
    maxDepth: options.maxDepth,
    onProgress: (n) => onProgress?.('files', `${n} files scanned...`),
  });

  onProgress?.('stack', 'Detecting tech stack...');
  const stack = detectStack(absoluteRoot);

  onProgress?.('tests', 'Finding existing tests...');
  const tests = detectTests(absoluteRoot, fileMap);

  onProgress?.('ci', 'Detecting CI configuration...');
  const ci = detectCI(absoluteRoot);

  onProgress?.('risks', 'Scoring risk for each file...');
  const risks = analyzeRisks(fileMap);

  // Build summary
  const languageBreakdown = getLanguageBreakdown(fileMap);
  const totalLinesOfCode = getTotalLines(fileMap);
  const criticalFiles = getCriticalFiles(risks).length;
  const highRiskFiles = getHighRiskFiles(risks).length;
  const untestedCriticalFiles = getUntestedCriticalFiles(risks, tests.untestedSourceFiles);

  // Estimate coverage as percentage of source files that have a corresponding test
  const totalSourceFiles = Object.keys(fileMap).length;
  const untestedCount = tests.untestedSourceFiles.length;
  const testCoverage =
    totalSourceFiles > 0
      ? Math.round(((totalSourceFiles - untestedCount) / totalSourceFiles) * 100)
      : 0;

  const summary: ScanSummary = {
    totalFiles: totalSourceFiles,
    totalLinesOfCode,
    languageBreakdown,
    criticalFiles,
    highRiskFiles,
    testCoverage,
    untestedCriticalFiles,
  };

  return {
    rootDir: absoluteRoot,
    scannedAt: new Date().toISOString(),
    fileMap,
    stack,
    tests,
    ci,
    risks,
    summary,
  };
}

export { analyzeFiles } from './fileAnalyzer.js';
export { detectStack } from './stackDetector.js';
export { detectTests } from './testDetector.js';
export { detectCI } from './ciDetector.js';
export { analyzeRisks } from './riskAnalyzer.js';
