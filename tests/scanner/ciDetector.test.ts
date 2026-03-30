import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { detectCI } from '../../src/scanner/ciDetector.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-nextjs');

describe('ciDetector', () => {
  it('detects GitHub Actions from fixture', () => {
    const ci = detectCI(FIXTURE);
    expect(ci.platform).toBe('github-actions');
  });

  it('lists config paths for GitHub Actions', () => {
    const ci = detectCI(FIXTURE);
    expect(ci.configPaths.length).toBeGreaterThan(0);
    expect(ci.configPaths[0]).toContain('.github');
  });

  it('detects test automation in CI', () => {
    const ci = detectCI(FIXTURE);
    expect(ci.hasTestAutomation).toBe(true);
  });

  it('detects coverage reporting in CI', () => {
    const ci = detectCI(FIXTURE);
    expect(ci.hasCoverageReporting).toBe(true);
  });

  it('detects caching setup', () => {
    const ci = detectCI(FIXTURE);
    expect(ci.hasCachingSetup).toBe(true);
  });

  it('returns none platform when no CI found', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ci-'));
    const ci = detectCI(tmp);
    expect(ci.platform).toBe('none');
    expect(ci.jobs.length).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects GitLab CI', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gitlab-'));
    fs.writeFileSync(path.join(tmp, '.gitlab-ci.yml'), `
stages:
  - test

test:
  script:
    - npm test
    - npx jest --coverage
`);
    const ci = detectCI(tmp);
    expect(ci.platform).toBe('gitlab-ci');
    expect(ci.hasTestAutomation).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects CircleCI', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-circle-'));
    fs.mkdirSync(path.join(tmp, '.circleci'));
    fs.writeFileSync(path.join(tmp, '.circleci', 'config.yml'), `
version: 2.1
jobs:
  build:
    docker:
      - image: node:20
    steps:
      - run: npm test
`);
    const ci = detectCI(tmp);
    expect(ci.platform).toBe('circleci');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
