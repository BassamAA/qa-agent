import * as fs from 'fs';
import * as path from 'path';
import type { CIProfile, CIPlatform, CIJob } from '../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_STEP_KEYWORDS = [
  /\btest\b/i,
  /\bspec\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\brspec\b/i,
  /\bmocha\b/i,
  /npm\s+(?:run\s+)?test/i,
  /yarn\s+test/i,
  /pnpm\s+test/i,
  /go\s+test/i,
  /cargo\s+test/i,
];

const COVERAGE_STEP_KEYWORDS = [
  /coverage/i,
  /lcov/i,
  /codecov/i,
  /coveralls/i,
  /nyc/i,
  /c8\b/i,
  /--coverage/i,
];

const CACHE_KEYWORDS = [/cache/i, /restore-keys/i, /actions\/cache/i];

// ─── GitHub Actions Parser ────────────────────────────────────────────────────

function parseGitHubActionsDir(dir: string): CIJob[] {
  const jobs: CIJob[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return jobs;
  }

  for (const file of files) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;

    const content = readFile(path.join(dir, file));
    if (!content) continue;

    // Rough YAML parsing — extract job names and step commands
    const jobNameRe = /^  (\w[\w-]*):\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = jobNameRe.exec(content)) !== null) {
      const jobName = m[1];
      if (['on', 'env', 'permissions', 'defaults', 'concurrency', 'jobs'].includes(jobName))
        continue;

      const jobSection = content.slice(m.index);
      const hasTestStep = TEST_STEP_KEYWORDS.some((re) => re.test(jobSection));
      const hasCoverageStep = COVERAGE_STEP_KEYWORDS.some((re) => re.test(jobSection));

      const runsOnMatch = /runs-on:\s*(.+)/i.exec(jobSection);
      const triggersMatch = /^on:\s*([\s\S]+?)^jobs:/m.exec(content);

      const triggers: string[] = [];
      if (triggersMatch) {
        const triggerSection = triggersMatch[1];
        const triggerRe = /^\s{2}(\w+):/gm;
        let tm: RegExpExecArray | null;
        while ((tm = triggerRe.exec(triggerSection)) !== null) {
          triggers.push(tm[1]);
        }
      }

      jobs.push({
        name: jobName,
        runsOn: runsOnMatch ? runsOnMatch[1].trim() : undefined,
        hasTestStep,
        hasCoverageStep,
        triggers,
      });
    }
  }

  return jobs;
}

// ─── GitLab CI Parser ─────────────────────────────────────────────────────────

function parseGitLabCI(content: string): CIJob[] {
  const jobs: CIJob[] = [];

  // Extract job names (top-level keys that are not directives)
  const GITLAB_DIRECTIVES = new Set([
    'stages',
    'variables',
    'cache',
    'image',
    'services',
    'before_script',
    'after_script',
    'include',
    'workflow',
    'default',
  ]);

  const jobRe = /^(\w[\w:-]*):\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = jobRe.exec(content)) !== null) {
    const name = m[1];
    if (GITLAB_DIRECTIVES.has(name)) continue;

    const section = content.slice(m.index, m.index + 2000);
    jobs.push({
      name,
      hasTestStep: TEST_STEP_KEYWORDS.some((re) => re.test(section)),
      hasCoverageStep: COVERAGE_STEP_KEYWORDS.some((re) => re.test(section)),
      triggers: [],
    });
  }

  return jobs;
}

// ─── CircleCI Parser ──────────────────────────────────────────────────────────

function parseCircleCI(content: string): CIJob[] {
  const jobs: CIJob[] = [];

  const jobsSection = /^jobs:([\s\S]+?)(?=^workflows:|^orbs:|$)/m.exec(content)?.[1] ?? '';
  const jobRe = /^\s{2}(\w[\w-]*):\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = jobRe.exec(jobsSection)) !== null) {
    const name = m[1];
    const section = jobsSection.slice(m.index, m.index + 2000);
    jobs.push({
      name,
      hasTestStep: TEST_STEP_KEYWORDS.some((re) => re.test(section)),
      hasCoverageStep: COVERAGE_STEP_KEYWORDS.some((re) => re.test(section)),
      triggers: [],
    });
  }

  return jobs;
}

// ─── Jenkins Parser ───────────────────────────────────────────────────────────

function parseJenkinsfile(content: string): CIJob[] {
  const jobs: CIJob[] = [];
  const stageRe = /stage\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = stageRe.exec(content)) !== null) {
    const name = m[1];
    const section = content.slice(m.index, m.index + 1000);
    jobs.push({
      name,
      hasTestStep: TEST_STEP_KEYWORDS.some((re) => re.test(section)),
      hasCoverageStep: COVERAGE_STEP_KEYWORDS.some((re) => re.test(section)),
      triggers: [],
    });
  }
  return jobs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// ─── Main Detector ────────────────────────────────────────────────────────────

export function detectCI(rootDir: string): CIProfile {
  const platform: CIPlatform = 'none';
  const configPaths: string[] = [];
  let jobs: CIJob[] = [];
  let rawConfig: string | undefined;

  // GitHub Actions
  const ghActionsDir = path.join(rootDir, '.github', 'workflows');
  if (dirExists(ghActionsDir)) {
    const files = fs.readdirSync(ghActionsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    if (files.length > 0) {
      files.forEach((f) => configPaths.push(path.join('.github', 'workflows', f)));
      jobs = parseGitHubActionsDir(ghActionsDir);
      rawConfig = files.map((f) => readFile(path.join(ghActionsDir, f)) ?? '').join('\n---\n');
      return buildProfile('github-actions', configPaths, jobs, rawConfig);
    }
  }

  // GitLab CI
  const gitlabCI = path.join(rootDir, '.gitlab-ci.yml');
  rawConfig = readFile(gitlabCI) ?? undefined;
  if (rawConfig) {
    configPaths.push('.gitlab-ci.yml');
    jobs = parseGitLabCI(rawConfig);
    return buildProfile('gitlab-ci', configPaths, jobs, rawConfig);
  }

  // CircleCI
  const circleCI = path.join(rootDir, '.circleci', 'config.yml');
  rawConfig = readFile(circleCI) ?? undefined;
  if (rawConfig) {
    configPaths.push('.circleci/config.yml');
    jobs = parseCircleCI(rawConfig);
    return buildProfile('circleci', configPaths, jobs, rawConfig);
  }

  // Jenkins
  const jenkinsfile = path.join(rootDir, 'Jenkinsfile');
  rawConfig = readFile(jenkinsfile) ?? undefined;
  if (rawConfig) {
    configPaths.push('Jenkinsfile');
    jobs = parseJenkinsfile(rawConfig);
    return buildProfile('jenkins', configPaths, jobs, rawConfig);
  }

  // Travis CI
  const travisCI = path.join(rootDir, '.travis.yml');
  rawConfig = readFile(travisCI) ?? undefined;
  if (rawConfig) {
    configPaths.push('.travis.yml');
    const hasTest = TEST_STEP_KEYWORDS.some((re) => re.test(rawConfig!));
    jobs = [{ name: 'build', hasTestStep: hasTest, hasCoverageStep: false, triggers: ['push'] }];
    return buildProfile('travis-ci', configPaths, jobs, rawConfig);
  }

  // Bitbucket Pipelines
  const bbPipelines = path.join(rootDir, 'bitbucket-pipelines.yml');
  rawConfig = readFile(bbPipelines) ?? undefined;
  if (rawConfig) {
    configPaths.push('bitbucket-pipelines.yml');
    const hasTest = TEST_STEP_KEYWORDS.some((re) => re.test(rawConfig!));
    jobs = [{ name: 'default', hasTestStep: hasTest, hasCoverageStep: false, triggers: [] }];
    return buildProfile('bitbucket-pipelines', configPaths, jobs, rawConfig);
  }

  // Azure DevOps
  const azurePipelines =
    readFile(path.join(rootDir, 'azure-pipelines.yml')) ??
    readFile(path.join(rootDir, '.azure', 'pipelines.yml'));
  if (azurePipelines) {
    configPaths.push('azure-pipelines.yml');
    const hasTest = TEST_STEP_KEYWORDS.some((re) => re.test(azurePipelines));
    jobs = [{ name: 'CI', hasTestStep: hasTest, hasCoverageStep: false, triggers: [] }];
    return buildProfile('azure-devops', configPaths, jobs, azurePipelines);
  }

  // No CI found
  return buildProfile(platform, configPaths, jobs, undefined);
}

function buildProfile(
  platform: CIPlatform,
  configPaths: string[],
  jobs: CIJob[],
  rawConfig: string | undefined
): CIProfile {
  const hasTestAutomation = jobs.some((j) => j.hasTestStep);
  const hasCoverageReporting = jobs.some((j) => j.hasCoverageStep);
  const hasCachingSetup =
    rawConfig !== undefined && CACHE_KEYWORDS.some((re) => re.test(rawConfig!));

  return {
    platform,
    configPaths,
    jobs,
    hasTestAutomation,
    hasCoverageReporting,
    hasCachingSetup,
    rawConfig,
  } satisfies CIProfile;
}
