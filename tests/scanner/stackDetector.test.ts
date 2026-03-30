import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { detectStack } from '../../src/scanner/stackDetector.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-nextjs');

describe('stackDetector', () => {
  let stack: ReturnType<typeof detectStack>;

  // Run once — detectStack is synchronous
  stack = detectStack(FIXTURE);

  it('detects typescript as primary language', () => {
    expect(stack.primaryLanguage).toBe('typescript');
  });

  it('detects nextjs framework', () => {
    expect(stack.framework).toBe('nextjs');
  });

  it('detects prisma as ORM', () => {
    expect(stack.orm).toBe('prisma');
  });

  it('detects nextauth as auth library', () => {
    expect(stack.authLibrary).toBe('nextauth');
  });

  it('detects stripe as payment library', () => {
    expect(stack.paymentLibrary).toBe('stripe');
  });

  it('detects supabase in databases', () => {
    expect(stack.databases).toContain('supabase');
  });

  it('detects vitest as test framework', () => {
    expect(stack.testFramework).toBe('vitest');
  });

  it('has dependencies object', () => {
    expect(stack.dependencies).toBeDefined();
    expect(typeof stack.dependencies).toBe('object');
    expect(stack.dependencies['next']).toBeDefined();
  });

  it('has devDependencies object', () => {
    expect(stack.devDependencies).toBeDefined();
    expect(stack.devDependencies['vitest']).toBeDefined();
  });

  it('detects package manager', () => {
    // fixture has no lock file, will be unknown
    expect(stack.packageManager).toBeDefined();
  });
});
