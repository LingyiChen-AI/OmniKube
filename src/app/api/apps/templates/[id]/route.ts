import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appTemplates } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [template] = await db.select().from(appTemplates).where(eq(appTemplates.id, id)).limit(1);
  if (!template) return NextResponse.json({ error: '模板不存在' }, { status: 404 });

  return NextResponse.json(template);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [existing] = await db.select().from(appTemplates).where(eq(appTemplates.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: '模板不存在' }, { status: 404 });

  const { description, template, variables } = await req.json();

  // Create new version
  const [newVersion] = await db.insert(appTemplates).values({
    name: existing.name,
    description: description ?? existing.description,
    template: template ?? existing.template,
    variables: variables ?? existing.variables,
    version: existing.version + 1,
    createdBy: auth.user.id,
  }).returning();

  await writeAuditLog({
    userId: auth.user.id,
    action: 'update',
    resourceType: 'app_template',
    resourceName: existing.name,
    requestMethod: 'PUT',
    requestPath: `/api/apps/templates/${id}`,
    responseStatus: 201,
  });

  return NextResponse.json(newVersion, { status: 201 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [deleted] = await db.delete(appTemplates).where(eq(appTemplates.id, id)).returning();

  if (deleted) {
    await writeAuditLog({
      userId: auth.user.id,
      action: 'delete',
      resourceType: 'app_template',
      resourceName: deleted.name,
      requestMethod: 'DELETE',
      requestPath: `/api/apps/templates/${id}`,
      responseStatus: 200,
    });
  }

  return NextResponse.json({ success: true });
}
