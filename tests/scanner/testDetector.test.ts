import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { detectTests, isTestFile } from '../../src/scanner/testDetector.js';
import { analyzeFiles } from '../../src/scanner/fileAnalyzer.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-nextjs');

describe('isTestFile', () => {
  it('recognizes .test.ts files', () => {
    expect(isTestFile('src/auth.test.ts')).toBe(true);
  });

  it('recognizes .spec.ts files', () => {
    expect(isTestFile('src/auth.spec.ts')).toBe(true);
  });

  it('recognizes files in __tests__ dir', () => {
    expect(isTestFile('__tests__/auth.ts')).toBe(true);
  });

  it('recognizes pytest files', () => {
    expect(isTestFile('test_auth.py')).toBe(true);
  });

  it('recognizes _test.go files', () => {
    expect(isTestFile('auth_test.go')).toBe(true);
  });

  it('does NOT flag regular source files', () => {
    expect(isTestFile('src/auth.ts')).toBe(false);
    expect(isTestFile('app/page.tsx')).toBe(false);
  });
});

describe('detectTests', () => {
  it('returns a TestProfile object', () => {
    const fileMap = analyzeFiles(FIXTURE);
    const profile = detectTests(FIXTURE, fileMap);
    expect(profile).toBeDefined();
    expect(Array.isArray(profile.testFiles)).toBe(true);
    expect(Array.isArray(profile.untestedSourceFiles)).toBe(true);
  });

  it('identifies untested source files', () => {
    const fileMap = analyzeFiles(FIXTURE);
    const profile = detectTests(FIXTURE, fileMap);
    // auth.ts and payments.ts have no test files → should be untested
    const hasAuthUntested = profile.untestedSourceFiles.some((f) => f.includes('auth'));
    expect(hasAuthUntested).toBe(true);
  });

  it('detects test framework from config', () => {
    // Create a temp dir with a vitest.config.ts
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-test-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vitest.config.ts'), 'export default {}');
    fs.writeFileSync(path.join(tmp, 'src', 'app.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmp, 'src', 'app.test.ts'), "import { describe } from 'vitest'");

    const fileMap = analyzeFiles(tmp);
    const profile = detectTests(tmp, fileMap);

    expect(profile.configFiles.some((c) => c.includes('vitest.config'))).toBe(true);

    // Cleanup
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects E2E tests', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-e2e-'));
    fs.mkdirSync(path.join(tmp, 'e2e'));
    fs.writeFileSync(path.join(tmp, 'e2e', 'login.spec.ts'), "import { test } from '@playwright/test'");

    const fileMap = analyzeFiles(tmp);
    const profile = detectTests(tmp, fileMap);
    expect(profile.hasE2E).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
