import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppContext } from '../results/types.js';

// ─── Supabase Client Factory ──────────────────────────────────────────────────

export function createAnonClient(ctx: AppContext): SupabaseClient | null {
  if (!ctx.supabaseUrl || !ctx.supabaseAnonKey) return null;
  return createClient(ctx.supabaseUrl, ctx.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createServiceClient(ctx: AppContext): SupabaseClient | null {
  if (!ctx.supabaseUrl || !ctx.supabaseServiceRoleKey) return null;
  return createClient(ctx.supabaseUrl, ctx.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Test User Management ──────────────────────────────────────────────────────

const TEST_USER_EMAIL = `qa-agent-test-${Date.now()}@example.com`;
const TEST_USER_PASSWORD = `QaAgent!${Math.random().toString(36).slice(2)}Aa1`;

export interface TestUser {
  email: string;
  password: string;
  id: string;
  accessToken: string;
}

export async function createTestUser(ctx: AppContext): Promise<TestUser | null> {
  const serviceClient = createServiceClient(ctx);
  const anonClient = createAnonClient(ctx);
  if (!serviceClient || !anonClient) return null;

  try {
    // Create the user via admin API
    const { data: adminData, error: adminErr } = await serviceClient.auth.admin.createUser({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    });

    if (adminErr || !adminData.user) {
      console.error('[supabase] Failed to create test user:', adminErr?.message);
      return null;
    }

    // Sign in to get a token
    const { data: signInData, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
    });

    if (signInErr || !signInData.session) {
      console.error('[supabase] Failed to sign in test user:', signInErr?.message);
      await deleteTestUser(ctx, adminData.user.id);
      return null;
    }

    return {
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      id: adminData.user.id,
      accessToken: signInData.session.access_token,
    };
  } catch (err) {
    console.error('[supabase] Test user creation error:', err);
    return null;
  }
}

export async function deleteTestUser(ctx: AppContext, userId: string): Promise<void> {
  const serviceClient = createServiceClient(ctx);
  if (!serviceClient) return;

  try {
    await serviceClient.auth.admin.deleteUser(userId);
  } catch (err) {
    // Warn loudly — orphaned test users in the DB are a real problem
    process.stderr.write(
      `\n[bugscout] WARNING: Failed to delete test user ${userId} from Supabase. ` +
      `Please delete it manually in your Supabase dashboard (Authentication → Users).\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}\n\n`
    );
  }
}

// ─── RLS Checker ─────────────────────────────────────────────────────────────

export interface RLSCheckResult {
  table: string;
  rlsEnabled: boolean;
  anonCanRead: boolean;
  anonCanWrite: boolean;
  rowsReturned: number;
}

export async function checkTableRLS(
  ctx: AppContext,
  tableName: string
): Promise<RLSCheckResult | null> {
  const anonClient = createAnonClient(ctx);
  if (!anonClient) return null;

  try {
    // Attempt to read as anon
    const { data, error } = await anonClient
      .from(tableName)
      .select('*')
      .limit(5);

    const anonCanRead = !error && data !== null;
    const rowsReturned = data?.length ?? 0;

    // Attempt to insert junk row as anon
    const { error: insertError } = await anonClient
      .from(tableName)
      .insert({ _qa_test: true })
      .single();

    const anonCanWrite = !insertError;

    // Check RLS status via service role
    const serviceClient = createServiceClient(ctx);
    let rlsEnabled = true; // assume enabled unless we can prove otherwise
    if (serviceClient) {
      const { data: rlsData } = await serviceClient.rpc('pg_catalog.pg_tables', {});
      // If we got a pg query working, check RLS status
      // For now we infer: if anon can read unrestricted data, RLS is off
      if (anonCanRead && rowsReturned > 0) {
        rlsEnabled = false;
      }
      void rlsData;
    }

    return { table: tableName, rlsEnabled, anonCanRead, anonCanWrite, rowsReturned };
  } catch {
    return null;
  }
}

// ─── Schema Inspector ─────────────────────────────────────────────────────────

export interface ColumnInfo {
  column: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

export async function getTableSchema(
  ctx: AppContext,
  tableName: string
): Promise<ColumnInfo[]> {
  const serviceClient = createServiceClient(ctx);
  if (!serviceClient) return [];

  try {
    const { data, error } = await serviceClient
      .from('information_schema.columns')
      .select('column_name, data_type, is_nullable, column_default')
      .eq('table_name', tableName)
      .eq('table_schema', 'public');

    if (error || !data) return [];

    return data.map((col: Record<string, string | null>) => ({
      column: String(col['column_name'] ?? ''),
      type: String(col['data_type'] ?? ''),
      nullable: col['is_nullable'] === 'YES',
      hasDefault: col['column_default'] !== null,
    }));
  } catch {
    return [];
  }
}
