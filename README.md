# bugscout

**An intelligent QA agent that actually runs against your app, finds real bugs, and fixes them.**

Not a linter. Not a static analyzer. bugscout spins up your Next.js app, hits your API endpoints without auth tokens, queries your Supabase tables as an anonymous user, fires malformed payloads at your routes, checks if your Stripe webhook verifies signatures — and then tells you exactly what's broken and how to fix it.

```
  ╔═══════════════════════╗
  ║  bugscout v1.0.0     ║
  ╚═══════════════════════╝

  Health Score: ████████████░░░░░░░░ 62/100

  🚨 Critical: 3   ⚠️  High: 4   📋 Medium+Low: 6
  ✨ Auto-fixable: 7 of 13

  Top issues:
  • [CRITICAL] Unprotected API route returns data without authentication
  • [CRITICAL] Supabase table "users" readable without authentication (RLS missing)
  • [CRITICAL] Stripe webhook endpoint does not verify signatures
```

---

## What it checks

### 🔐 Auth Holes *(critical — data exposure)*
- Every API route called without a token — does it return data?
- IDOR: authenticated as User A, request User B's data — does it leak?
- Supabase RLS: query your tables as anon — can you read rows you shouldn't?
- Token storage: are JWTs in `localStorage` (XSS-vulnerable) or httpOnly cookies?
- Supabase `service_role` key used in client-side code?
- Protected pages that render before redirecting

### 🧱 Data Integrity *(high — silent corruption)*
- Every mutation endpoint: empty body, SQL injection strings, 10MB strings, type confusion
- Database constraints: does your schema have `NOT NULL`, `UNIQUE`, `CHECK` — or is it relying on frontend validation only?
- Race conditions: fire the same mutation 10× simultaneously — do you get duplicate records?
- Multi-step DB operations without transactions
- Unbounded queries with no `LIMIT` or pagination

### 💳 Payment Logic *(critical if Stripe detected)*
- Webhook endpoints: do they call `stripe.webhooks.constructEvent()` or trust any POST?
- Price manipulation: is the amount taken from the request body (user-controllable)?
- Subscription status: premium routes that check auth but not whether the subscription is active
- CORS on webhook endpoints

### 🌐 API Robustness *(medium — user-facing errors)*
- HTTP method handling: `DELETE /api/users` when only `GET` is supported — crash or 405?
- Rate limiting: 20 rapid requests — any 429s, or is your API wide open?
- Error leakage: do 500 responses contain stack traces, Postgres errors, or Prisma objects?
- Response times: any endpoint taking >3s?
- CORS policy: open `*` vs restricted origins

### ⚙️ Environment & Config *(medium — deployment risk)*
- Hardcoded secrets in source: Stripe live keys, JWTs, AWS credentials
- `NEXT_PUBLIC_` prefixed secrets (embedded in client bundle)
- `.env.local` not in `.gitignore`
- Missing `next.config.js` security headers
- `dangerouslyAllowSVG` enabled

### 🎨 Frontend Resilience *(low-medium — UX quality)*
- Route segments missing `error.tsx` (unhandled render errors crash the whole page)
- Data-heavy pages missing `loading.tsx`
- List rendering without empty state handling
- Missing `metadata` export in `layout.tsx` (no title, description, OG tags)
- Images without `alt` text, icon buttons without `aria-label`

---

## Install

```bash
npm install -g bugscout
# or run directly without installing
npx bugscout run .
```

**Requirements:** Node.js 18+

---

## Usage

### Diagnose your app
```bash
npx bugscout run .
```
Starts your app, runs all checks, writes `qa-diagnosis.md`.

```bash
npx bugscout run . --url https://your-staging-url.com
```
Skip the local build — run against an already-running app.

### Auto-fix issues
```bash
npx bugscout fix .
```
Runs diagnosis, then for each auto-fixable issue shows the diff and asks for confirmation. Verifies the build still passes after each fix. Commits each fix with a descriptive message.

```bash
npx bugscout fix . --yes     # skip confirmation prompts
npx bugscout fix . --dry     # show diffs only, don't apply
npx bugscout fix . --verbose # show diffs + apply
```

### Static scan (fast, no LLM)
```bash
npx bugscout scan .
```
No app startup, no API calls. Just file analysis, stack detection, risk scoring. Completes in seconds.

### AI test strategy
```bash
npx bugscout generate .
npx bugscout generate . --provider openai --model gpt-4o
npx bugscout generate . --goal "focus on auth and payment flows"
```
Analyzes your codebase with Claude or GPT-4 and produces a prioritized test strategy.

### Watch mode (dev)
```bash
npx bugscout watch .
```
Re-runs relevant checks on every file save. Like ESLint but for real security issues.

### Generate report only
```bash
npx bugscout report .
npx bugscout report . --output ./docs/qa-report.md
```

---

## The diagnosis report

Every run produces a `qa-diagnosis.md`:

```markdown
# 🔍 QA Diagnosis — my-app
## Run: 3/30/2026, 4:11 PM | Duration: 47.3s | Findings: 13

### Health Score
████████████░░░░░░░░ 62/100

### 🚨 Critical Issues (Fix These Now)

**Unprotected API route returns data without authentication**

The route /api/users returned HTTP 200 with a data payload when called
with no authentication token.

📍 File: `app/api/users/route.ts`
💥 Impact: Any unauthenticated user can retrieve data from /api/users.
🔧 Fix: Add auth middleware to the route handler...

> ✨ Auto-fixable — run `npx bugscout fix .` to apply this fix

...

### ✅ What's Good
- Auth middleware present on /api/payments ✓
- Stripe webhook verifies signatures ✓
- Environment variables properly separated ✓

### 📊 Coverage Summary
| Area      | Checks Run | Passed | Failed | Skipped |
|-----------|-----------|--------|--------|---------|
| Auth      | 6         | 3      | 3      | 0       |
| Payments  | 4         | 3      | 1      | 0       |
| API       | 5         | 4      | 1      | 0       |
...

### 🗺️ Next Steps
1. Add session validation to /api/users/route.ts (~2 min, auto-fixable)
2. Enable RLS on users table (~15 min)
3. Add webhook signature verification (~15 min)

> Fixing these 3 issues would bring your health score from 62 to 92.
```

---

## Auto-fixable issues

When bugscout can safely fix an issue, it generates and applies the code change, verifies the build still passes, then commits:

| Fix | What it does |
|-----|-------------|
| `addAuthCheck` | Injects `getServerSession()` + 401 guard at the top of an unprotected route |
| `addValidation` | Adds Zod schema + `safeParse()` to a POST handler |
| `addRateLimit` | Injects rate limiting middleware |
| `addErrorBoundary` | Creates `error.tsx` in route segments missing one |
| `addLoadingState` | Creates `loading.tsx` for data-heavy pages |
| `fixEnvExposure` | Removes `NEXT_PUBLIC_` prefix from server-only secrets |
| `addMethodHandler` | Adds `405 Method Not Allowed` for unhandled HTTP methods |
| `addCorsHeaders` | Replaces `Access-Control-Allow-Origin: *` with env-var origin |
| `addMetaTags` | Adds `metadata` export to `app/layout.tsx` |

Fixes that are **recommended but not auto-applied** (too risky):
- Supabase RLS policies
- Stripe webhook secret setup
- Database schema migrations
- Anything touching payment transaction logic

---

## AI providers

Set your API key in the environment:

```bash
# Claude (default — recommended)
export ANTHROPIC_API_KEY=sk-ant-...
npx bugscout generate .

# OpenAI
export OPENAI_API_KEY=sk-...
npx bugscout generate . --provider openai
```

For the `run` and `fix` commands, no API key is needed — all checks are deterministic.

---

## Target stack

bugscout is purpose-built for the modern TypeScript/Next.js stack:

- **Next.js** 13/14/15 (App Router)
- **Supabase** — Auth, Database, RLS, Storage
- **Prisma** or **Drizzle** or raw Supabase client
- **Stripe** — payments, webhooks, subscriptions
- **Vercel** deployment
- **TypeScript** throughout

The scanner also handles Python (Django/Flask/FastAPI), Ruby (Rails), Go (Gin/Echo), Rust, Java, and PHP for static analysis and stack detection.

---

## How it works

```
┌─────────────────────────────────────────────────────────┐
│                       bugscout run .                     │
└──────────────────────────┬──────────────────────────────┘
                           │
          ┌────────────────▼────────────────┐
          │         Scanner (Phase 1)        │
          │  fileAnalyzer  stackDetector     │
          │  testDetector  ciDetector        │
          │  riskAnalyzer                    │
          └────────────────┬────────────────┘
                           │  ScanResult
          ┌────────────────▼────────────────┐
          │         Engine (Phase 2)         │
          │  Starts your app locally         │
          │  ┌──────────────────────────┐   │
          │  │  auth    data   payment  │   │
          │  │  api     config frontend │   │
          │  └──────────────────────────┘   │
          │  Real HTTP calls + Supabase      │
          └────────────────┬────────────────┘
                           │  EngineResult (findings[])
          ┌────────────────▼────────────────┐
          │        Reporter (Phase 3)        │
          │  Health score calculation        │
          │  qa-diagnosis.md generation      │
          └────────────────┬────────────────┘
                           │
          ┌────────────────▼────────────────┐
          │         Fixer (Phase 4)          │  ← bugscout fix
          │  Show diff → confirm → apply     │
          │  Verify build → git commit       │
          └─────────────────────────────────┘
```

**The checks run against the real app.** Not static guesses. bugscout:
1. Starts your Next.js app on a free port (`npm run build && npm start`)
2. Creates temporary Supabase test users, gets real auth tokens
3. Fires real HTTP requests to your real endpoints
4. Queries your real Supabase tables with the anon key
5. Cleans up all test data after

---

## CI integration

Add to your GitHub Actions workflow:

```yaml
- name: QA Diagnosis
  run: npx bugscout run . --json > qa-result.json
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Upload QA Report
  uses: actions/upload-artifact@v4
  with:
    name: qa-diagnosis
    path: qa-diagnosis.md

# Fail the build on critical findings
- name: Check health score
  run: |
    SCORE=$(node -e "const r=require('./qa-result.json'); process.exit(r.healthScore < 70 ? 1 : 0)")
```

---

## Architecture

```
src/
├── types/index.ts                    — all shared TypeScript interfaces
├── scanner/
│   ├── fileAnalyzer.ts               — recursive walker, import/export extraction
│   ├── stackDetector.ts              — framework, ORM, auth, payment, DB detection
│   ├── testDetector.ts               — existing tests, coverage gaps
│   ├── ciDetector.ts                 — GitHub Actions, GitLab, CircleCI, Jenkins
│   ├── riskAnalyzer.ts               — 0-100 risk score with typed reasons
│   └── index.ts                      — scanner orchestrator
├── brain/
│   ├── contextBuilder.ts             — compacts scan output for LLM
│   ├── prompts/stackAnalysis.ts      — Handlebars system + user prompt templates
│   ├── providers/claude.ts           — Anthropic SDK, streaming, retry
│   ├── providers/openai.ts           — OpenAI SDK, same interface
│   └── index.ts                      — brain orchestrator
├── engine/
│   ├── checks/
│   │   ├── auth.ts                   — auth holes, IDOR, RLS, service_role
│   │   ├── data.ts                   — input validation, constraints, race conditions
│   │   ├── payment.ts                — webhook verification, price manipulation
│   │   ├── api.ts                    — HTTP methods, rate limiting, error leakage
│   │   ├── config.ts                 — hardcoded secrets, env separation, next.config
│   │   └── frontend.ts               — error boundaries, loading states, meta tags
│   ├── results/
│   │   ├── types.ts                  — Finding, CheckResult, EngineResult interfaces
│   │   └── collector.ts              — aggregates results, calculates health score
│   ├── utils/
│   │   ├── httpClient.ts             — fetch wrapper with timing
│   │   ├── supabaseClient.ts         — test user management, RLS checks
│   │   └── appStarter.ts             — npm install + build + start + port detection
│   ├── runner.ts                     — loads env vars, builds AppContext
│   └── index.ts                      — engine orchestrator
├── reporter/
│   └── diagnosis.ts                  — Markdown report builder, terminal summary
├── fixer/
│   ├── applier.ts                    — 9 fix templates
│   ├── diffDisplay.ts                — terminal diff renderer
│   ├── verifier.ts                   — build verification
│   └── index.ts                      — fix orchestrator
└── bin/
    └── qa-agent.ts                   — CLI (commander.js)
```

---

## Contributing

Issues and PRs are welcome.

```bash
git clone https://github.com/BassamAA/qa-agent
cd qa-agent  # (the repo is still called qa-agent on GitHub)
npm install
npm test          # 49 tests
npm run build     # compile TypeScript
```

When adding a new check:
1. Create/extend a check file in `src/engine/checks/`
2. Return `CheckResult[]` from your function
3. Register it in `src/engine/index.ts`
4. Add the finding type to `src/engine/results/types.ts` if needed

When adding a new auto-fix:
1. Add a case to `src/fixer/applier.ts`
2. Add the template name to the `FixTemplate` union type
3. Set `autoFixable: true` and `fixTemplate: 'yourTemplate'` in the finding

---

## License

MIT
