import * as fs from 'fs';
import * as path from 'path';
import type { TestProfile, TestFile, TestFramework, CoverageReport, FileMap } from '../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /_test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.test\.py$/,
  /test_.*\.py$/,
  /_spec\.rb$/,
  /_test\.rb$/,
  /test_.*\.rb$/,
  /Test\.java$/,
  /Spec\.java$/,
  /_test\.go$/,
  /_test\.rs$/,
];

const TEST_DIR_PATTERNS = [/^tests?$/, /^__tests__$/, /^spec$/, /^e2e$/, /^integration$/];

const TEST_CONFIG_FILES = [
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.cjs',
  'vitest.config.js',
  'vitest.config.ts',
  'vitest.config.mjs',
  'mocha.opts',
  '.mocharc.js',
  '.mocharc.yml',
  '.mocharc.json',
  'karma.conf.js',
  'jasmine.json',
  '.jasmine.json',
  'pytest.ini',
  'setup.cfg',
  'pyproject.toml',
  '.rspec',
  'phpunit.xml',
  'phpunit.xml.dist',
];

const COVERAGE_PATTERNS = [
  { path: 'coverage/lcov.info', format: 'lcov' as const },
  { path: 'coverage/coverage-final.json', format: 'json' as const },
  { path: 'coverage/index.html', format: 'html' as const },
  { path: '.nyc_output/out.json', format: 'json' as const },
  { path: 'htmlcov/index.html', format: 'html' as const },
  { path: 'coverage.xml', format: 'clover' as const },
];

// ─── Framework Detectors ──────────────────────────────────────────────────────

function detectFrameworkFromTestFile(filePath: string, content: string): TestFramework {
  // Check config-based detection first
  if (filePath.includes('vitest.config')) return 'vitest';
  if (filePath.includes('jest.config')) return 'jest';

  // Check content-based detection
  if (/from\s+['"]vitest['"]/.test(content)) return 'vitest';
  if (/from\s+['"]@jest\/globals['"]|jest\./.test(content)) return 'jest';
  if (/require\s*\(\s*['"]mocha['"]\s*\)|describe\s*\(|it\s*\(/.test(content) && !/vitest|jest/.test(content)) return 'mocha';
  if (/import\s+.*\btest\b.*from\s+['"]ava['"]/.test(content)) return 'ava';
  if (/import\s+.*\btest\b.*from\s+['"]node:test['"]/.test(content)) return 'unknown';
  if (/pytest|def test_/.test(content)) return 'pytest';
  if (/RSpec\.describe/.test(content)) return 'rspec';
  if (/class\s+\w+Test.*TestCase/.test(content)) return 'unittest';
  if (/@Test|@BeforeEach|@AfterEach/.test(content)) return 'junit';
  if (/func Test[A-Z].*\*testing\.T/.test(content)) return 'go-test';
  if (/#\[test\]|#\[cfg\(test\)\]/.test(content)) return 'cargo-test';

  return 'unknown';
}

function classifyTestType(filePath: string, content: string): TestFile['type'] {
  const lower = filePath.toLowerCase();
  if (/e2e|end-to-end|playwright|cypress|selenium/.test(lower)) return 'e2e';
  if (/integration|int\.test|int\.spec/.test(lower)) return 'integration';
  if (/unit/.test(lower)) return 'unit';

  // Check content for clues
  if (/supertest|axios|fetch|request\(/.test(content) && /describe|it\(/.test(content)) {
    return 'integration';
  }
  if (/playwright|cypress|puppeteer/.test(content)) return 'e2e';

  return 'unit';
}

function guessSourceFile(testPath: string): string | undefined {
  // Remove test suffix patterns to guess source file
  const patterns = [
    [/\.test\.(ts|tsx|js|jsx)$/, '.$1'],
    [/\.spec\.(ts|tsx|js|jsx)$/, '.$1'],
    [/__tests__\/(.+)\.(ts|tsx|js|jsx)$/, 'src/$1.$2'],
    [/tests\/(.+)\.(ts|tsx|js|jsx)$/, 'src/$1.$2'],
    [/test_(.+)\.py$/, '$1.py'],
    [/(.+)_test\.py$/, '$1.py'],
    [/(.+)_spec\.rb$/, '$1.rb'],
    [/(.+)_test\.go$/, '$1.go'],
  ];

  for (const [pattern, replacement] of patterns) {
    if ((pattern as RegExp).test(testPath)) {
      return testPath.replace(pattern as RegExp, replacement as string);
    }
  }
  return undefined;
}

// ─── File Walker ──────────────────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  const dirParts = filePath.split(path.sep);

  // Check if in a test directory
  for (const part of dirParts) {
    if (TEST_DIR_PATTERNS.some((p) => p.test(part))) return true;
  }

  // Check file name pattern
  return TEST_FILE_PATTERNS.some((p) => p.test(basename));
}

function walkForTests(
  dir: string,
  rootDir: string,
  testFiles: TestFile[],
  configFiles: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output'].includes(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      walkForTests(fullPath, rootDir, testFiles, configFiles);
    } else if (entry.isFile()) {
      // Check for test config files
      if (TEST_CONFIG_FILES.includes(entry.name)) {
        configFiles.push(relativePath);
        continue;
      }

      // Check if it's a test file
      if (isTestFile(relativePath)) {
        let content = '';
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          // ignore
        }

        const framework = detectFrameworkFromTestFile(relativePath, content);
        const type = classifyTestType(relativePath, content);
        const sourceFile = guessSourceFile(relativePath);

        testFiles.push({
          path: relativePath,
          framework,
          type,
          sourceFile,
        });
      }
    }
  }
}

// ─── Coverage Finder ──────────────────────────────────────────────────────────

function findCoverageReports(rootDir: string): CoverageReport[] {
  const reports: CoverageReport[] = [];

  for (const { path: relPath, format } of COVERAGE_PATTERNS) {
    const fullPath = path.join(rootDir, relPath);
    try {
      const stat = fs.statSync(fullPath);
      reports.push({ path: relPath, format, lastModified: stat.mtime });
    } catch {
      // file doesn't exist
    }
  }

  return reports;
}

// ─── Source File Mapper ───────────────────────────────────────────────────────

function findUntestedFiles(testFiles: TestFile[], fileMap: FileMap): string[] {
  const testedSources = new Set<string>();

  for (const tf of testFiles) {
    if (tf.sourceFile) {
      testedSources.add(tf.sourceFile);
      // Also add common variations
      testedSources.add(tf.sourceFile.replace(/^src\//, ''));
    }
    // Add implied source from test path
    const implied = guessSourceFile(tf.path);
    if (implied) testedSources.add(implied);
  }

  const untested: string[] = [];
  for (const filePath of Object.keys(fileMap)) {
    if (isTestFile(filePath)) continue;

    const basename = path.basename(filePath, path.extname(filePath));
    const isLikelyCovered =
      testedSources.has(filePath) ||
      [...testedSources].some(
        (s) => path.basename(s, path.extname(s)).toLowerCase() === basename.toLowerCase()
      );

    if (!isLikelyCovered) {
      untested.push(filePath);
    }
  }

  return untested;
}

// ─── Dominant Framework ───────────────────────────────────────────────────────

function getDominantFramework(testFiles: TestFile[]): TestFramework {
  const counts = new Map<TestFramework, number>();
  for (const tf of testFiles) {
    counts.set(tf.framework, (counts.get(tf.framework) ?? 0) + 1);
  }
  let max = 0;
  let dominant: TestFramework = 'none';
  for (const [fw, count] of counts) {
    if (count > max && fw !== 'unknown') {
      max = count;
      dominant = fw;
    }
  }
  return dominant;
}

// ─── Main Detector ────────────────────────────────────────────────────────────

export function detectTests(rootDir: string, fileMap: FileMap): TestProfile {
  const testFiles: TestFile[] = [];
  const configFiles: string[] = [];

  walkForTests(rootDir, rootDir, testFiles, configFiles);

  const coverageReports = findCoverageReports(rootDir);
  const framework = getDominantFramework(testFiles);
  const untestedSourceFiles = findUntestedFiles(testFiles, fileMap);

  const sourceFileCount = Object.keys(fileMap).filter((p) => !isTestFile(p)).length;
  const testedCount = sourceFileCount - untestedSourceFiles.length;
  const testCoverageEstimate =
    sourceFileCount > 0 ? Math.round((testedCount / sourceFileCount) * 100) : 0;

  return {
    testFiles,
    framework,
    configFiles,
    coverageReports,
    hasE2E: testFiles.some((t) => t.type === 'e2e'),
    hasIntegration: testFiles.some((t) => t.type === 'integration'),
    hasUnit: testFiles.some((t) => t.type === 'unit'),
    totalTests: testFiles.length,
    untestedSourceFiles,
    _testCoverageEstimate: testCoverageEstimate,
  } as TestProfile & { _testCoverageEstimate: number };
}

export { isTestFile };
