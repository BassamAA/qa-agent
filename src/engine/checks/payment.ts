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

  // 1. Static analysis — does the webhook handler verify the incoming signature?
  //    Recognises Stripe, Svix (Resend, Clerk, etc.), and generic HMAC patterns.
  //    Also follows one level of imports so helpers in a separate lib/ file are counted.
  const webhookFiles = findWebhookFiles(ctx.rootDir);

  // Known verification patterns across providers
  const VERIFICATION_PATTERNS = [
    // Stripe
    /constructEvent|stripe\.webhooks/,
    // Svix (used by Resend, Clerk, Lemon Squeezy, etc.)
    /svix|Webhook\.verify|wh\.verify|new Webhook\(/,
    // Generic HMAC / signature helpers
    /verifySignature|verifyWebhook|validateWebhook|checkSignature/,
    /createHmac|timingSafeEqual/,
    // AWS SNS, GitHub, etc.
    /x-hub-signature|sha256=/,
  ];

  for (const file of webhookFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Skip test files — they deliberately test unverified payloads
    if (/\.test\.|\.spec\.|__tests__/.test(rel)) continue;

    // Check this file for verification
    let hasVerification = VERIFICATION_PATTERNS.some((re) => re.test(content));

    // Follow one level of local imports — the verification may live in a helper module
    if (!hasVerification) {
      const localImports = extractLocalImports(content, path.dirname(file), ctx.rootDir);
      for (const importedPath of localImports) {
        let importedContent: string;
        try { importedContent = fs.readFileSync(importedPath, 'utf-8'); } catch { continue; }
        if (VERIFICATION_PATTERNS.some((re) => re.test(importedContent))) {
          hasVerification = true;
          break;
        }
      }
    }

    if (!hasVerification) {
      // Determine which provider this webhook is for based on path/content
      const provider = detectWebhookProvider(rel, content);
      findings.push({
        id: makeId('payment', `webhook-no-verify-${rel}`),
        category: 'payment',
        severity: 'critical',
        title: `${provider} webhook endpoint does not verify signatures`,
        description: `${rel} handles ${provider} webhook events but no signature verification was found in this file or its local imports. Any POST to this endpoint will be processed.`,
        evidence: `No signature verification pattern found in ${rel} or its local imports`,
        impact: `An attacker can forge ${provider} webhook events to trigger subscription upgrades, payment confirmations, or any other webhook-driven action.`,
        fix: provider === 'Stripe'
          ? `const sig = req.headers['stripe-signature'];\nconst event = stripe.webhooks.constructEvent(await req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET);`
          : `Use your provider's webhook verification SDK. For Svix/Resend:\nimport { Webhook } from 'svix';\nconst wh = new Webhook(process.env.WEBHOOK_SECRET);\nconst evt = wh.verify(rawBody, headers);`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Live test — POST unsigned payload to known Stripe-specific routes only.
  //    We only flag routes that are explicitly named for Stripe to avoid false
  //    positives on Resend, GitHub, or other webhook routes.
  const stripeRoutes = ['/api/webhooks/stripe', '/api/stripe/webhook', '/api/stripe'];
  for (const route of stripeRoutes) {
    const url = `${ctx.appUrl}${route}`;
    try {
      const resp = await http.post(url, { type: 'checkout.session.completed', data: { object: {} } }, {
        headers: { 'content-type': 'application/json' }, // no stripe-signature header
        timeoutMs: 5000,
      });

      // 200 with no signature header = unsigned events accepted
      // 400/401/403 = properly rejecting unsigned requests (good)
      if (resp.status === 200) {
        findings.push({
          id: makeId('payment', 'webhook-accepts-unsigned'),
          category: 'payment',
          severity: 'critical',
          title: `Stripe webhook endpoint accepts requests with no signature`,
          description: `POST ${route} returned HTTP 200 for a fake Stripe event sent with no stripe-signature header. The endpoint is not rejecting unsigned requests.`,
          evidence: `POST ${url} (no stripe-signature) → HTTP ${resp.status}`,
          impact: `Anyone can POST fake payment success events to trigger subscription upgrades or fulfillment without paying.`,
          fix: `Verify the stripe-signature header and return 400 if missing or invalid:\nconst sig = req.headers.get('stripe-signature');\nif (!sig) return Response.json({ error: 'Missing signature' }, { status: 400 });`,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    } catch { /* route doesn't exist — skip */ }
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

function detectWebhookProvider(relPath: string, content: string): string {
  if (/stripe/i.test(relPath) || /stripe/i.test(content)) return 'Stripe';
  if (/resend/i.test(relPath) || /resend/i.test(content)) return 'Resend';
  if (/clerk/i.test(relPath) || /clerk/i.test(content)) return 'Clerk';
  if (/svix/i.test(content)) return 'Svix';
  if (/github/i.test(relPath)) return 'GitHub';
  if (/lemon/i.test(relPath) || /lemon.?squeezy/i.test(content)) return 'LemonSqueezy';
  return 'Webhook';
}

function extractLocalImports(content: string, fileDir: string, rootDir: string): string[] {
  const results: string[] = [];
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const importPath = m[1];
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const resolved = path.resolve(fileDir, importPath + ext);
      if (fs.existsSync(resolved) && resolved.startsWith(rootDir)) {
        results.push(resolved);
        break;
      }
    }
  }
  return results;
}

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
