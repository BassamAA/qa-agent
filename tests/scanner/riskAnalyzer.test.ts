import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { analyzeFiles } from '../../src/scanner/fileAnalyzer.js';
import { analyzeRisks, getCriticalFiles, getHighRiskFiles, getUntestedCriticalFiles } from '../../src/scanner/riskAnalyzer.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-nextjs');

describe('riskAnalyzer', () => {
  const fileMap = analyzeFiles(FIXTURE);
  const risks = analyzeRisks(fileMap);

  it('returns a risk score for every file in the fileMap', () => {
    expect(risks.length).toBe(Object.keys(fileMap).length);
  });

  it('scores auth.ts as high or critical', () => {
    const authRisk = risks.find((r) => r.path.includes('auth.ts'));
    expect(authRisk).toBeDefined();
    expect(['critical', 'high']).toContain(authRisk?.recommendation);
  });

  it('scores payments.ts as high or critical', () => {
    const payRisk = risks.find((r) => r.path.includes('payments.ts'));
    expect(payRisk).toBeDefined();
    expect(['critical', 'high']).toContain(payRisk?.recommendation);
  });

  it('scores are in range 0-100', () => {
    for (const r of risks) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('sorts results by score descending', () => {
    for (let i = 1; i < risks.length; i++) {
      expect(risks[i - 1]!.score).toBeGreaterThanOrEqual(risks[i]!.score);
    }
  });

  it('identifies reasons for auth.ts risk', () => {
    const authRisk = risks.find((r) => r.path.includes('auth.ts'));
    expect(authRisk?.reasons.length).toBeGreaterThan(0);
    const reasonSet = new Set(authRisk?.reasons ?? []);
    expect(
      reasonSet.has('auth_keywords') ||
      reasonSet.has('sensitive_imports') ||
      reasonSet.has('crypto_operations')
    ).toBe(true);
  });

  describe('getCriticalFiles', () => {
    it('returns only critical files', () => {
      const critical = getCriticalFiles(risks);
      for (const c of critical) {
        expect(c.recommendation).toBe('critical');
      }
    });
  });

  describe('getHighRiskFiles', () => {
    it('returns critical and high files', () => {
      const high = getHighRiskFiles(risks);
      for (const h of high) {
        expect(['critical', 'high']).toContain(h.recommendation);
      }
    });
  });

  describe('getUntestedCriticalFiles', () => {
    it('returns critical files that are in the untested list', () => {
      const critical = getCriticalFiles(risks);
      const untestedAll = risks.map((r) => r.path);
      const untestedCritical = getUntestedCriticalFiles(risks, untestedAll);
      for (const f of untestedCritical) {
        const risk = risks.find((r) => r.path === f);
        expect(risk?.recommendation).toBe('critical');
      }
    });

    it('returns empty array when no critical files are untested', () => {
      const result = getUntestedCriticalFiles(risks, []);
      expect(result).toEqual([]);
    });
  });
});
