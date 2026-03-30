import { NextResponse } from 'next/server';

// This route is intentionally missing auth — for testing purposes
export async function GET() {
  return NextResponse.json({ users: [] });
}
