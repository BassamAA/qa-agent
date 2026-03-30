// ─── Finding ──────────────────────────────────────────────────────────────────

export type FindingCategory = 'auth' | 'data' | 'payment' | 'api' | 'config' | 'frontend';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidence: string;
  impact: string;
  fix: string;
  file?: string;
  line?: number;
  autoFixable: boolean;
  fixCode?: string;
  fixTemplate?: string;
  checkName: string;
  timestamp: string;
}

// ─── Check Result ─────────────────────────────────────────────────────────────

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CheckResult {
  name: string;
  category: FindingCategory;
  status: CheckStatus;
  findings: Finding[];
  duration: number;
  error?: string;
}

// ─── Category Summary ─────────────────────────────────────────────────────────

export interface CategorySummary {
  category: FindingCategory;
  checksRun: number;
  passed: number;
  failed: number;
  skipped: number;
  findings: Finding[];
}

// ─── Engine Result ────────────────────────────────────────────────────────────

export interface EngineResult {
  appName: string;
  appUrl: string;
  rootDir: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  findings: Finding[];
  checkResults: CheckResult[];
  categorySummaries: Record<FindingCategory, CategorySummary>;
  healthScore: number;
  appStarted: boolean;
  appStartError?: string;
}

// ─── App Context ──────────────────────────────────────────────────────────────

export interface AppContext {
  rootDir: string;
  appUrl: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  testUserEmail?: string;
  testUserPassword?: string;
  hasStripe: boolean;
  hasSupabase: boolean;
  appName: string;
  framework: string;
  envVars: Record<string, string>;
}

// ─── Fix Application ──────────────────────────────────────────────────────────

export interface FixResult {
  findingId: string;
  applied: boolean;
  verified: boolean;
  error?: string;
  filesModified: string[];
  buildPassed?: boolean;
}
