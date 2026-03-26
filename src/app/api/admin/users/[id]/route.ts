import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users, userRoleBindings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/logger';
import { isSuperAdmin } from '@/lib/auth/admin-check';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [user] = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    isActive: users.isActive,
    mustChangePassword: users.mustChangePassword,
    lastLoginAt: users.lastLoginAt,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, id)).limit(1);

  if (!user) return NextResponse.json({ error: '用户不存在' }, { status: 404 });

  // Get role bindings
  const bindings = await db.select().from(userRoleBindings).where(eq(userRoleBindings.userId, id));

  return NextResponse.json({ ...user, roleBindings: bindings });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (!await isSuperAdmin(auth.user.id)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const { id } = await params;
  const body = await req.json();

  await db.update(users).set({
    email: body.email,
    isActive: body.isActive,
    updatedAt: new Date(),
  }).where(eq(users.id, id));

  // Update role binding
  if (body.roleId !== undefined) {
    await db.delete(userRoleBindings).where(eq(userRoleBindings.userId, id));
    if (body.roleId) {
      await db.insert(userRoleBindings).values({
        userId: id,
        roleId: body.roleId,
        createdBy: auth.user.id,
      });
    }
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'update',
    resourceType: 'user',
    resourceName: body.username,
    requestMethod: 'PUT',
    requestPath: `/api/admin/users/${id}`,
    responseStatus: 200,
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (!await isSuperAdmin(auth.user.id)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const { id } = await params;

  // Protect admin user from deletion
  const [target] = await db.select({ username: users.username }).from(users).where(eq(users.id, id)).limit(1);
  if (target?.username === 'admin') {
    return NextResponse.json({ error: '超级管理员账户不允许删除' }, { status: 403 });
  }

  const [deleted] = await db.delete(users).where(eq(users.id, id)).returning();

  if (deleted) {
    await writeAuditLog({
      userId: auth.user.id,
      action: 'delete',
      resourceType: 'user',
      resourceName: deleted.username,
      requestMethod: 'DELETE',
      requestPath: `/api/admin/users/${id}`,
      responseStatus: 200,
    });
  }

  return NextResponse.json({ success: true });
}
