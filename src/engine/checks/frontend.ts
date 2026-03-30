import * as fs from 'fs';
import * as path from 'path';
import type { AppContext, Finding, CheckResult } from '../results/types.js';
import { makeId } from './helpers.js';

export async function runFrontendChecks(ctx: AppContext): Promise<CheckResult[]> {
  return Promise.all([
    checkErrorBoundaries(ctx),
    checkLoadingStates(ctx),
    checkEmptyStates(ctx),
    checkMetaTags(ctx),
    checkAccessibility(ctx),
  ]);
}

// ─── Check: Error Boundaries ──────────────────────────────────────────────────

async function checkErrorBoundaries(ctx: AppContext): Promise<CheckResult> {
  const name = 'error-boundaries';
  const start = Date.now();
  const findings: Finding[] = [];

  // In Next.js App Router, error boundaries are error.tsx files
  const appDir = path.join(ctx.rootDir, 'app');
  if (!fs.existsSync(appDir)) {
    return { name, category: 'frontend', status: 'skipped', findings, duration: Date.now() - start };
  }

  const routeSegments = getRouteSegments(appDir);
  const missingErrorPages: string[] = [];

  for (const segment of routeSegments) {
    const hasError =
      fs.existsSync(path.join(segment, 'error.tsx')) ||
      fs.existsSync(path.join(segment, 'error.jsx')) ||
      fs.existsSync(path.join(segment, 'error.js'));

    if (!hasError) {
      const rel = path.relative(ctx.rootDir, segment);
      missingErrorPages.push(rel);
    }
  }

  if (missingErrorPages.length > 0) {
    findings.push({
      id: makeId('frontend', 'error-boundaries'),
      category: 'frontend',
      severity: 'medium',
      title: `${missingErrorPages.length} route segment(s) missing error.tsx`,
      description: `These route segments have no error boundary: ${missingErrorPages.slice(0, 5).join(', ')}${missingErrorPages.length > 5 ? '...' : ''}. If a component in these segments throws, the entire page crashes with a generic Next.js error page.`,
      evidence: `Segments without error.tsx: ${missingErrorPages.join(', ')}`,
      impact: `Unhandled rendering errors show users a broken white page with "Application error" message. Error boundaries catch exceptions and show a friendly message with a retry option.`,
      fix: `Create error.tsx in each route segment:\n\n'use client';\nexport default function Error({ error, reset }: { error: Error; reset: () => void }) {\n  return (\n    <div>\n      <h2>Something went wrong</h2>\n      <button onClick={reset}>Try again</button>\n    </div>\n  );\n}`,
      autoFixable: true,
      fixTemplate: 'addErrorBoundary',
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  // Also check for React class-based error boundaries wrapping critical components
  const componentFiles = findComponentFiles(ctx.rootDir);
  let hasAnyErrorBoundary = false;
  for (const file of componentFiles) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (/componentDidCatch|ErrorBoundary/.test(content)) {
      hasAnyErrorBoundary = true;
      break;
    }
  }

  if (!hasAnyErrorBoundary && routeSegments.length === 0) {
    findings.push({
      id: makeId('frontend', 'no-error-boundary'),
      category: 'frontend',
      severity: 'medium',
      title: `No error boundaries detected in the application`,
      description: `No React error boundaries (componentDidCatch or ErrorBoundary) were found. Rendering errors will propagate to the root and crash the entire application.`,
      evidence: `No componentDidCatch or ErrorBoundary pattern found in component files`,
      impact: `Any component that throws during render crashes the whole app, showing a blank page to the user.`,
      fix: `Wrap your app's main sections with error boundaries to isolate failures.`,
      autoFixable: false,
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  return { name, category: 'frontend', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Loading States ────────────────────────────────────────────────────

async function checkLoadingStates(ctx: AppContext): Promise<CheckResult> {
  const name = 'loading-states';
  const start = Date.now();
  const findings: Finding[] = [];

  const appDir = path.join(ctx.rootDir, 'app');
  if (!fs.existsSync(appDir)) {
    return { name, category: 'frontend', status: 'skipped', findings, duration: Date.now() - start };
  }

  const routeSegments = getRouteSegments(appDir);
  const missingLoading: string[] = [];

  for (const segment of routeSegments) {
    const hasPage =
      fs.existsSync(path.join(segment, 'page.tsx')) ||
      fs.existsSync(path.join(segment, 'page.jsx'));
    const hasLoading =
      fs.existsSync(path.join(segment, 'loading.tsx')) ||
      fs.existsSync(path.join(segment, 'loading.jsx'));

    if (hasPage && !hasLoading) {
      const rel = path.relative(ctx.rootDir, segment);
      // Only flag data-heavy routes (dashboard, settings, etc.)
      if (/dashboard|settings|profile|account|orders|admin/.test(rel)) {
        missingLoading.push(rel);
      }
    }
  }

  if (missingLoading.length > 0) {
    findings.push({
      id: makeId('frontend', 'loading-states'),
      category: 'frontend',
      severity: 'low',
      title: `${missingLoading.length} data-heavy page(s) missing loading.tsx`,
      description: `These pages fetch data but have no loading skeleton: ${missingLoading.join(', ')}. Users see blank content until the server responds.`,
      evidence: `Pages with no loading.tsx: ${missingLoading.join(', ')}`,
      impact: `Without a loading state, users see content flash or blank screens. This is especially jarring on slow connections or for large data sets.`,
      fix: `Create loading.tsx in each affected route:\n\nexport default function Loading() {\n  return <div className="animate-pulse">Loading...</div>;\n}`,
      autoFixable: true,
      fixTemplate: 'addLoadingState',
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  }

  return { name, category: 'frontend', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Empty States ──────────────────────────────────────────────────────

async function checkEmptyStates(ctx: AppContext): Promise<CheckResult> {
  const name = 'empty-states';
  const start = Date.now();
  const findings: Finding[] = [];

  const componentFiles = findComponentFiles(ctx.rootDir);

  for (const file of componentFiles.slice(0, 30)) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Look for array .map() rendering without empty state handling
    const mapRe = /(\w+)\.map\s*\(/g;
    let match: RegExpExecArray | null;
    let mapCount = 0;
    while ((match = mapRe.exec(content)) !== null) {
      mapCount++;
      const varName = match[1];
      // Check if there's a length check or empty state nearby
      const surrounding = content.slice(Math.max(0, match.index - 200), match.index + 200);
      const hasEmptyCheck =
        new RegExp(`${varName}\\.length\\s*===?\\s*0`).test(surrounding) ||
        new RegExp(`!${varName}\\?.length`).test(surrounding) ||
        new RegExp(`${varName}\\.length\\s*>\\s*0`).test(surrounding) ||
        /empty|no\s+\w+\s+found|nothing/i.test(surrounding);

      if (!hasEmptyCheck && mapCount <= 3) {
        findings.push({
          id: makeId('frontend', `empty-state-${rel}`),
          category: 'frontend',
          severity: 'low',
          title: `List rendering without empty state in ${rel}`,
          description: `${rel} renders a list using .map() but doesn't appear to handle the empty array case. New users or filtered views may see a blank space with no explanation.`,
          evidence: `${rel}: ${varName}.map() without empty state check`,
          impact: `New users see blank pages instead of helpful empty states. This hurts activation and makes the app feel broken.`,
          fix: `Add an empty state:\n\n{${varName}.length === 0 ? (\n  <EmptyState message="No items yet" />\n) : (\n  ${varName}.map((item) => <Item key={item.id} {...item} />)\n)}`,
          file: rel,
          autoFixable: false,
          checkName: name,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }

  return { name, category: 'frontend', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Meta Tags ─────────────────────────────────────────────────────────

async function checkMetaTags(ctx: AppContext): Promise<CheckResult> {
  const name = 'meta-tags';
  const start = Date.now();
  const findings: Finding[] = [];

  // In Next.js App Router, metadata is defined in layout.tsx or page.tsx
  const rootLayout = tryReadFile(path.join(ctx.rootDir, 'app', 'layout.tsx')) ??
                     tryReadFile(path.join(ctx.rootDir, 'app', 'layout.jsx'));

  if (!rootLayout) {
    return { name, category: 'frontend', status: 'skipped', findings, duration: Date.now() - start };
  }

  const hasMetadata = /export\s+const\s+metadata/.test(rootLayout) || /generateMetadata/.test(rootLayout);
  const hasOGImage = /openGraph|og:image|opengraph-image/.test(rootLayout);
  const hasTitle = /title\s*:/.test(rootLayout);
  const hasDescription = /description\s*:/.test(rootLayout);

  if (!hasMetadata) {
    findings.push({
      id: makeId('frontend', 'no-metadata'),
      category: 'frontend',
      severity: 'low',
      title: `Root layout missing Next.js metadata export`,
      description: `app/layout.tsx does not export a metadata object. Without it, your pages have no title, description, or OG tags — hurting SEO and social sharing.`,
      evidence: `No "export const metadata" or "generateMetadata" found in app/layout.tsx`,
      impact: `Pages appear as "Untitled" in browser tabs and search results. Social sharing shows no preview card. Search engines have nothing to index.`,
      fix: `Add metadata to app/layout.tsx:\n\nexport const metadata = {\n  title: 'Your App Name',\n  description: 'What your app does',\n  openGraph: {\n    title: 'Your App Name',\n    description: 'What your app does',\n    images: ['/og-image.png'],\n  }\n};`,
      file: 'app/layout.tsx',
      autoFixable: true,
      fixTemplate: 'addMetaTags',
      checkName: name,
      timestamp: new Date().toISOString(),
    });
  } else {
    if (!hasTitle) {
      findings.push({
        id: makeId('frontend', 'missing-title'),
        category: 'frontend',
        severity: 'low',
        title: `Metadata object missing title`,
        description: `The metadata export in app/layout.tsx does not include a title property.`,
        evidence: `metadata export found without title: in app/layout.tsx`,
        impact: `Browser tabs and search results show no meaningful title for your site.`,
        fix: `Add title to your metadata: export const metadata = { title: 'Your App Name', ... }`,
        file: 'app/layout.tsx',
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
    if (!hasDescription) {
      findings.push({
        id: makeId('frontend', 'missing-description'),
        category: 'frontend',
        severity: 'low',
        title: `Metadata object missing description`,
        description: `The metadata export in app/layout.tsx does not include a description property. Search engines use this for result snippets.`,
        evidence: `metadata export found without description: in app/layout.tsx`,
        impact: `Search engines generate their own description, often pulling awkward text from the page.`,
        fix: `Add description: export const metadata = { description: 'A clear description of your app', ... }`,
        file: 'app/layout.tsx',
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
    if (!hasOGImage) {
      findings.push({
        id: makeId('frontend', 'missing-og-image'),
        category: 'frontend',
        severity: 'low',
        title: `Missing Open Graph image`,
        description: `No OG image is configured. Social media previews will show no image when your URL is shared.`,
        evidence: `No openGraph.images or opengraph-image found`,
        impact: `Links shared on Twitter, LinkedIn, Slack, etc. show no preview image, resulting in much lower click-through rates.`,
        fix: `Add an OG image:\n1. Add /public/og-image.png (1200x630px)\n2. In metadata: openGraph: { images: [{ url: '/og-image.png', width: 1200, height: 630 }] }`,
        file: 'app/layout.tsx',
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  void hasOGImage;

  return { name, category: 'frontend', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Check: Accessibility ─────────────────────────────────────────────────────

async function checkAccessibility(ctx: AppContext): Promise<CheckResult> {
  const name = 'accessibility';
  const start = Date.now();
  const findings: Finding[] = [];

  const componentFiles = findComponentFiles(ctx.rootDir);

  for (const file of componentFiles.slice(0, 20)) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = path.relative(ctx.rootDir, file);

    // Check for images without alt text
    const imgNoAlt = /<img(?![^>]*alt=)[^>]*/g;
    if (imgNoAlt.test(content)) {
      findings.push({
        id: makeId('frontend', `img-alt-${rel}`),
        category: 'frontend',
        severity: 'low',
        title: `Image without alt text in ${rel}`,
        description: `${rel} contains an <img> tag without an alt attribute. Screen readers cannot describe the image to visually impaired users.`,
        evidence: `<img> without alt= found in ${rel}`,
        impact: `Screen reader users get no context for images. Also hurts SEO image indexing.`,
        fix: `Add alt text to all images:\n<img src="..." alt="Descriptive text about the image" />\nFor decorative images: alt=""`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }

    // Buttons with no accessible text
    const buttonNoText = /<button(?![^>]*aria-label)[^>]*>\s*<(?:svg|img)/g;
    if (buttonNoText.test(content)) {
      findings.push({
        id: makeId('frontend', `btn-label-${rel}`),
        category: 'frontend',
        severity: 'low',
        title: `Icon button missing accessible label in ${rel}`,
        description: `${rel} has a button containing only an icon (SVG/image) with no aria-label. Screen readers announce these as just "button" with no context.`,
        evidence: `<button> with only icon child and no aria-label in ${rel}`,
        impact: `Screen reader users cannot determine the purpose of icon-only buttons (close, delete, etc.).`,
        fix: `Add aria-label to icon buttons:\n<button aria-label="Close dialog"><XIcon /></button>`,
        file: rel,
        autoFixable: false,
        checkName: name,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { name, category: 'frontend', status: findings.length > 0 ? 'failed' : 'passed', findings, duration: Date.now() - start };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRouteSegments(appDir: string): string[] {
  const segments: string[] = [];
  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasPage = entries.some((e) => /^page\.[tj]sx?$/.test(e.name));
      if (hasPage) segments.push(dir);
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')) {
          walk(path.join(dir, e.name));
        }
      }
    } catch { /* skip */ }
  }
  walk(appDir);
  return segments;
}

function findComponentFiles(rootDir: string): string[] {
  const results: string[] = [];
  const dirs = ['components', 'app', 'pages', 'src/components', 'src/app'];
  for (const dir of dirs) {
    walkForTsx(path.join(rootDir, dir), results);
  }
  return results;
}

function walkForTsx(dir: string, results: string[]): void {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next', 'dist', 'build'].includes(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walkForTsx(fp, results);
      else if (/\.(tsx|jsx)$/.test(e.name)) results.push(fp);
    }
  } catch { /* skip */ }
}

function tryReadFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}
