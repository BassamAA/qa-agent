import * as fs from 'fs';
import * as path from 'path';
import type { FileInfo, FileMap, Language } from '../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.next-e2e',       // playwright/e2e Next.js output
  '.nuxt',
  '__pycache__',
  '.pytest_cache',
  'vendor',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.cache',
  '.claude',         // Claude Code local config — never application code
  '.cursor',         // Cursor editor config
  'out',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'venv',
  '.venv',
  'env',
  '.env',
  'eggs',
  '.eggs',
]);

const IGNORE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.gitattributes',
  '.eslintignore',
  '.prettierignore',
]);

const LANGUAGE_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
};

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB

// ─── Import Extractors ────────────────────────────────────────────────────────

function extractTSJSImports(content: string): string[] {
  const imports = new Set<string>();

  // ES module imports: import ... from '...'
  const esImportRe = /import\s+(?:(?:\w+|\{[^}]*\}|\*\s+as\s+\w+)\s*,?\s*)*\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = esImportRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // Dynamic imports: import('...')
  const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynImportRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // CommonJS require: require('...')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  return [...imports];
}

function extractPythonImports(content: string): string[] {
  const imports = new Set<string>();

  // import X, import X as Y
  const importRe = /^import\s+([\w.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    imports.add(m[1].split('.')[0]);
  }

  // from X import Y
  const fromRe = /^from\s+([\w.]+)\s+import/gm;
  while ((m = fromRe.exec(content)) !== null) {
    imports.add(m[1].split('.')[0]);
  }

  return [...imports];
}

function extractRubyImports(content: string): string[] {
  const imports = new Set<string>();
  const requireRe = /require\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(content)) !== null) {
    imports.add(m[1]);
  }
  return [...imports];
}

function extractGoImports(content: string): string[] {
  const imports = new Set<string>();

  // Single import
  const singleRe = /^import\s+"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(content)) !== null) {
    imports.add(m[1]);
  }

  // Import block
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  while ((m = blockRe.exec(content)) !== null) {
    const lineRe = /"([^"]+)"/g;
    let inner: RegExpExecArray | null;
    while ((inner = lineRe.exec(m[1])) !== null) {
      imports.add(inner[1]);
    }
  }

  return [...imports];
}

function extractJavaImports(content: string): string[] {
  const imports = new Set<string>();
  const importRe = /^import\s+(?:static\s+)?([\w.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    imports.add(m[1]);
  }
  return [...imports];
}

function extractRustImports(content: string): string[] {
  const imports = new Set<string>();
  const useRe = /^use\s+([\w:]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    imports.add(m[1].split('::')[0]);
  }
  return [...imports];
}

function extractImports(content: string, language: Language): string[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTSJSImports(content);
    case 'python':
      return extractPythonImports(content);
    case 'ruby':
      return extractRubyImports(content);
    case 'go':
      return extractGoImports(content);
    case 'java':
    case 'kotlin':
      return extractJavaImports(content);
    case 'rust':
      return extractRustImports(content);
    default:
      return [];
  }
}

// ─── Export Extractors ────────────────────────────────────────────────────────

function extractTSJSExports(content: string): string[] {
  const exports = new Set<string>();

  // export function/class/const/let/var/type/interface/enum
  const namedRe =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(content)) !== null) {
    exports.add(m[1]);
  }

  // export { foo, bar }
  const braceRe = /export\s*\{([^}]+)\}/g;
  while ((m = braceRe.exec(content)) !== null) {
    const items = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    for (const item of items) {
      if (item) exports.add(item);
    }
  }

  return [...exports];
}

function extractExports(content: string, language: Language): string[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTSJSExports(content);
    default:
      return [];
  }
}

// ─── Main Analyzer ────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  maxDepth?: number;
  additionalIgnore?: string[];
  onProgress?: (filesScanned: number) => void;
}

export function analyzeFiles(rootDir: string, options: AnalyzeOptions = {}): FileMap {
  const fileMap: FileMap = {};
  const ignoreSet = new Set([...IGNORE_DIRS, ...(options.additionalIgnore ?? [])]);
  let filesScanned = 0;

  const maxDepth = options.maxDepth ?? 20;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (ignoreSet.has(entry.name) || IGNORE_FILES.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const language = LANGUAGE_MAP[ext];
        if (!language) continue;

        let size = 0;
        let content = '';
        try {
          const stat = fs.statSync(fullPath);
          size = stat.size;
          if (size < MAX_FILE_SIZE_BYTES) {
            content = fs.readFileSync(fullPath, 'utf-8');
          }
        } catch {
          continue;
        }

        const lineCount = content ? content.split('\n').length : 0;
        const imports = content ? extractImports(content, language) : [];
        const exports = content ? extractExports(content, language) : [];

        fileMap[relativePath] = {
          path: relativePath,
          absolutePath: fullPath,
          size,
          lineCount,
          language,
          imports,
          exports,
        } satisfies FileInfo;

        filesScanned++;
        if (options.onProgress && filesScanned % 50 === 0) {
          options.onProgress(filesScanned);
        }
      }
    }
  }

  walk(rootDir, 0);
  return fileMap;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getLanguageBreakdown(fileMap: FileMap): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const file of Object.values(fileMap)) {
    breakdown[file.language] = (breakdown[file.language] ?? 0) + 1;
  }
  return breakdown;
}

export function getTotalLines(fileMap: FileMap): number {
  return Object.values(fileMap).reduce((sum, f) => sum + f.lineCount, 0);
}

export function getPrimaryLanguage(fileMap: FileMap): Language {
  const breakdown = getLanguageBreakdown(fileMap);
  let maxCount = 0;
  let primary: Language = 'unknown';
  for (const [lang, count] of Object.entries(breakdown)) {
    if (count > maxCount) {
      maxCount = count;
      primary = lang as Language;
    }
  }
  return primary;
}
