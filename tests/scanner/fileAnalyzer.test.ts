import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { analyzeFiles, getLanguageBreakdown, getTotalLines, getPrimaryLanguage } from '../../src/scanner/fileAnalyzer.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-nextjs');

describe('fileAnalyzer', () => {
  let fileMap: ReturnType<typeof analyzeFiles>;

  beforeAll(() => {
    fileMap = analyzeFiles(FIXTURE);
  });

  it('returns a non-empty file map', () => {
    expect(Object.keys(fileMap).length).toBeGreaterThan(0);
  });

  it('detects TypeScript files', () => {
    const tsFiles = Object.values(fileMap).filter((f) => f.language === 'typescript');
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it('excludes node_modules', () => {
    const hasForbidden = Object.keys(fileMap).some((p) => p.includes('node_modules'));
    expect(hasForbidden).toBe(false);
  });

  it('excludes .git directory', () => {
    const hasForbidden = Object.keys(fileMap).some((p) => p.includes('.git'));
    expect(hasForbidden).toBe(false);
  });

  it('populates lineCount > 0 for non-empty files', () => {
    const nonEmpty = Object.values(fileMap).filter((f) => f.size > 0);
    for (const file of nonEmpty) {
      expect(file.lineCount).toBeGreaterThan(0);
    }
  });

  it('populates imports for TypeScript files', () => {
    const tsFiles = Object.values(fileMap).filter((f) => f.language === 'typescript');
    const withImports = tsFiles.filter((f) => f.imports.length > 0);
    expect(withImports.length).toBeGreaterThan(0);
  });

  it('captures next-auth import in auth.ts', () => {
    const authFile = Object.values(fileMap).find((f) => f.path.includes('auth.ts'));
    expect(authFile).toBeDefined();
    expect(authFile?.imports).toContain('next-auth');
  });

  it('stores absolute path', () => {
    const first = Object.values(fileMap)[0];
    expect(first?.absolutePath).toBeDefined();
    expect(path.isAbsolute(first?.absolutePath ?? '')).toBe(true);
  });

  describe('getLanguageBreakdown', () => {
    it('returns typescript count', () => {
      const breakdown = getLanguageBreakdown(fileMap);
      expect(breakdown['typescript']).toBeGreaterThan(0);
    });
  });

  describe('getTotalLines', () => {
    it('returns sum of all line counts', () => {
      const total = getTotalLines(fileMap);
      const manual = Object.values(fileMap).reduce((s, f) => s + f.lineCount, 0);
      expect(total).toBe(manual);
    });
  });

  describe('getPrimaryLanguage', () => {
    it('returns typescript for this fixture', () => {
      const lang = getPrimaryLanguage(fileMap);
      expect(lang).toBe('typescript');
    });
  });
});
