import * as fs from 'fs';
import * as path from 'path';
import type { EngineResult, Finding, FindingCategory } from '../engine/results/types.js';

// ─── Health Score Bar ─────────────────────────────────────────────────────────

function healthBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ─── Severity Icon ────────────────────────────────────────────────────────────

function severityIcon(sev: Finding['severity']): string {
  return { critical: '🚨', high: '⚠️', medium: '📋', low: 'ℹ️' }[sev];
}

// ─── Category Label ───────────────────────────────────────────────────────────

function categoryLabel(cat: FindingCategory): string {
  return {
    auth: 'Auth',
    data: 'Data',
    payment: 'Payments',
    api: 'API',
    config: 'Config',
    frontend: 'Frontend',
  }[cat];
}

// ─── Effort Estimate ──────────────────────────────────────────────────────────

function estimatedFix(finding: Finding): string {
  if (finding.autoFixable) return '~2 min (auto-fixable)';
  switch (finding.severity) {
    case 'critical': return '~15–30 min';
    case 'high': return '~10–20 min';
    case 'medium': return '~5–10 min';
    case 'low': return '~5 min';
  }
}

// ─── Projected Score ──────────────────────────────────────────────────────────

function projectedScore(current: number, findings: Finding[]): number {
  const topN = findings.slice(0, 3);
  let gain = 0;
  for (const f of topN) {
    gain += { critical: 15, high: 8, medium: 3, low: 1 }[f.severity];
  }
  return Math.min(100, current + gain);
}

// ─── Finding Block ────────────────────────────────────────────────────────────

function renderFinding(finding: Finding, index: number): string {
  const lines: string[] = [];
  lines.push(`### ${index}. ${finding.title}`);
  lines.push('');
  lines.push(finding.description);
  lines.push('');
  if (finding.file) {
    const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`📍 **File:** \`${loc}\``);
  }
  lines.push(`💥 **Impact:** ${finding.impact}`);
  lines.push('');
  lines.push(`🔧 **Fix:** ${finding.fix}`);

  if (finding.fixCode) {
    lines.push('');
    lines.push('```typescript');
    lines.push(finding.fixCode);
    lines.push('```');
  }

  if (finding.autoFixable) {
    lines.push('');
    lines.push('> ✨ **Auto-fixable** — run `npx qa-agent fix .` to apply this fix automatically');
  }

  lines.push('');
  lines.push(`<details><summary>Evidence</summary>\n\n\`\`\`\n${finding.evidence}\n\`\`\`\n\n</details>`);
  lines.push('');
  lines.push('---');
  return lines.join('\n');
}

// ─── Coverage Table ───────────────────────────────────────────────────────────

function renderCoverageTable(result: EngineResult): string {
  const categories: FindingCategory[] = ['auth', 'data', 'payment', 'api', 'config', 'frontend'];

  const rows = categories.map((cat) => {
    const summary = result.categorySummaries[cat];
    const label = categoryLabel(cat);

    if (summary.checksRun === 0) {
      return `| ${label.padEnd(12)} | —         | —      | —      | — (not detected) |`;
    }

    const passed = summary.passed.toString().padStart(6);
    const failed = summary.failed.toString().padStart(6);
    const skipped = summary.skipped.toString().padStart(7);
    const checksRun = summary.checksRun.toString().padStart(10);

    return `| ${label.padEnd(12)} | ${checksRun} | ${passed} | ${failed} | ${skipped} |`;
  });

  return [
    '| Category      | Checks Run | Passed | Failed | Skipped |',
    '|---------------|-----------|--------|--------|---------|',
    ...rows,
  ].join('\n');
}

// ─── Next Steps ───────────────────────────────────────────────────────────────

function renderNextSteps(result: EngineResult): string {
  const topFindings = result.findings.slice(0, 5);
  if (topFindings.length === 0) return '_No action needed — all checks passed!_';

  const lines = topFindings.map((f, i) => {
    const effort = estimatedFix(f);
    const autoTag = f.autoFixable ? ' _(auto-fixable)_' : '';
    return `${i + 1}. **${f.title}**${autoTag}  \n   ${effort}`;
  });

  const current = result.healthScore;
  const projected = projectedScore(current, topFindings);
  lines.push('');
  lines.push(`> Fixing the top ${Math.min(3, topFindings.length)} issues would bring your health score from **${current}** → **${projected}**.`);

  const autoFixCount = result.findings.filter((f) => f.autoFixable).length;
  if (autoFixCount > 0) {
    lines.push('');
    lines.push(`> Run \`npx qa-agent fix .\` to automatically fix ${autoFixCount} of ${result.findings.length} issues.`);
  }

  return lines.join('\n');
}

// ─── Passing Items ────────────────────────────────────────────────────────────

function renderPassingItems(result: EngineResult): string {
  const passing: string[] = [];

  for (const cr of result.checkResults) {
    if (cr.status === 'passed') {
      const label = cr.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      passing.push(`- ${label} ✓`);
    }
  }

  if (passing.length === 0) return '_No checks passed — review findings above._';
  return passing.join('\n');
}

// ─── Main Report Builder ──────────────────────────────────────────────────────

export function buildDiagnosisReport(result: EngineResult): string {
  const duration = (result.durationMs / 1000).toFixed(1);
  const totalFindings = result.findings.length;
  const date = new Date(result.completedAt).toLocaleString();

  const critical = result.findings.filter((f) => f.severity === 'critical');
  const high = result.findings.filter((f) => f.severity === 'high');
  const medium = result.findings.filter((f) => f.severity === 'medium');
  const low = result.findings.filter((f) => f.severity === 'low');

  const sections: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  sections.push(`# 🔍 QA Diagnosis — ${result.appName}`);
  sections.push('');
  sections.push(`**Run:** ${date} | **Duration:** ${duration}s | **Findings:** ${totalFindings}`);
  if (!result.appStarted && result.appStartError) {
    sections.push('');
    sections.push(`> ⚠️ **App could not be started:** ${result.appStartError}  `);
    sections.push('> Some dynamic checks were skipped. Static analysis findings are still included.');
  }
  sections.push('');

  // ── Health Score ──────────────────────────────────────────────────────────
  sections.push('---');
  sections.push('');
  sections.push('## Health Score');
  sections.push('');
  sections.push(`\`${healthBar(result.healthScore)}\` **${result.healthScore}/100**`);
  sections.push('');
  if (result.healthScore >= 90) {
    sections.push('> Excellent — your app is in great shape.');
  } else if (result.healthScore >= 70) {
    sections.push('> Good — a few things to address.');
  } else if (result.healthScore >= 50) {
    sections.push('> Needs work — several important issues to fix.');
  } else {
    sections.push('> Critical — significant security and quality issues require immediate attention.');
  }
  sections.push('');

  // ── Finding Counts ────────────────────────────────────────────────────────
  if (totalFindings > 0) {
    sections.push('| Severity | Count |');
    sections.push('|----------|-------|');
    if (critical.length) sections.push(`| 🚨 Critical | ${critical.length} |`);
    if (high.length)     sections.push(`| ⚠️ High     | ${high.length} |`);
    if (medium.length)   sections.push(`| 📋 Medium   | ${medium.length} |`);
    if (low.length)      sections.push(`| ℹ️ Low      | ${low.length} |`);
    sections.push('');
  }

  // ── Critical Issues ───────────────────────────────────────────────────────
  if (critical.length > 0) {
    sections.push('---');
    sections.push('');
    sections.push('## 🚨 Critical Issues (Fix These Now)');
    sections.push('');
    sections.push('> These issues can cause data loss, unauthorized access, or financial fraud. Fix immediately.');
    sections.push('');
    critical.forEach((f, i) => sections.push(renderFinding(f, i + 1)));
  }

  // ── High Issues ───────────────────────────────────────────────────────────
  if (high.length > 0) {
    sections.push('---');
    sections.push('');
    sections.push('## ⚠️ High Priority Issues');
    sections.push('');
    high.forEach((f, i) => sections.push(renderFinding(f, i + 1)));
  }

  // ── Medium Issues ─────────────────────────────────────────────────────────
  if (medium.length > 0) {
    sections.push('---');
    sections.push('');
    sections.push('## 📋 Medium Issues');
    sections.push('');
    medium.forEach((f, i) => sections.push(renderFinding(f, i + 1)));
  }

  // ── Low / Suggestions ─────────────────────────────────────────────────────
  if (low.length > 0) {
    sections.push('---');
    sections.push('');
    sections.push('## ℹ️ Low Priority / Suggestions');
    sections.push('');
    for (const f of low) {
      sections.push(`- ${severityIcon(f.severity)} **${f.title}**${f.file ? ` _(${f.file})_` : ''}`);
    }
    sections.push('');
  }

  // ── What's Good ───────────────────────────────────────────────────────────
  sections.push('---');
  sections.push('');
  sections.push('## ✅ What\'s Good');
  sections.push('');
  sections.push(renderPassingItems(result));
  sections.push('');

  // ── Coverage Table ────────────────────────────────────────────────────────
  sections.push('---');
  sections.push('');
  sections.push('## 📊 Coverage Summary');
  sections.push('');
  sections.push(renderCoverageTable(result));
  sections.push('');

  // ── Next Steps ────────────────────────────────────────────────────────────
  sections.push('---');
  sections.push('');
  sections.push('## 🗺️ Next Steps');
  sections.push('');
  sections.push(renderNextSteps(result));
  sections.push('');

  // ── Footer ────────────────────────────────────────────────────────────────
  sections.push('---');
  sections.push('');
  sections.push('_Generated by [qa-agent](https://github.com/your/qa-agent)_');
  sections.push('');

  return sections.join('\n');
}

// ─── Write Report to Disk ─────────────────────────────────────────────────────

export function writeDiagnosisReport(result: EngineResult, outputPath?: string): string {
  const report = buildDiagnosisReport(result);
  const outPath = outputPath ?? path.join(result.rootDir, 'qa-diagnosis.md');
  fs.writeFileSync(outPath, report, 'utf-8');
  return outPath;
}

export function buildTerminalSummary(result: EngineResult): string {
  const critical = result.findings.filter((f) => f.severity === 'critical').length;
  const high = result.findings.filter((f) => f.severity === 'high').length;
  const autoFixable = result.findings.filter((f) => f.autoFixable).length;

  const lines: string[] = [
    `Health Score: ${healthBar(result.healthScore, 20)} ${result.healthScore}/100`,
    '',
    `  🚨 Critical: ${critical}  ⚠️  High: ${high}  📋 Medium+Low: ${result.findings.length - critical - high}`,
    `  ✨ Auto-fixable: ${autoFixable} of ${result.findings.length}`,
  ];

  if (result.findings.length > 0) {
    lines.push('');
    lines.push('  Top issues:');
    result.findings.slice(0, 3).forEach((f) => {
      lines.push(`  • [${f.severity.toUpperCase()}] ${f.title}`);
    });
  }

  return lines.join('\n');
}
