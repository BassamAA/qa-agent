import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import ora from 'ora';
import { runEngine } from '../engine/index.js';
import { buildTerminalSummary, writeDiagnosisReport } from '../reporter/diagnosis.js';
import { applyFix } from './applier.js';
import { verifyBuild } from './verifier.js';
import { displayDiff } from './diffDisplay.js';
import type { Finding, FixResult } from '../engine/results/types.js';

const execAsync = promisify(exec);

// ─── Fix Options ──────────────────────────────────────────────────────────────

export interface FixOptions {
  yes?: boolean;
  dry?: boolean;
  url?: string;
  verbose?: boolean;
  onProgress?: (msg: string) => void;
}

// ─── Main Fixer ───────────────────────────────────────────────────────────────

export async function runFixer(rootDir: string, options: FixOptions = {}): Promise<void> {
  const { yes = false, dry = false, verbose = false } = options;
  const absRoot = path.resolve(rootDir);

  console.log(chalk.bold.cyan('\n  qa-agent fix\n'));

  // ── Step 1: Diagnose ──────────────────────────────────────────────────────
  const scanSpinner = ora({ text: 'Running diagnosis...', prefixText: '  ' }).start();

  let engineResult;
  try {
    engineResult = await runEngine(absRoot, {
      url: options.url,
      onProgress: (phase, detail) => {
        scanSpinner.text = `[${phase}] ${detail ?? ''}`;
      },
    });
  } catch (err) {
    scanSpinner.fail('Diagnosis failed');
    console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  scanSpinner.succeed('Diagnosis complete');

  // Show summary
  console.log('');
  console.log(buildTerminalSummary(engineResult));
  console.log('');

  // Write report
  const reportPath = writeDiagnosisReport(engineResult);
  console.log(chalk.gray(`  Full report: ${reportPath}\n`));

  // ── Step 2: Find auto-fixable issues ──────────────────────────────────────
  const fixable = engineResult.findings.filter((f) => f.autoFixable);

  if (fixable.length === 0) {
    console.log(chalk.green('  No auto-fixable issues found.'));
    console.log(chalk.gray('  Review the report above and fix manually.\n'));
    return;
  }

  console.log(chalk.bold(`  ${fixable.length} auto-fixable issue(s) found:\n`));
  for (const f of fixable) {
    const icon = f.severity === 'critical' ? chalk.red('●') : f.severity === 'high' ? chalk.yellow('●') : chalk.blue('●');
    console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.title}`);
  }
  console.log('');

  if (dry) {
    console.log(chalk.cyan('  --dry mode: showing diffs only, no changes applied.\n'));
    for (const finding of fixable) {
      const result = await applyFix(absRoot, finding);
      if (result?.success) {
        displayDiff({ filePath: result.filePath, oldContent: result.originalContent, newContent: result.newContent });
      }
    }
    return;
  }

  // ── Step 3: Apply fixes ───────────────────────────────────────────────────
  const fixResults: FixResult[] = [];
  let applied = 0;

  for (const finding of fixable) {
    console.log(chalk.bold.white(`\n  → Fixing: ${finding.title}`));
    if (finding.file) console.log(chalk.gray(`    File: ${finding.file}`));

    // Preview the diff
    const previewResult = await applyFix(absRoot, finding);
    if (!previewResult?.success) {
      console.log(chalk.gray(`    Skipped: ${previewResult?.error ?? 'Cannot apply'}`));
      fixResults.push({
        findingId: finding.id,
        applied: false,
        verified: false,
        error: previewResult?.error,
        filesModified: [],
      });
      continue;
    }

    if (verbose) {
      displayDiff({
        filePath: previewResult.filePath,
        oldContent: previewResult.originalContent,
        newContent: previewResult.newContent,
      });
    }

    // Ask for confirmation
    if (!yes) {
      const confirmed = await confirm(`    Apply this fix? [y/N] `);
      if (!confirmed) {
        console.log(chalk.gray('    Skipped.'));
        fixResults.push({ findingId: finding.id, applied: false, verified: false, filesModified: [] });
        continue;
      }
    }

    // Write the fix
    try {
      fs.writeFileSync(previewResult.filePath, previewResult.newContent, 'utf-8');
      console.log(chalk.green(`    ✓ Applied`));
    } catch (err) {
      console.log(chalk.red(`    ✗ Failed to write: ${err instanceof Error ? err.message : String(err)}`));
      fixResults.push({ findingId: finding.id, applied: false, verified: false, error: String(err), filesModified: [] });
      continue;
    }

    // Verify the fix didn't break the build
    const buildSpinner = ora({ text: 'Verifying build...', prefixText: '    ' }).start();
    const buildResult = await verifyBuild(absRoot);

    if (!buildResult.passed) {
      buildSpinner.fail('Build failed — reverting fix');
      // Revert
      fs.writeFileSync(previewResult.filePath, previewResult.originalContent, 'utf-8');
      console.log(chalk.red(`    ✗ Reverted: build failed after applying fix`));
      if (verbose) console.log(chalk.gray(buildResult.error?.slice(0, 500) ?? ''));
      fixResults.push({
        findingId: finding.id,
        applied: false,
        verified: false,
        error: 'Build failed after fix — reverted',
        filesModified: [],
        buildPassed: false,
      });
      continue;
    }

    buildSpinner.succeed(`Build verified (${(buildResult.duration / 1000).toFixed(1)}s)`);

    // Commit the fix
    const commitMsg = buildCommitMessage(finding);
    try {
      await execAsync(`git add -A && git commit -m "${commitMsg}"`, { cwd: absRoot });
      console.log(chalk.gray(`    Committed: ${commitMsg}`));
    } catch {
      console.log(chalk.gray('    (git commit skipped — not a git repo or nothing to commit)'));
    }

    applied++;
    fixResults.push({
      findingId: finding.id,
      applied: true,
      verified: true,
      filesModified: [previewResult.filePath],
      buildPassed: true,
    });
  }

  // ── Step 4: Summary ───────────────────────────────────────────────────────
  const scoreBefore = engineResult.healthScore;
  const fixedFindings = engineResult.findings.filter((f) =>
    fixResults.some((r) => r.findingId === f.id && r.applied)
  );
  const scoreGain = fixedFindings.reduce(
    (sum, f) => sum + ({ critical: 15, high: 8, medium: 3, low: 1 }[f.severity]),
    0
  );
  const scoreAfter = Math.min(100, scoreBefore + scoreGain);

  console.log('');
  console.log(chalk.bold.green(`  ✓ Fixed ${applied} of ${fixable.length} auto-fixable issues`));
  console.log(chalk.bold(`  Health score: ${scoreBefore} → ${scoreAfter}`));
  console.log('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildCommitMessage(finding: Finding): string {
  const category = finding.category;
  const title = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const scope = finding.file
    ? path.basename(finding.file, path.extname(finding.file))
    : category;
  return `fix(${scope}): ${title}`;
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.setEncoding('utf-8');
    stdin.resume();
    stdin.once('data', (data: string) => {
      stdin.pause();
      const answer = data.trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
  });
}
