import chalk from 'chalk';

// ─── Diff Display ─────────────────────────────────────────────────────────────

export interface FileDiff {
  filePath: string;
  oldContent: string;
  newContent: string;
}

export function displayDiff(diff: FileDiff): void {
  const oldLines = diff.oldContent.split('\n');
  const newLines = diff.newContent.split('\n');

  console.log(chalk.bold.cyan(`\n  📄 ${diff.filePath}`));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  // Simple Myers-like diff: find changed regions
  const hunks = computeHunks(oldLines, newLines);

  if (hunks.length === 0) {
    console.log(chalk.gray('  (no changes)'));
    return;
  }

  for (const hunk of hunks) {
    console.log(chalk.gray(`  @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green('  ' + line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red('  ' + line));
      } else {
        console.log(chalk.gray('  ' + line));
      }
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(60)));
}

// ─── Hunk Builder ─────────────────────────────────────────────────────────────

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const CONTEXT = 3;
  const hunks: Hunk[] = [];

  // Build a simple LCS-based diff
  const changes = lcs(oldLines, newLines);

  let i = 0;
  while (i < changes.length) {
    if (changes[i]?.type === 'same') { i++; continue; }

    // Found a change — expand context
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    while (end < changes.length && changes[end]?.type !== 'same') end++;
    end = Math.min(changes.length, end + CONTEXT);

    const hunkChanges = changes.slice(start, end);
    const lines: string[] = [];
    let oldStart = -1, newStart = -1, oldCount = 0, newCount = 0;

    for (const change of hunkChanges) {
      if (oldStart === -1) oldStart = change.oldIdx + 1;
      if (newStart === -1) newStart = change.newIdx + 1;

      if (change.type === 'same') {
        lines.push(` ${change.text}`);
        oldCount++;
        newCount++;
      } else if (change.type === 'add') {
        lines.push(`+${change.text}`);
        newCount++;
      } else {
        lines.push(`-${change.text}`);
        oldCount++;
      }
    }

    hunks.push({ oldStart: oldStart ?? 1, oldCount, newStart: newStart ?? 1, newCount, lines });
    i = end;
  }

  return hunks;
}

interface DiffEntry {
  type: 'same' | 'add' | 'remove';
  text: string;
  oldIdx: number;
  newIdx: number;
}

function lcs(a: string[], b: string[]): DiffEntry[] {
  // Simplified diff using patience algorithm heuristic
  const result: DiffEntry[] = [];
  let ai = 0, bi = 0;

  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) {
      result.push({ type: 'same', text: a[ai] ?? '', oldIdx: ai, newIdx: bi });
      ai++; bi++;
    } else {
      // Look ahead up to 5 lines
      let foundOld = -1, foundNew = -1;
      for (let k = 1; k <= 5; k++) {
        if (bi + k < b.length && a[ai] === b[bi + k]) { foundNew = k; break; }
      }
      for (let k = 1; k <= 5; k++) {
        if (ai + k < a.length && a[ai + k] === b[bi]) { foundOld = k; break; }
      }

      if (foundNew !== -1 && (foundOld === -1 || foundNew <= foundOld)) {
        for (let k = 0; k < foundNew; k++) {
          result.push({ type: 'add', text: b[bi + k] ?? '', oldIdx: ai, newIdx: bi + k });
        }
        bi += foundNew;
      } else if (foundOld !== -1) {
        for (let k = 0; k < foundOld; k++) {
          result.push({ type: 'remove', text: a[ai + k] ?? '', oldIdx: ai + k, newIdx: bi });
        }
        ai += foundOld;
      } else {
        result.push({ type: 'remove', text: a[ai] ?? '', oldIdx: ai, newIdx: bi });
        result.push({ type: 'add', text: b[bi] ?? '', oldIdx: ai, newIdx: bi });
        ai++; bi++;
      }
    }
  }

  while (ai < a.length) {
    result.push({ type: 'remove', text: a[ai] ?? '', oldIdx: ai, newIdx: bi });
    ai++;
  }
  while (bi < b.length) {
    result.push({ type: 'add', text: b[bi] ?? '', oldIdx: ai, newIdx: bi });
    bi++;
  }

  return result;
}
