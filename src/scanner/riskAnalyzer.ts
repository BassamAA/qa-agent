import type { FileMap, RiskScore, RiskReason } from '../types/index.js';
import * as fs from 'fs';

// ─── Keyword Tables ───────────────────────────────────────────────────────────

const AUTH_KEYWORDS = [
  'password', 'passwd', 'authenticate', 'authentication', 'authorization',
  'login', 'logout', 'signin', 'signout', 'session', 'jwt', 'token',
  'oauth', 'openid', 'bearer', 'credential', 'identity', 'permission',
  'role', 'rbac', 'acl', 'middleware', 'guard', 'policy',
];

const PAYMENT_KEYWORDS = [
  'stripe', 'paypal', 'braintree', 'payment', 'charge', 'billing',
  'invoice', 'subscription', 'checkout', 'cart', 'order', 'refund',
  'webhook', 'price', 'coupon', 'discount', 'tax', 'transaction',
  'wallet', 'balance', 'transfer', 'payout', 'merchant',
];

const SECURITY_KEYWORDS = [
  'secret', 'private_key', 'public_key', 'api_key', 'apikey',
  'access_key', 'access_token', 'refresh_token', 'csrf', 'xss',
  'sql', 'injection', 'sanitize', 'escape', 'hash', 'salt',
  'encrypt', 'decrypt', 'cipher', 'hmac', 'signature', 'verify',
];

const CRYPTO_KEYWORDS = [
  'bcrypt', 'argon2', 'scrypt', 'pbkdf2', 'sha256', 'sha512',
  'md5', 'aes', 'rsa', 'ecdsa', 'crypto', 'subtle',
];

const ADMIN_KEYWORDS = [
  'admin', 'superuser', 'root', 'sudo', 'privileged', 'elevated',
  'manage', 'dashboard', 'internal', 'backoffice',
];

const DATABASE_MUTATION_KEYWORDS = [
  'createMany', 'updateMany', 'deleteMany', 'upsert', 'truncate',
  'drop', 'migrate', 'seed', 'transaction', 'rollback', 'commit',
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
];

// ─── Path Risk Tables ─────────────────────────────────────────────────────────

type PathRule = { pattern: RegExp; score: number; reason: RiskReason };

const PATH_RULES: PathRule[] = [
  { pattern: /auth/i, score: 30, reason: 'high_risk_path' },
  { pattern: /login|signin|logout|signout/i, score: 25, reason: 'high_risk_path' },
  { pattern: /payment|billing|checkout|stripe|invoice/i, score: 35, reason: 'high_risk_path' },
  { pattern: /\broutes?\b|\bapi\b|\bcontrollers?\b/i, score: 20, reason: 'public_api_surface' },
  { pattern: /middleware/i, score: 15, reason: 'high_risk_path' },
  { pattern: /service|repository|repo/i, score: 10, reason: 'high_risk_path' },
  { pattern: /admin|backoffice/i, score: 25, reason: 'admin_operations' },
  { pattern: /crypt|hash|security/i, score: 20, reason: 'crypto_operations' },
  { pattern: /database|migration|seed/i, score: 15, reason: 'database_mutations' },
  { pattern: /webhook/i, score: 20, reason: 'high_risk_path' },
];

// ─── Import Risk Tables ───────────────────────────────────────────────────────

const SENSITIVE_IMPORTS: Record<string, number> = {
  bcrypt: 20,
  argon2: 20,
  jsonwebtoken: 20,
  jose: 15,
  stripe: 25,
  '@stripe/stripe-js': 25,
  paypal: 20,
  crypto: 10,
  'node:crypto': 10,
  'express-session': 15,
  passport: 20,
  'passport-local': 20,
  'passport-jwt': 20,
  knex: 10,
  prisma: 10,
  typeorm: 10,
  mongoose: 8,
  sequelize: 8,
};

// ─── Scoring Functions ────────────────────────────────────────────────────────

interface ScoreAccumulator {
  score: number;
  reasons: Set<RiskReason>;
  keywords: Set<string>;
}

function scoreKeywords(
  content: string,
  acc: ScoreAccumulator
): void {
  const lower = content.toLowerCase();

  // Auth keywords
  let authHits = 0;
  for (const kw of AUTH_KEYWORDS) {
    if (lower.includes(kw)) {
      authHits++;
      acc.keywords.add(kw);
    }
  }
  if (authHits > 0) {
    acc.reasons.add('auth_keywords');
    acc.score += Math.min(authHits * 4, 25);
  }

  // Payment keywords
  let payHits = 0;
  for (const kw of PAYMENT_KEYWORDS) {
    if (lower.includes(kw)) {
      payHits++;
      acc.keywords.add(kw);
    }
  }
  if (payHits > 0) {
    acc.reasons.add('payment_keywords');
    acc.score += Math.min(payHits * 5, 30);
  }

  // Security keywords
  let secHits = 0;
  for (const kw of SECURITY_KEYWORDS) {
    if (lower.includes(kw)) {
      secHits++;
      acc.keywords.add(kw);
    }
  }
  if (secHits > 0) {
    acc.reasons.add('security_keywords');
    acc.score += Math.min(secHits * 3, 20);
  }

  // Crypto keywords
  let cryptoHits = 0;
  for (const kw of CRYPTO_KEYWORDS) {
    if (lower.includes(kw)) {
      cryptoHits++;
      acc.keywords.add(kw);
    }
  }
  if (cryptoHits > 0) {
    acc.reasons.add('crypto_operations');
    acc.score += Math.min(cryptoHits * 5, 20);
  }

  // Admin keywords
  let adminHits = 0;
  for (const kw of ADMIN_KEYWORDS) {
    if (lower.includes(kw)) {
      adminHits++;
      acc.keywords.add(kw);
    }
  }
  if (adminHits > 0) {
    acc.reasons.add('admin_operations');
    acc.score += Math.min(adminHits * 4, 15);
  }

  // Database mutation keywords
  let dbHits = 0;
  for (const kw of DATABASE_MUTATION_KEYWORDS) {
    if (content.includes(kw)) {
      dbHits++;
      acc.keywords.add(kw);
    }
  }
  if (dbHits > 0) {
    acc.reasons.add('database_mutations');
    acc.score += Math.min(dbHits * 3, 15);
  }
}

function scorePath(filePath: string, acc: ScoreAccumulator): void {
  for (const rule of PATH_RULES) {
    if (rule.pattern.test(filePath)) {
      acc.score += rule.score;
      acc.reasons.add(rule.reason);
    }
  }
}

function scoreImports(imports: string[], acc: ScoreAccumulator): void {
  let totalImportScore = 0;
  for (const imp of imports) {
    const score = SENSITIVE_IMPORTS[imp] ?? 0;
    if (score > 0) {
      totalImportScore += score;
      acc.keywords.add(imp);
    }
  }
  if (totalImportScore > 0) {
    acc.reasons.add('sensitive_imports');
    acc.score += Math.min(totalImportScore, 35);
  }

  // High import count = complex file
  if (imports.length > 15) {
    acc.reasons.add('many_dependencies');
    acc.score += 5;
  }
}

function scoreSize(size: number, lineCount: number, acc: ScoreAccumulator): void {
  if (size > 100_000 || lineCount > 500) {
    acc.reasons.add('large_file');
    acc.score += 15;
  } else if (size > 50_000 || lineCount > 250) {
    acc.reasons.add('large_file');
    acc.score += 8;
  } else if (size > 10_000 || lineCount > 100) {
    acc.reasons.add('large_file');
    acc.score += 4;
  }

  // Very many lines = complex logic
  if (lineCount > 300) {
    acc.reasons.add('complex_logic');
    acc.score += 5;
  }
}

function mapScoreToRecommendation(
  score: number
): RiskScore['recommendation'] {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

// ─── Main Analyzer ────────────────────────────────────────────────────────────

export function analyzeRisks(fileMap: FileMap): RiskScore[] {
  const risks: RiskScore[] = [];

  for (const file of Object.values(fileMap)) {
    const acc: ScoreAccumulator = {
      score: 10, // base score
      reasons: new Set(),
      keywords: new Set(),
    };

    // Read content for keyword analysis
    let content = '';
    try {
      if (file.size < 500_000) {
        content = fs.readFileSync(file.absolutePath, 'utf-8');
      }
    } catch {
      // ignore read errors
    }

    scorePath(file.path, acc);
    scoreImports(file.imports, acc);
    if (content) scoreKeywords(content, acc);
    scoreSize(file.size, file.lineCount, acc);

    const finalScore = Math.min(Math.round(acc.score), 100);
    const recommendation = mapScoreToRecommendation(finalScore);

    risks.push({
      path: file.path,
      score: finalScore,
      reasons: [...acc.reasons],
      keywordsFound: [...acc.keywords].slice(0, 20),
      recommendation,
    } satisfies RiskScore);
  }

  // Sort by score descending
  return risks.sort((a, b) => b.score - a.score);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getCriticalFiles(risks: RiskScore[]): RiskScore[] {
  return risks.filter((r) => r.recommendation === 'critical');
}

export function getHighRiskFiles(risks: RiskScore[]): RiskScore[] {
  return risks.filter((r) => r.recommendation === 'high' || r.recommendation === 'critical');
}

export function getUntestedCriticalFiles(
  risks: RiskScore[],
  untestedFiles: string[]
): string[] {
  const untestedSet = new Set(untestedFiles);
  return risks
    .filter((r) => r.recommendation === 'critical' && untestedSet.has(r.path))
    .map((r) => r.path);
}
