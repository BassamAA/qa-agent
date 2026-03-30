import Handlebars from 'handlebars';
import type { SerializedContext } from '../contextBuilder.js';

// ─── Handlebars Helpers ───────────────────────────────────────────────────────

Handlebars.registerHelper('json', (value: unknown) => JSON.stringify(value, null, 2));
Handlebars.registerHelper('jsonInline', (value: unknown) => JSON.stringify(value));
Handlebars.registerHelper('or', (a: unknown, b: unknown) => a || b);
Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper('notEq', (a: unknown, b: unknown) => a !== b);
Handlebars.registerHelper('join', (arr: string[], sep: string) =>
  Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ', ') : ''
);

// ─── System Prompt Template ───────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `
You are an expert QA engineer and software testing strategist. Your job is to analyze a codebase and produce a complete, actionable test strategy.

You will receive structured data about a scanned codebase. You must respond with a valid JSON object matching the TestStrategy schema exactly. No prose, no markdown, just the JSON object.

## TestStrategy Schema

\`\`\`typescript
{
  recommendedFramework: string,          // primary test framework
  secondaryFramework?: string,           // optional secondary (e.g. supertest for API tests)
  e2eFramework?: string,                 // 'playwright' | 'cypress' | 'selenium' | 'none'
  strategy: string,                      // 1-3 sentence overall strategy
  fileRecommendations: Array<{
    sourceFile: string,                  // path to source file
    testFile: string,                    // suggested test file path
    priority: 'critical' | 'high' | 'medium' | 'low',
    testTypes: Array<'unit' | 'integration' | 'e2e'>,
    estimatedComplexity: 'simple' | 'moderate' | 'complex',
    rationale: string,                   // why this file needs tests
    keyScenarios: string[]               // 3-7 specific test scenarios to cover
  }>,
  priorityOrder: string[],               // file paths in order to write tests
  setupSteps: string[],                  // ordered steps to set up the test environment
  ciIntegration: string[],               // commands / config snippets to add to CI
  estimatedEffort: 'small' | 'medium' | 'large' | 'xlarge',
  coverageTarget: number                 // realistic % coverage target (0-100)
}
\`\`\`

## Decision Rules

1. **Framework selection**: Prefer the existing framework if one is already in use. If none, match the primary language's ecosystem default (vitest for modern TS/Node, pytest for Python, rspec for Rails, go test for Go).
2. **Priority assignment**:
   - critical: auth, payment, data mutation paths, files with risk score ≥ 75
   - high: API routes, service layer, files with risk score 50-74
   - medium: utility functions, helpers, files with risk score 25-49
   - low: type definitions, config files, risk score < 25
3. **Test types**:
   - unit: pure functions, utilities, business logic
   - integration: database operations, external API calls, multi-module workflows
   - e2e: user-facing flows, auth journeys, checkout flows
4. **Effort estimation**:
   - small: < 20 files, < 2000 LOC
   - medium: 20-50 files, 2000-10000 LOC
   - large: 50-100 files, 10000-30000 LOC
   - xlarge: > 100 files or > 30000 LOC
5. **Coverage target**: Be realistic. Projects with no tests should target 60-70% initially. Projects with existing tests should target 80%+.
6. **Always include critical and high-risk untested files** in fileRecommendations.
7. Suggest at most 25 fileRecommendations — focus on the highest-value files.

Respond with ONLY valid JSON. No additional text.
`.trim();

const USER_PROMPT_TEMPLATE = `
## Codebase Scan Results

### Project Summary
- Root: {{project.rootDir}}
- Total files: {{project.summary.totalFiles}}
- Total LOC: {{project.summary.totalLinesOfCode}}
- Critical files: {{project.summary.criticalFiles}}
- High-risk files: {{project.summary.highRiskFiles}}
- Test coverage estimate: {{project.summary.testCoverage}}%

### Tech Stack
- Language: {{stack.primaryLanguage}}
- Framework: {{stack.framework}}
- ORM: {{stack.orm}}
- Auth: {{stack.authLibrary}}
- Payment: {{stack.paymentLibrary}}
- Databases: {{jsonInline stack.databases}}
- Existing test framework: {{stack.testFramework}}
- Package manager: {{stack.packageManager}}

### Existing Tests
- Framework in use: {{existingTests.framework}}
- Test files found: {{existingTests.totalFiles}}
- Unit tests: {{existingTests.hasUnit}}
- Integration tests: {{existingTests.hasIntegration}}
- E2E tests: {{existingTests.hasE2E}}
- Config files: {{jsonInline existingTests.configFiles}}
{{#if existingTests.untestedFiles}}
- Untested source files ({{existingTests.untestedFiles.length}} total):
{{#each existingTests.untestedFiles}}
  - {{this}}
{{/each}}
{{/if}}

### CI/CD
- Platform: {{ci.platform}}
- Has test automation: {{ci.hasTestAutomation}}
- Has coverage reporting: {{ci.hasCoverageReporting}}

### Risk Profile
{{#if riskProfile.untestedCritical}}
#### UNTESTED CRITICAL FILES (highest priority):
{{#each riskProfile.untestedCritical}}
- {{this}}
{{/each}}
{{/if}}

{{#if riskProfile.critical}}
#### Critical Risk Files:
{{#each riskProfile.critical}}
- {{this.path}} (score: {{this.score}}, reasons: {{join this.reasons ", "}})
{{/each}}
{{/if}}

{{#if riskProfile.high}}
#### High Risk Files:
{{#each riskProfile.high}}
- {{this.path}} (score: {{this.score}}, reasons: {{join this.reasons ", "}})
{{/each}}
{{/if}}

### Source Files (top by LOC):
{{#each sourceFiles}}
- {{this.path}} ({{this.language}}, {{this.lineCount}} lines, imports: {{join this.imports ", "}}, exports: {{join this.exports ", "}})
{{/each}}

{{#if userGoal}}
### User Goal
{{userGoal}}
{{/if}}

{{#if targetFiles}}
### Focus on these files:
{{#each targetFiles}}
- {{this}}
{{/each}}
{{/if}}

Analyze the above and produce the TestStrategy JSON object.
`.trim();

// ─── Compiled Templates ───────────────────────────────────────────────────────

const compiledSystem = Handlebars.compile(SYSTEM_PROMPT_TEMPLATE);
const compiledUser = Handlebars.compile(USER_PROMPT_TEMPLATE);

// ─── Prompt Builders ──────────────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  return compiledSystem({});
}

export function buildUserPrompt(ctx: SerializedContext): string {
  return compiledUser(ctx);
}

export function buildMessages(ctx: SerializedContext): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(ctx) },
  ];
}
