// ─── Language & File Types ────────────────────────────────────────────────────

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'ruby'
  | 'go'
  | 'java'
  | 'rust'
  | 'php'
  | 'csharp'
  | 'cpp'
  | 'c'
  | 'swift'
  | 'kotlin'
  | 'unknown';

export interface FileInfo {
  path: string;
  absolutePath: string;
  size: number;
  lineCount: number;
  language: Language;
  imports: string[];
  exports: string[];
}

export type FileMap = Record<string, FileInfo>;

// ─── Stack Detection ──────────────────────────────────────────────────────────

export type Framework =
  | 'express'
  | 'fastify'
  | 'hapi'
  | 'koa'
  | 'nestjs'
  | 'nextjs'
  | 'nuxtjs'
  | 'remix'
  | 'django'
  | 'flask'
  | 'fastapi'
  | 'rails'
  | 'sinatra'
  | 'gin'
  | 'echo'
  | 'spring'
  | 'actix'
  | 'laravel'
  | 'aspnet'
  | 'unknown';

export type ORM =
  | 'prisma'
  | 'typeorm'
  | 'sequelize'
  | 'mongoose'
  | 'drizzle'
  | 'sqlalchemy'
  | 'activerecord'
  | 'gorm'
  | 'hibernate'
  | 'diesel'
  | 'eloquent'
  | 'efcore'
  | 'none'
  | 'unknown';

export type Database =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'dynamodb'
  | 'firestore'
  | 'supabase'
  | 'planetscale'
  | 'neon'
  | 'unknown';

export type AuthLibrary =
  | 'nextauth'
  | 'clerk'
  | 'auth0'
  | 'passport'
  | 'supabase-auth'
  | 'firebase-auth'
  | 'lucia'
  | 'better-auth'
  | 'jwt'
  | 'none'
  | 'unknown';

export type PaymentLibrary =
  | 'stripe'
  | 'paypal'
  | 'braintree'
  | 'square'
  | 'razorpay'
  | 'none'
  | 'unknown';

export type TestFramework =
  | 'jest'
  | 'vitest'
  | 'mocha'
  | 'jasmine'
  | 'ava'
  | 'pytest'
  | 'unittest'
  | 'rspec'
  | 'minitest'
  | 'go-test'
  | 'junit'
  | 'cargo-test'
  | 'phpunit'
  | 'xunit'
  | 'none'
  | 'unknown';

export type BuildTool =
  | 'webpack'
  | 'vite'
  | 'esbuild'
  | 'rollup'
  | 'turbopack'
  | 'tsc'
  | 'gradle'
  | 'maven'
  | 'cargo'
  | 'go-build'
  | 'poetry'
  | 'pip'
  | 'bundler'
  | 'composer'
  | 'unknown';

export interface StackProfile {
  primaryLanguage: Language;
  framework: Framework;
  orm: ORM;
  databases: Database[];
  authLibrary: AuthLibrary;
  paymentLibrary: PaymentLibrary;
  testFramework: TestFramework;
  buildTool: BuildTool;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'pip' | 'poetry' | 'bundler' | 'cargo' | 'go' | 'maven' | 'gradle' | 'composer' | 'unknown';
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  runtimeVersion?: string;
}

// ─── Test Detection ───────────────────────────────────────────────────────────

export interface TestFile {
  path: string;
  framework: TestFramework;
  type: 'unit' | 'integration' | 'e2e' | 'unknown';
  sourceFile?: string;
}

export interface CoverageReport {
  path: string;
  format: 'lcov' | 'json' | 'html' | 'clover' | 'unknown';
  lastModified?: Date;
}

export interface TestProfile {
  testFiles: TestFile[];
  framework: TestFramework;
  configFiles: string[];
  coverageReports: CoverageReport[];
  hasE2E: boolean;
  hasIntegration: boolean;
  hasUnit: boolean;
  totalTests: number;
  untestedSourceFiles: string[];
}

// ─── CI Detection ─────────────────────────────────────────────────────────────

export type CIPlatform =
  | 'github-actions'
  | 'gitlab-ci'
  | 'circleci'
  | 'jenkins'
  | 'travis-ci'
  | 'bitbucket-pipelines'
  | 'azure-devops'
  | 'none';

export interface CIJob {
  name: string;
  runsOn?: string;
  hasTestStep: boolean;
  hasCoverageStep: boolean;
  triggers: string[];
}

export interface CIProfile {
  platform: CIPlatform;
  configPaths: string[];
  jobs: CIJob[];
  hasTestAutomation: boolean;
  hasCoverageReporting: boolean;
  hasCachingSetup: boolean;
  rawConfig?: string;
}

// ─── Risk Analysis ────────────────────────────────────────────────────────────

export type RiskReason =
  | 'auth_keywords'
  | 'payment_keywords'
  | 'security_keywords'
  | 'high_risk_path'
  | 'large_file'
  | 'high_import_count'
  | 'sensitive_imports'
  | 'database_mutations'
  | 'crypto_operations'
  | 'admin_operations'
  | 'public_api_surface'
  | 'complex_logic'
  | 'many_dependencies';

export interface RiskScore {
  path: string;
  score: number;
  reasons: RiskReason[];
  keywordsFound: string[];
  recommendation: 'critical' | 'high' | 'medium' | 'low';
}

// ─── Scan Result ──────────────────────────────────────────────────────────────

export interface ScanResult {
  rootDir: string;
  scannedAt: string;
  fileMap: FileMap;
  stack: StackProfile;
  tests: TestProfile;
  ci: CIProfile;
  risks: RiskScore[];
  summary: ScanSummary;
}

export interface ScanSummary {
  totalFiles: number;
  totalLinesOfCode: number;
  languageBreakdown: Record<string, number>;
  criticalFiles: number;
  highRiskFiles: number;
  testCoverage: number;
  untestedCriticalFiles: string[];
}

// ─── Brain / LLM Types ───────────────────────────────────────────────────────

export interface BrainContext {
  scan: ScanResult;
  targetFiles?: string[];
  userGoal?: string;
  existingTestFramework?: TestFramework;
}

export interface TestFileRecommendation {
  sourceFile: string;
  testFile: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  testTypes: ('unit' | 'integration' | 'e2e')[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  rationale: string;
  keyScenarios: string[];
}

export interface TestStrategy {
  recommendedFramework: TestFramework;
  secondaryFramework?: TestFramework;
  e2eFramework?: 'playwright' | 'cypress' | 'selenium' | 'none';
  strategy: string;
  fileRecommendations: TestFileRecommendation[];
  priorityOrder: string[];
  setupSteps: string[];
  ciIntegration: string[];
  estimatedEffort: 'small' | 'medium' | 'large' | 'xlarge';
  coverageTarget: number;
}

// ─── CLI Options ──────────────────────────────────────────────────────────────

export interface RunOptions {
  output?: string;
  json?: boolean;
  verbose?: boolean;
  provider?: 'claude' | 'openai';
  model?: string;
  focus?: string;
  exclude?: string;
  minRisk?: number;
}

export interface ScanOptions {
  json?: boolean;
  verbose?: boolean;
  output?: string;
}

export interface GenerateOptions {
  file?: string;
  all?: boolean;
  dryRun?: boolean;
  output?: string;
  framework?: string;
}

export interface ReportOptions {
  format?: 'text' | 'json' | 'html' | 'markdown';
  output?: string;
  open?: boolean;
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
}

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: 'stop' | 'max_tokens' | 'error';
}

export interface LLMProvider {
  name: string;
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<string>;
}
