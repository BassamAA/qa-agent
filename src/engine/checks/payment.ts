import * as fs from 'fs';
import * as path from 'path';
import { http } from '../utils/httpClient.js';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';

export async function runPaymentChecks(ctx: AppContext): Promise<CheckResult[]> {
  if (!ctx.hasStripe) {
    const skipped: CheckResult = {
      name: 'payment-checks',
      category: 'payment',
      status: 'skipped',
      findings: [],
      duration: 0,
    };
    return [skipped];
  }

  return Promise.all([
    checkWebhookVerification(ctx),
    checkPriceManipulation(ctx),
    checkSubscriptionStatusChecks(ctx),
    checkWebhookEndpointExposure(ctx),
  ]);
}

// ─── Check: Webhook Signature Verification ────────────────────────────────────

async function checkWebhookVerification(ctx: AppContext): Promise<CheckResult> {
  const name = 'webhook-verification';
  const start = Date.now();
  const findings: Finding[] = [];

  // 1. Static analysis — does the webhook handler call stripe.webhooks.constructEvent?
  const webhookFiles = findWebhookFiles(ctx.rootDir);

  for (const file of webhookFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    const hasVerification =
      /constructEvent|stripe\.webhooks\.constructEvent|stripe\.webhooks\.constructEventAsync/.test(content);
    const hasRawBody =
      /rawBody|req\.rawBody|text\(\)|buffer|getRawBody/.test(content);

    if (!hasVerification) {
      findings.push({
        id: makeId('payment', 'webhook-no-verify'),
        category: 'payment',
        severity: 'critical',
        title: `Stripe webhook endpoint does not verify signatures`,
        description: `${rel} appears to handle Stripe webhook events but does not call stripe.webhooks.constructEvent() to verify the signature. Any HTTP POST to this endpoint will be processed.`,
        evidence: `No constructEvent call found in ${rel}`,
        impact: `An attacker can forge Stripe webhook events to trigger subscription upgrades, payment confirmations, or any other webhook-driven action without actually paying.`,
        fix: `Add signature verification to your webhook handler:\n\nconst sig = req.headers['stripe-signature'];\nconst event = stripe.webhooks.constructEvent(\n  rawBody,\n  sig,\n  process.env.STRIPE_WEBHOOK_SECRET\n);\n// Then process event.type`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    } else if (!hasRawBody) {
      findings.push({
        id: makeId('payment', 'webhook-parsed-body'),
        category: 'payment',
        severity: 'high',
        title: `Stripe webhook may fail signature verification (using parsed body instead of raw)`,
        description: `${rel} calls constructEvent but may be passing a parsed JSON body instead of the raw request body string. Stripe signature verification requires the exact raw bytes.`,
        evidence: `constructEvent called but no rawBody/text()/buffer pattern found in ${rel}`,
        impact: `Webhook verification will throw errors for every real Stripe event, breaking payment flows. Or it silently accepts all events if errors are swallowed.`,
        fix: `In Next.js App Router, read the raw body:\n\nconst rawBody = await req.text();\nconst event = stripe.webhooks.constructEvent(rawBody, sig, secret);`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Live test — POST fake event to webhook endpoint
  const webhookRoutes = ['/api/webhooks/stripe', '/api/stripe/webhook', '/api/webhook'];
  for (const route of webhookRoutes) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.post(url, { type: 'checkout.session.completed', data: { object: {} } }, {
        headers: { 'content-type': 'application/json' }, // no stripe-signature
        timeoutMs: 5000,
      });

      if (resp.ok) {
        findings.push({
          id: makeId('payment', 'webhook-accepts-unsigned'),
          category: 'payment',
          severity: 'critical',
          title: `Webhook endpoint accepts unsigned Stripe events`,
          description: `POST ${route} returned HTTP ${resp.status} for a fake Stripe event with no stripe-signature header. The endpoint is processing events without verifying they came from Stripe.`,
          evidence: `POST ${url} (no stripe-signature) → HTTP ${resp.status}`,
          impact: `Anyone can POST fake payment success events to trigger subscription upgrades or fulfillment without paying.`,
          fix: `Verify the stripe-signature header using stripe.webhooks.constructEvent() and return 400 if verification fails.`,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    } catch { /* skip */ }
  }

  return { name, category: 'payment', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Price Manipulation ────────────────────────────────────────────────

async function checkPriceManipulation(ctx: AppContext): Promise<CheckResult> {
  const name = 'price-manipulation';
  const start = Date.now();
  const findings: Finding[] = [];

  // Static analysis: look for price passed from client body
  const sourceFiles = findSourceFiles(ctx.rootDir);

  for (const file of sourceFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Anti-patterns: using client-supplied amount/price directly
    const dangerousPatterns = [
      /(?:amount|price|cost)\s*[:=]\s*(?:body|data|params|req)\.(?:json\(\)|body|data)?\.(?:amount|price|cost)/i,
      /stripe\.charges\.create.*amount.*req\.(body|json)/is,
      /paymentIntents\.create.*amount.*body\./is,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(content)) {
        findings.push({
          id: makeId('payment', `price-manip-${rel}`),
          category: 'payment',
          severity: 'critical',
          title: `Payment amount taken from client request body`,
          description: `${rel} appears to use a price or amount value from the client request body when creating a Stripe charge or PaymentIntent. Clients can manipulate this value.`,
          evidence: `Pattern matched in ${rel}: client-supplied amount used in payment creation`,
          impact: `A user can modify the request body to pay $0.01 for any product by changing the amount field before it reaches Stripe.`,
          fix: `Never trust client-supplied prices. Always look up the price server-side:\n\n// Instead of using req.body.amount\nconst product = await prisma.product.findUnique({ where: { id: productId } });\nconst amount = product.priceInCents; // from your DB, not client`,
          file: rel,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }

  return { name, category: 'payment', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Subscription Status Gating ───────────────────────────────────────

async function checkSubscriptionStatusChecks(ctx: AppContext): Promise<CheckResult> {
  const name = 'subscription-status';
  const start = Date.now();
  const findings: Finding[] = [];

  // Find protected premium routes and check if they verify subscription status
  const protectedRouteFiles = findProtectedRouteFiles(ctx.rootDir);

  for (const file of protectedRouteFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    const hasAuthCheck = /getServerSession|auth\(\)|currentUser\(\)|getUser/.test(content);
    const hasSubscriptionCheck = /subscription|plan|tier|isPro|isPaid|isActive|status/.test(content);

    // If we have auth check but NO subscription check on premium content routes
    if (hasAuthCheck && !hasSubscriptionCheck && /premium|pro|paid|billing/.test(rel)) {
      findings.push({
        id: makeId('payment', `sub-status-${rel}`),
        category: 'payment',
        severity: 'high',
        title: `Premium route checks auth but not subscription status`,
        description: `${rel} verifies the user is logged in but does not check if their subscription is active. A cancelled or expired subscriber can still access premium features.`,
        evidence: `Auth check found but no subscription status check in ${rel}`,
        impact: `Churned customers retain access to paid features indefinitely. Free users who somehow bypass signup can access premium content.`,
        fix: `After verifying the session, also check subscription status:\n\nconst subscription = await getSubscription(session.user.id);\nif (!subscription || subscription.status !== 'active') {\n  redirect('/pricing');\n}`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { name, category: 'payment', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Webhook Endpoint Exposure ─────────────────────────────────────────

async function checkWebhookEndpointExposure(ctx: AppContext): Promise<CheckResult> {
  const name = 'webhook-exposure';
  const start = Date.now();
  const findings: Finding[] = [];

  // Check for CORS issues on webhook endpoints
  const webhookRoutes = ['/api/webhooks/stripe', '/api/stripe/webhook', '/api/webhook'];
  for (const route of webhookRoutes) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.get(url, { timeoutMs: 3000 });
      const corsHeader = resp.headers['access-control-allow-origin'];
      if (corsHeader === '*') {
        findings.push({
          id: makeId('payment', 'webhook-cors'),
          category: 'payment',
          severity: 'medium',
          title: `Stripe webhook endpoint has open CORS`,
          description: `${route} has Access-Control-Allow-Origin: * which allows cross-origin requests from any domain. Webhook endpoints should only accept requests from Stripe's servers.`,
          evidence: `GET ${url} → Access-Control-Allow-Origin: *`,
          impact: `While less critical than signature bypass, open CORS on webhook endpoints increases attack surface. Restrict it to Stripe's known IP ranges.`,
          fix: `Remove CORS from webhook endpoints or restrict to Stripe's IP ranges. Better: verify the stripe-signature header, which is the real protection.`,
          autoFixable: true,
          fixTemplate: 'addCorsHeaders',
          checkName: name,
          timestamp: new Date().toISOString(),
        });
      }
    } catch { /* skip */ }
  }

  return { name, category: 'payment', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findWebhookFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.next', 'dist'].includes(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(ts|js)$/.test(e.name) && /webhook/.test(fp)) results.push(fp);
      }
    } catch { /* skip */ }
  }
  walk(rootDir);
  return results;
}

function findProtectedRouteFiles(rootDir: string): string[] {
  const results: string[] = [];
  const dirs = ['premium', 'pro', 'paid', 'billing', 'dashboard'];
  const appDir = path.join(rootDir, 'app');
  for (const d of dirs) {
    const fp = path.join(appDir, d);
    if (fs.existsSync(fp)) {
      walkForTs(fp, results);
    }
  }
  walkForTs(path.join(rootDir, 'app', 'api'), results);
  return results;
}

function walkForTs(dir: string, results: string[]): void {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next'].includes(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walkForTs(fp, results);
      else if (/\.(ts|tsx)$/.test(e.name)) results.push(fp);
    }
  } catch { /* skip */ }
}

function findSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) results.push(fp);
      }
    } catch { /* skip */ }
  }
  walk(rootDir);
  return results;
}
