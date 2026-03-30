import type {
  BrainContext,
  TestStrategy,
  LLMProvider,
  TestFramework,
} from '../types/index.js';
import { buildContext, serializeContext } from './contextBuilder.js';
import { buildMessages } from './prompts/stackAnalysis.js';
import { ClaudeProvider, extractJSON } from './providers/claude.js';
import { OpenAIProvider } from './providers/openai.js';
import type { ScanResult } from '../types/index.js';

// ─── Brain Options ────────────────────────────────────────────────────────────

export interface BrainOptions {
  provider?: 'claude' | 'openai';
  model?: string;
  apiKey?: string;
  targetFiles?: string[];
  userGoal?: string;
  existingTestFramework?: TestFramework;
  stream?: boolean;
  onToken?: (token: string) => void;
  verbose?: boolean;
}

// ─── Brain Result ─────────────────────────────────────────────────────────────

export interface BrainResult {
  strategy: TestStrategy;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  rawResponse: string;
}

// ─── Brain Orchestrator ───────────────────────────────────────────────────────

export class Brain {
  private provider: LLMProvider;

  constructor(options: BrainOptions = {}) {
    const providerName = options.provider ?? 'claude';

    if (providerName === 'openai') {
      this.provider = new OpenAIProvider({
        apiKey: options.apiKey,
        model: options.model,
      });
    } else {
      this.provider = new ClaudeProvider({
        apiKey: options.apiKey,
        model: options.model,
      });
    }
  }

  async analyze(scan: ScanResult, options: BrainOptions = {}): Promise<BrainResult> {
    // 1. Build context
    const ctx: BrainContext = buildContext(scan, {
      targetFiles: options.targetFiles,
      userGoal: options.userGoal,
      existingTestFramework: options.existingTestFramework,
    });

    // 2. Serialize to prompt-ready format
    const serialized = serializeContext(ctx);

    // 3. Build messages
    const messages = buildMessages(serialized);

    if (options.verbose) {
      const userMsg = messages.find((m) => m.role === 'user');
      if (userMsg) {
        process.stderr.write(`\n[brain] Sending ${userMsg.content.length} chars to ${this.provider.name}\n`);
      }
    }

    // 4. Call LLM
    let rawResponse: string;
    let inputTokens = 0;
    let outputTokens = 0;
    let modelUsed = '';

    if (options.stream && options.onToken) {
      const chunks: string[] = [];
      for await (const token of this.provider.stream(messages, {
        model: options.model,
        onToken: options.onToken,
      })) {
        chunks.push(token);
      }
      rawResponse = chunks.join('');
      modelUsed = options.model ?? (this.provider.name === 'claude' ? 'claude-opus-4-6' : 'gpt-4o');
    } else {
      const response = await this.provider.complete(messages, {
        model: options.model,
        maxTokens: 8192,
        temperature: 0,
      });
      rawResponse = response.content;
      inputTokens = response.inputTokens;
      outputTokens = response.outputTokens;
      modelUsed = response.model;
    }

    // 5. Parse JSON response
    const strategy = extractJSON<TestStrategy>(rawResponse);

    // 6. Validate and sanitize
    const validatedStrategy = validateStrategy(strategy);

    return {
      strategy: validatedStrategy,
      provider: this.provider.name,
      model: modelUsed,
      inputTokens,
      outputTokens,
      rawResponse,
    };
  }
}

// ─── Strategy Validator ───────────────────────────────────────────────────────

function validateStrategy(raw: unknown): TestStrategy {
  const s = raw as Record<string, unknown>;

  if (!s || typeof s !== 'object') {
    throw new Error('LLM returned invalid strategy object');
  }

  const required = ['recommendedFramework', 'strategy', 'fileRecommendations', 'priorityOrder'];
  for (const field of required) {
    if (!(field in s)) {
      throw new Error(`Strategy missing required field: ${field}`);
    }
  }

  // Sanitize fileRecommendations
  const recs = Array.isArray(s['fileRecommendations']) ? s['fileRecommendations'] : [];
  const sanitizedRecs = recs
    .filter((r: unknown) => r && typeof r === 'object')
    .map((r: Record<string, unknown>) => ({
      sourceFile: String(r['sourceFile'] ?? ''),
      testFile: String(r['testFile'] ?? ''),
      priority: validatePriority(r['priority']),
      testTypes: validateTestTypes(r['testTypes']),
      estimatedComplexity: validateComplexity(r['estimatedComplexity']),
      rationale: String(r['rationale'] ?? ''),
      keyScenarios: Array.isArray(r['keyScenarios'])
        ? r['keyScenarios'].map(String)
        : [],
    }));

  return {
    recommendedFramework: String(s['recommendedFramework'] ?? 'jest') as TestFramework,
    secondaryFramework: s['secondaryFramework'] ? String(s['secondaryFramework']) as TestFramework : undefined,
    e2eFramework: validateE2EFramework(s['e2eFramework']),
    strategy: String(s['strategy'] ?? ''),
    fileRecommendations: sanitizedRecs,
    priorityOrder: Array.isArray(s['priorityOrder']) ? s['priorityOrder'].map(String) : [],
    setupSteps: Array.isArray(s['setupSteps']) ? s['setupSteps'].map(String) : [],
    ciIntegration: Array.isArray(s['ciIntegration']) ? s['ciIntegration'].map(String) : [],
    estimatedEffort: validateEffort(s['estimatedEffort']),
    coverageTarget: typeof s['coverageTarget'] === 'number' ? Math.min(100, Math.max(0, s['coverageTarget'])) : 70,
  };
}

function validatePriority(val: unknown): 'critical' | 'high' | 'medium' | 'low' {
  if (val === 'critical' || val === 'high' || val === 'medium' || val === 'low') return val;
  return 'medium';
}

function validateComplexity(val: unknown): 'simple' | 'moderate' | 'complex' {
  if (val === 'simple' || val === 'moderate' || val === 'complex') return val;
  return 'moderate';
}

function validateEffort(val: unknown): 'small' | 'medium' | 'large' | 'xlarge' {
  if (val === 'small' || val === 'medium' || val === 'large' || val === 'xlarge') return val;
  return 'medium';
}

function validateE2EFramework(val: unknown): TestStrategy['e2eFramework'] {
  if (val === 'playwright' || val === 'cypress' || val === 'selenium' || val === 'none') return val;
  return 'none';
}

function validateTestTypes(val: unknown): Array<'unit' | 'integration' | 'e2e'> {
  if (!Array.isArray(val)) return ['unit'];
  return val.filter(
    (t): t is 'unit' | 'integration' | 'e2e' =>
      t === 'unit' || t === 'integration' || t === 'e2e'
  );
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBrain(options: BrainOptions = {}): Brain {
  return new Brain(options);
}
