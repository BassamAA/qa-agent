#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { scan } from '../scanner/index.js';
import { Brain } from '../brain/index.js';
import { runEngine } from '../engine/index.js';
import { writeDiagnosisReport, buildTerminalSummary } from '../reporter/diagnosis.js';
import { runFixer } from '../fixer/index.js';

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('qa-agent')
  .description('Intelligent QA agent — scans codebases, finds bugs, fixes them')
  .version('1.0.0');

// ─── run command ──────────────────────────────────────────────────────────────

program
  .command('run [dir]')
  .description('Scan + diagnose a project (default: current directory)')
  .option('-u, --url <url>', 'Connect to a running app instead of starting one')
  .option('-j, --json', 'Output results as JSON')
  .option('-o, --output <path>', 'Write report to a specific file path')
  .option('-v, --verbose', 'Show detailed output')
  .option('--provider <provider>', 'LLM provider: claude | openai', 'claude')
  .option('--model <model>', 'LLM model override')
  .option('--skip <categories>', 'Skip check categories (comma-separated: auth,data,payment,api,config,frontend)')
  .action(async (dir: string | undefined, opts: {
    url?: string;
    json?: boolean;
    output?: string;
    verbose?: boolean;
    provider?: string;
    model?: string;
    skip?: string;
  }) => {
    const rootDir = path.resolve(dir ?? '.');

    if (!fs.existsSync(rootDir)) {
      console.error(chalk.red(`  Error: Directory not found: ${rootDir}`));
      process.exit(1);
    }

    if (!opts.json) {
      printBanner();
      console.log(chalk.gray(`  Scanning: ${rootDir}\n`));
    }

    const skipCategories = opts.skip
      ? opts.skip.split(',').map((s) => s.trim()) as Array<'auth' | 'data' | 'payment' | 'api' | 'config' | 'frontend'>
      : [];

    const spinner = opts.json ? null : ora({ text: 'Starting engine...', prefixText: '  ' }).start();

    let result;
    try {
      result = await runEngine(rootDir, {
        url: opts.url,
        skipCategories,
        onProgress: (phase, detail) => {
          if (spinner) spinner.text = `[${phase}] ${detail ?? ''}`;
        },
      });
    } catch (err) {
      spinner?.fail('Engine failed');
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    spinner?.succeed('Scan complete');

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Print terminal summary
    console.log('');
    console.log(buildTerminalSummary(result));
    console.log('');

    // Write report
    const reportPath = writeDiagnosisReport(result, opts.output);
    console.log(chalk.cyan(`  Report written to: ${reportPath}`));

    if (result.findings.filter((f) => f.autoFixable).length > 0) {
      console.log(chalk.gray(`  Run ${chalk.white('npx qa-agent fix .')} to auto-fix ${result.findings.filter((f) => f.autoFixable).length} issues\n`));
    }

    process.exit(result.findings.some((f) => f.severity === 'critical') ? 1 : 0);
  });

// ─── scan command ─────────────────────────────────────────────────────────────

program
  .command('scan [dir]')
  .description('Static scan only — no app startup, no LLM, fast analysis')
  .option('-j, --json', 'Output results as JSON')
  .option('-v, --verbose', 'Show detailed output')
  .option('-o, --output <path>', 'Write output to file')
  .action(async (dir: string | undefined, opts: {
    json?: boolean;
    verbose?: boolean;
    output?: string;
  }) => {
    const rootDir = path.resolve(dir ?? '.');

    if (!opts.json) {
      printBanner();
      console.log(chalk.gray(`  Scanning: ${rootDir}\n`));
    }

    const spinner = opts.json ? null : ora({ text: 'Scanning files...', prefixText: '  ' }).start();

    let result;
    try {
      result = await scan(rootDir, {
        onProgress: (stage, detail) => {
          if (spinner) spinner.text = `[${stage}] ${detail ?? ''}`;
        },
      });
    } catch (err) {
      spinner?.fail('Scan failed');
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    spinner?.succeed('Scan complete');

    if (opts.json) {
      const output = JSON.stringify(result, null, 2);
      if (opts.output) {
        fs.writeFileSync(opts.output, output, 'utf-8');
      } else {
        console.log(output);
      }
      return;
    }

    // Pretty output
    const { summary, stack, tests, ci, risks } = result;
    console.log('');
    console.log(chalk.bold('  Stack'));
    console.log(`    Language:   ${chalk.cyan(stack.primaryLanguage)}`);
    console.log(`    Framework:  ${chalk.cyan(stack.framework)}`);
    console.log(`    ORM:        ${chalk.cyan(stack.orm)}`);
    console.log(`    Auth:       ${chalk.cyan(stack.authLibrary)}`);
    console.log(`    Payment:    ${chalk.cyan(stack.paymentLibrary)}`);
    console.log(`    Test fw:    ${chalk.cyan(stack.testFramework)}`);
    console.log('');
    console.log(chalk.bold('  Files'));
    console.log(`    Total:      ${chalk.white(summary.totalFiles)}`);
    console.log(`    LOC:        ${chalk.white(summary.totalLinesOfCode.toLocaleString())}`);
    console.log(`    Languages:  ${Object.entries(summary.languageBreakdown).map(([l, n]) => `${l}:${n}`).join(', ')}`);
    console.log('');
    console.log(chalk.bold('  Tests'));
    console.log(`    Framework:  ${chalk.white(tests.framework)}`);
    console.log(`    Files:      ${chalk.white(tests.totalTests)}`);
    console.log(`    Coverage:   ${chalk.white(summary.testCoverage + '%')}`);
    console.log(`    Untested:   ${chalk.yellow(tests.untestedSourceFiles.length + ' files')}`);
    console.log('');
    console.log(chalk.bold('  CI'));
    console.log(`    Platform:   ${chalk.white(ci.platform)}`);
    console.log(`    Has tests:  ${ci.hasTestAutomation ? chalk.green('yes') : chalk.red('no')}`);
    console.log('');
    console.log(chalk.bold('  Risk (top 10)'));
    for (const r of risks.slice(0, 10)) {
      const color = r.recommendation === 'critical' ? chalk.red
        : r.recommendation === 'high' ? chalk.yellow
        : r.recommendation === 'medium' ? chalk.blue
        : chalk.gray;
      console.log(`    ${color(`[${r.recommendation.toUpperCase()}]`)} ${r.path} (${r.score})`);
    }

    if (opts.verbose) {
      console.log('');
      console.log(chalk.bold('  Untested critical files:'));
      for (const f of summary.untestedCriticalFiles.slice(0, 10)) {
        console.log(chalk.red(`    • ${f}`));
      }
    }
    console.log('');
  });

// ─── generate command ─────────────────────────────────────────────────────────

program
  .command('generate [dir]')
  .description('Generate test strategy using AI (scan + brain)')
  .option('--provider <provider>', 'LLM provider: claude | openai', 'claude')
  .option('--model <model>', 'LLM model override')
  .option('-j, --json', 'Output strategy as JSON')
  .option('-o, --output <path>', 'Write strategy to file')
  .option('--goal <text>', 'Describe what you want to test')
  .action(async (dir: string | undefined, opts: {
    provider?: string;
    model?: string;
    json?: boolean;
    output?: string;
    goal?: string;
  }) => {
    const rootDir = path.resolve(dir ?? '.');

    if (!opts.json) {
      printBanner();
      console.log(chalk.gray(`  Analyzing: ${rootDir}\n`));
    }

    const spinner = opts.json ? null : ora({ text: 'Scanning codebase...', prefixText: '  ' }).start();

    // Scan
    let scanResult;
    try {
      scanResult = await scan(rootDir, {
        onProgress: (stage, detail) => {
          if (spinner) spinner.text = `[${stage}] ${detail ?? ''}`;
        },
      });
    } catch (err) {
      spinner?.fail('Scan failed');
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    if (spinner) spinner.text = 'Analyzing with AI...';

    // Brain
    let brainResult;
    try {
      const brain = new Brain({ provider: opts.provider as 'claude' | 'openai', model: opts.model });
      brainResult = await brain.analyze(scanResult, {
        userGoal: opts.goal,
        provider: opts.provider as 'claude' | 'openai',
        model: opts.model,
      });
    } catch (err) {
      spinner?.fail('AI analysis failed');
      console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    spinner?.succeed('Strategy generated');

    if (opts.json) {
      const output = JSON.stringify(brainResult.strategy, null, 2);
      if (opts.output) {
        fs.writeFileSync(opts.output, output, 'utf-8');
        console.log(chalk.green(`\n  Strategy written to ${opts.output}`));
      } else {
        console.log(output);
      }
      return;
    }

    const { strategy } = brainResult;
    console.log('');
    console.log(chalk.bold('  Test Strategy'));
    console.log(`    Framework:  ${chalk.cyan(strategy.recommendedFramework)}`);
    if (strategy.e2eFramework && strategy.e2eFramework !== 'none') {
      console.log(`    E2E:        ${chalk.cyan(strategy.e2eFramework)}`);
    }
    console.log(`    Coverage:   ${chalk.white(strategy.coverageTarget + '%')} target`);
    console.log(`    Effort:     ${chalk.white(strategy.estimatedEffort)}`);
    console.log('');
    console.log(chalk.bold('  Strategy'));
    console.log(`    ${chalk.white(strategy.strategy)}`);
    console.log('');
    console.log(chalk.bold(`  Top ${Math.min(strategy.fileRecommendations.length, 5)} Files to Test`));
    for (const rec of strategy.fileRecommendations.slice(0, 5)) {
      const sev = rec.priority === 'critical' ? chalk.red : rec.priority === 'high' ? chalk.yellow : chalk.gray;
      console.log(`    ${sev(`[${rec.priority}]`)} ${rec.sourceFile}`);
      console.log(chalk.gray(`           → ${rec.testFile}`));
    }
    console.log('');
    console.log(chalk.bold('  Setup Steps'));
    strategy.setupSteps.forEach((step, i) => {
      console.log(`    ${i + 1}. ${step}`);
    });
    console.log('');
    console.log(chalk.gray(`  Model: ${brainResult.model} | Tokens: ${brainResult.inputTokens}in / ${brainResult.outputTokens}out`));

    if (opts.output) {
      fs.writeFileSync(opts.output, JSON.stringify(strategy, null, 2), 'utf-8');
      console.log(chalk.cyan(`\n  Written to: ${opts.output}`));
    }
    console.log('');
  });

// ─── fix command ──────────────────────────────────────────────────────────────

program
  .command('fix [dir]')
  .description('Diagnose and auto-fix issues')
  .option('-u, --url <url>', 'Connect to a running app')
  .option('-y, --yes', 'Apply all fixes without prompting')
  .option('--dry', 'Show what would be fixed without applying')
  .option('-v, --verbose', 'Show diffs for all fixes')
  .action(async (dir: string | undefined, opts: {
    url?: string;
    yes?: boolean;
    dry?: boolean;
    verbose?: boolean;
  }) => {
    const rootDir = path.resolve(dir ?? '.');

    if (!fs.existsSync(rootDir)) {
      console.error(chalk.red(`  Error: Directory not found: ${rootDir}`));
      process.exit(1);
    }

    await runFixer(rootDir, {
      url: opts.url,
      yes: opts.yes,
      dry: opts.dry,
      verbose: opts.verbose,
    });
  });

// ─── report command ───────────────────────────────────────────────────────────

program
  .command('report [dir]')
  .description('Generate a diagnosis report from a previous scan result')
  .option('-i, --input <path>', 'Input JSON file (from qa-agent run --json)')
  .option('-o, --output <path>', 'Output report path (default: qa-diagnosis.md)')
  .option('-f, --format <format>', 'Output format: markdown | json', 'markdown')
  .action(async (dir: string | undefined, opts: {
    input?: string;
    output?: string;
    format?: string;
  }) => {
    const rootDir = path.resolve(dir ?? '.');

    let engineResult;
    if (opts.input) {
      try {
        engineResult = JSON.parse(fs.readFileSync(opts.input, 'utf-8'));
      } catch {
        console.error(chalk.red(`  Error reading input: ${opts.input}`));
        process.exit(1);
      }
    } else {
      // Run a fresh scan
      printBanner();
      const spinner = ora({ text: 'Running diagnosis...', prefixText: '  ' }).start();
      try {
        engineResult = await runEngine(rootDir, {
          onProgress: (phase, detail) => { spinner.text = `[${phase}] ${detail ?? ''}`; },
        });
        spinner.succeed('Diagnosis complete');
      } catch (err) {
        spinner.fail('Failed');
        console.error(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    }

    const outPath = writeDiagnosisReport(engineResult, opts.output);
    console.log(chalk.green(`\n  Report written to: ${outPath}\n`));
  });

// ─── watch command ────────────────────────────────────────────────────────────

program
  .command('watch [dir]')
  .description('Watch for file changes and re-run affected checks')
  .option('-u, --url <url>', 'App URL to check against')
  .action(async (dir: string | undefined, opts: { url?: string }) => {
    const rootDir = path.resolve(dir ?? '.');
    printBanner();
    console.log(chalk.gray(`  Watching: ${rootDir}\n`));
    console.log(chalk.gray('  Waiting for file changes... (Ctrl+C to stop)\n'));

    // Dynamic import to avoid requiring chokidar as a hard dependency
    let chokidar: typeof import('chokidar');
    try {
      chokidar = await import('chokidar');
    } catch {
      console.error(chalk.red('  chokidar not installed. Run: npm install chokidar'));
      process.exit(1);
    }

    const watcher = chokidar.watch(rootDir, {
      ignored: [/node_modules/, /\.git/, /\.next/, /dist/, /build/, /coverage/],
      persistent: true,
      ignoreInitial: true,
    });

    let debounceTimer: NodeJS.Timeout | null = null;
    let lastChanged = '';

    watcher.on('change', (changedPath: string) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      lastChanged = changedPath;

      debounceTimer = setTimeout(async () => {
        const rel = path.relative(rootDir, lastChanged);
        process.stdout.write(chalk.gray(`\n  Saved: ${rel} — re-checking...\n`));

        try {
          // Run config checks (fast, no app startup needed)
          const { runConfigChecks } = await import('../engine/checks/config.js');
          const { buildAppContext } = await import('../engine/runner.js');
          const { ctx } = await buildAppContext(rootDir, { url: opts.url });

          const configResults = await runConfigChecks(ctx);
          const findings = configResults.flatMap((r) => r.findings);

          if (findings.length === 0) {
            console.log(chalk.green('  ✓ No issues detected\n'));
          } else {
            for (const f of findings) {
              const icon = f.severity === 'critical' ? chalk.red('✗') : chalk.yellow('!');
              console.log(`  ${icon} [${f.severity.toUpperCase()}] ${f.title}\n`);
            }
          }
        } catch (err) {
          console.log(chalk.gray(`  Check error: ${err instanceof Error ? err.message : String(err)}\n`));
        }
      }, 500);
    });
  });

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╔═══════════════════════╗'));
  console.log(chalk.bold.cyan('  ║  ') + chalk.bold.white('qa-agent') + chalk.bold.cyan(' v1.0.0     ║'));
  console.log(chalk.bold.cyan('  ╚═══════════════════════╝'));
  console.log('');
}

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);

// Default to 'run' if no command given
if (process.argv.length <= 2) {
  program.help();
}
