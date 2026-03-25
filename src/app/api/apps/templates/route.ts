import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appTemplates } from '@/lib/db/schema';
import { validateSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/logger';
import { desc } from 'drizzle-orm';

export async function GET() {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const list = await db.select().from(appTemplates).orderBy(desc(appTemplates.createdAt));
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { name, description, template, variables } = await req.json();

  const [created] = await db.insert(appTemplates).values({
    name,
    description,
    template,
    variables,
    version: 1,
    createdBy: auth.user.id,
  }).returning();

  await writeAuditLog({
    userId: auth.user.id,
    action: 'create',
    resourceType: 'app_template',
    resourceName: name,
    requestMethod: 'POST',
    requestPath: '/api/apps/templates',
    responseStatus: 201,
  });

  return NextResponse.json(created, { status: 201 });
}
