import * as fs from 'fs';
import * as path from 'path';
import type {
  StackProfile,
  Language,
  Framework,
  ORM,
  Database,
  AuthLibrary,
  PaymentLibrary,
  TestFramework,
  BuildTool,
} from '../types/index.js';

// ─── Manifest Readers ─────────────────────────────────────────────────────────

interface PackageJSON {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  scripts?: Record<string, string>;
}

function readJSON<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Framework Detection ──────────────────────────────────────────────────────

function detectFrameworkFromDeps(deps: Record<string, string>): Framework {
  if ('next' in deps) return 'nextjs';
  if ('nuxt' in deps) return 'nuxtjs';
  if ('@remix-run/node' in deps || '@remix-run/react' in deps) return 'remix';
  if ('@nestjs/core' in deps) return 'nestjs';
  if ('fastify' in deps) return 'fastify';
  if ('koa' in deps) return 'koa';
  if ('@hapi/hapi' in deps) return 'hapi';
  if ('express' in deps) return 'express';
  return 'unknown';
}

function detectFrameworkFromPython(rootDir: string): Framework {
  const reqFiles = ['requirements.txt', 'requirements/base.txt', 'Pipfile'];
  for (const file of reqFiles) {
    const content = readFile(path.join(rootDir, file));
    if (!content) continue;
    if (/^django/im.test(content)) return 'django';
    if (/^flask/im.test(content)) return 'flask';
    if (/^fastapi/im.test(content)) return 'fastapi';
  }
  const pyprojectContent = readFile(path.join(rootDir, 'pyproject.toml'));
  if (pyprojectContent) {
    if (/django/i.test(pyprojectContent)) return 'django';
    if (/flask/i.test(pyprojectContent)) return 'flask';
    if (/fastapi/i.test(pyprojectContent)) return 'fastapi';
  }
  return 'unknown';
}

function detectFrameworkFromGo(rootDir: string): Framework {
  const gomod = readFile(path.join(rootDir, 'go.mod'));
  if (!gomod) return 'unknown';
  if (/github\.com\/gin-gonic\/gin/.test(gomod)) return 'gin';
  if (/github\.com\/labstack\/echo/.test(gomod)) return 'echo';
  return 'unknown';
}

function detectFrameworkFromRuby(rootDir: string): Framework {
  const gemfile = readFile(path.join(rootDir, 'Gemfile'));
  if (!gemfile) return 'unknown';
  if (/gem\s+['"]rails['"]/i.test(gemfile)) return 'rails';
  if (/gem\s+['"]sinatra['"]/i.test(gemfile)) return 'sinatra';
  return 'unknown';
}

// ─── ORM Detection ────────────────────────────────────────────────────────────

function detectORM(deps: Record<string, string>): ORM {
  if ('prisma' in deps || '@prisma/client' in deps) return 'prisma';
  if ('drizzle-orm' in deps) return 'drizzle';
  if ('typeorm' in deps) return 'typeorm';
  if ('sequelize' in deps) return 'sequelize';
  if ('mongoose' in deps) return 'mongoose';
  return 'none';
}

function detectORMFromPython(rootDir: string): ORM {
  const content = readFile(path.join(rootDir, 'requirements.txt')) ?? '';
  if (/^sqlalchemy/im.test(content)) return 'sqlalchemy';
  return 'none';
}

function detectORMFromRuby(rootDir: string): ORM {
  const gemfile = readFile(path.join(rootDir, 'Gemfile')) ?? '';
  if (/active_record|activerecord|rails/i.test(gemfile)) return 'activerecord';
  return 'none';
}

function detectORMFromGo(rootDir: string): ORM {
  const gomod = readFile(path.join(rootDir, 'go.mod')) ?? '';
  if (/gorm\.io\/gorm/.test(gomod)) return 'gorm';
  return 'none';
}

// ─── Database Detection ───────────────────────────────────────────────────────

function detectDatabases(deps: Record<string, string>, rootDir: string): Database[] {
  const dbs = new Set<Database>();

  // From npm deps
  if ('pg' in deps || '@neondatabase/serverless' in deps) dbs.add('postgresql');
  if ('neon' in deps || '@neondatabase/serverless' in deps) dbs.add('neon');
  if ('mysql2' in deps || 'mysql' in deps) dbs.add('mysql');
  if ('better-sqlite3' in deps || 'sqlite3' in deps) dbs.add('sqlite');
  if ('mongoose' in deps || 'mongodb' in deps) dbs.add('mongodb');
  if ('redis' in deps || 'ioredis' in deps) dbs.add('redis');
  if ('@supabase/supabase-js' in deps) dbs.add('supabase');
  if ('firebase' in deps || 'firebase-admin' in deps) dbs.add('firestore');

  // From prisma schema
  const prismaSchema = readFile(path.join(rootDir, 'prisma', 'schema.prisma'));
  if (prismaSchema) {
    if (/provider\s*=\s*["']postgresql["']/.test(prismaSchema)) dbs.add('postgresql');
    if (/provider\s*=\s*["']mysql["']/.test(prismaSchema)) dbs.add('mysql');
    if (/provider\s*=\s*["']sqlite["']/.test(prismaSchema)) dbs.add('sqlite');
    if (/provider\s*=\s*["']mongodb["']/.test(prismaSchema)) dbs.add('mongodb');
  }

  // From env files
  const envContent = readFile(path.join(rootDir, '.env.example')) ?? readFile(path.join(rootDir, '.env.local')) ?? '';
  if (/DATABASE_URL\s*=\s*postgresql/i.test(envContent)) dbs.add('postgresql');
  if (/DATABASE_URL\s*=\s*mysql/i.test(envContent)) dbs.add('mysql');
  if (/MONGODB_URI/i.test(envContent)) dbs.add('mongodb');

  return [...dbs];
}

// ─── Auth Library Detection ───────────────────────────────────────────────────

function detectAuth(deps: Record<string, string>): AuthLibrary {
  if ('next-auth' in deps || '@auth/core' in deps) return 'nextauth';
  if ('@clerk/nextjs' in deps || '@clerk/clerk-sdk-node' in deps) return 'clerk';
  if ('auth0' in deps || '@auth0/nextjs-auth0' in deps) return 'auth0';
  if ('passport' in deps) return 'passport';
  if ('@supabase/auth-helpers-nextjs' in deps || '@supabase/ssr' in deps) return 'supabase-auth';
  if ('firebase' in deps || 'firebase-admin' in deps) return 'firebase-auth';
  if ('lucia' in deps) return 'lucia';
  if ('better-auth' in deps) return 'better-auth';
  if ('jsonwebtoken' in deps || 'jose' in deps) return 'jwt';
  return 'none';
}

// ─── Payment Library Detection ────────────────────────────────────────────────

function detectPayment(deps: Record<string, string>): PaymentLibrary {
  if ('stripe' in deps) return 'stripe';
  if ('@paypal/checkout-server-sdk' in deps || 'paypal' in deps) return 'paypal';
  if ('braintree' in deps) return 'braintree';
  if ('square' in deps || 'squareup' in deps) return 'square';
  if ('razorpay' in deps) return 'razorpay';
  return 'none';
}

// ─── Test Framework Detection ─────────────────────────────────────────────────

function detectTestFramework(
  deps: Record<string, string>,
  rootDir: string,
  language: Language
): TestFramework {
  // JS/TS
  if ('vitest' in deps) return 'vitest';
  if ('jest' in deps || '@jest/core' in deps) return 'jest';
  if ('mocha' in deps) return 'mocha';
  if ('jasmine' in deps || 'jasmine-core' in deps) return 'jasmine';
  if ('ava' in deps) return 'ava';

  // Python
  if (language === 'python') {
    const reqContent = readFile(path.join(rootDir, 'requirements.txt')) ?? '';
    if (/^pytest/im.test(reqContent)) return 'pytest';
    if (/^unittest/im.test(reqContent)) return 'unittest';
    return 'pytest'; // default for Python
  }

  // Ruby
  if (language === 'ruby') {
    const gemfile = readFile(path.join(rootDir, 'Gemfile')) ?? '';
    if (/gem\s+['"]rspec['"]/i.test(gemfile)) return 'rspec';
    if (/gem\s+['"]minitest['"]/i.test(gemfile)) return 'minitest';
  }

  // Go
  if (language === 'go') return 'go-test';

  // Java
  if (language === 'java' || language === 'kotlin') {
    const buildGradle = readFile(path.join(rootDir, 'build.gradle')) ?? readFile(path.join(rootDir, 'build.gradle.kts')) ?? '';
    if (/junit/i.test(buildGradle)) return 'junit';
    const pomXml = readFile(path.join(rootDir, 'pom.xml')) ?? '';
    if (/junit/i.test(pomXml)) return 'junit';
  }

  // Rust
  if (language === 'rust') return 'cargo-test';

  return 'none';
}

// ─── Build Tool Detection ─────────────────────────────────────────────────────

function detectBuildTool(deps: Record<string, string>, scripts: Record<string, string>): BuildTool {
  if ('vite' in deps) return 'vite';
  if ('webpack' in deps || 'webpack-cli' in deps) return 'webpack';
  if ('esbuild' in deps) return 'esbuild';
  if ('rollup' in deps) return 'rollup';
  if ('turbopack' in deps) return 'turbopack';
  if ('typescript' in deps) return 'tsc';

  const scriptValues = Object.values(scripts).join(' ');
  if (/vite/.test(scriptValues)) return 'vite';
  if (/webpack/.test(scriptValues)) return 'webpack';
  if (/esbuild/.test(scriptValues)) return 'esbuild';

  return 'unknown';
}

// ─── Package Manager Detection ────────────────────────────────────────────────

type PackageManager = StackProfile['packageManager'];

function detectPackageManager(rootDir: string): PackageManager {
  if (fileExists(path.join(rootDir, 'bun.lockb'))) return 'bun';
  if (fileExists(path.join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fileExists(path.join(rootDir, 'yarn.lock'))) return 'yarn';
  if (fileExists(path.join(rootDir, 'package-lock.json'))) return 'npm';
  if (fileExists(path.join(rootDir, 'Cargo.toml'))) return 'cargo';
  if (fileExists(path.join(rootDir, 'go.mod'))) return 'go';
  if (fileExists(path.join(rootDir, 'Gemfile'))) return 'bundler';
  if (fileExists(path.join(rootDir, 'composer.json'))) return 'composer';
  if (fileExists(path.join(rootDir, 'pyproject.toml'))) return 'poetry';
  if (fileExists(path.join(rootDir, 'requirements.txt'))) return 'pip';
  if (fileExists(path.join(rootDir, 'pom.xml'))) return 'maven';
  if (fileExists(path.join(rootDir, 'build.gradle')) || fileExists(path.join(rootDir, 'build.gradle.kts'))) return 'gradle';
  return 'unknown';
}

// ─── Primary Language Detection ───────────────────────────────────────────────

function detectPrimaryLanguage(rootDir: string): Language {
  if (fileExists(path.join(rootDir, 'package.json'))) {
    const tsconfig = fileExists(path.join(rootDir, 'tsconfig.json'));
    return tsconfig ? 'typescript' : 'javascript';
  }
  if (fileExists(path.join(rootDir, 'requirements.txt')) || fileExists(path.join(rootDir, 'pyproject.toml')) || fileExists(path.join(rootDir, 'Pipfile'))) {
    return 'python';
  }
  if (fileExists(path.join(rootDir, 'go.mod'))) return 'go';
  if (fileExists(path.join(rootDir, 'Gemfile'))) return 'ruby';
  if (fileExists(path.join(rootDir, 'pom.xml')) || fileExists(path.join(rootDir, 'build.gradle'))) return 'java';
  if (fileExists(path.join(rootDir, 'Cargo.toml'))) return 'rust';
  if (fileExists(path.join(rootDir, 'composer.json'))) return 'php';
  if (fileExists(path.join(rootDir, 'build.gradle.kts'))) return 'kotlin';
  return 'unknown';
}

// ─── Main Detector ────────────────────────────────────────────────────────────

export function detectStack(rootDir: string): StackProfile {
  const primaryLanguage = detectPrimaryLanguage(rootDir);
  const packageManager = detectPackageManager(rootDir);

  // Node.js / JavaScript / TypeScript path
  const pkgJsonPath = path.join(rootDir, 'package.json');
  const pkg = readJSON<PackageJSON>(pkgJsonPath);

  const allDeps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };
  const scripts = pkg?.scripts ?? {};

  let framework: Framework = 'unknown';
  let orm: ORM = 'unknown';
  let authLibrary: AuthLibrary = 'unknown';
  let paymentLibrary: PaymentLibrary = 'unknown';
  let testFramework: TestFramework = 'unknown';
  let buildTool: BuildTool = 'unknown';

  if (pkg) {
    framework = detectFrameworkFromDeps(allDeps);
    orm = detectORM(allDeps);
    authLibrary = detectAuth(allDeps);
    paymentLibrary = detectPayment(allDeps);
    testFramework = detectTestFramework(allDeps, rootDir, primaryLanguage);
    buildTool = detectBuildTool(allDeps, scripts);
  } else {
    switch (primaryLanguage) {
      case 'python':
        framework = detectFrameworkFromPython(rootDir);
        orm = detectORMFromPython(rootDir);
        testFramework = detectTestFramework({}, rootDir, primaryLanguage);
        break;
      case 'ruby':
        framework = detectFrameworkFromRuby(rootDir);
        orm = detectORMFromRuby(rootDir);
        testFramework = detectTestFramework({}, rootDir, primaryLanguage);
        break;
      case 'go':
        framework = detectFrameworkFromGo(rootDir);
        orm = detectORMFromGo(rootDir);
        testFramework = detectTestFramework({}, rootDir, primaryLanguage);
        break;
      case 'java':
      case 'kotlin':
        testFramework = detectTestFramework({}, rootDir, primaryLanguage);
        break;
      case 'rust':
        testFramework = 'cargo-test';
        break;
    }
    authLibrary = 'none';
    paymentLibrary = 'none';
    buildTool = 'unknown';
  }

  const databases = detectDatabases(allDeps, rootDir);

  return {
    primaryLanguage,
    framework,
    orm,
    databases,
    authLibrary,
    paymentLibrary,
    testFramework,
    buildTool,
    packageManager,
    dependencies: pkg?.dependencies ?? {},
    devDependencies: pkg?.devDependencies ?? {},
    runtimeVersion: pkg?.engines?.node,
  } satisfies StackProfile;
}
