import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appReleases } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [release] = await db.select().from(appReleases).where(eq(appReleases.id, id)).limit(1);
  if (!release) return NextResponse.json({ error: '发布记录不存在' }, { status: 404 });

  return NextResponse.json(release);
}
