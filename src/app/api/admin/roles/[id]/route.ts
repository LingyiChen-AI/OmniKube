import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { roles, rolePermissions, roleClusterBindings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/logger';
import { isSuperAdmin } from '@/lib/auth/admin-check';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) return NextResponse.json({ error: '角色不存在' }, { status: 404 });

  const permissions = await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, id));
  const clusterBinds = await db.select().from(roleClusterBindings).where(eq(roleClusterBindings.roleId, id));

  return NextResponse.json({ ...role, permissions, clusterBindings: clusterBinds });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (!await isSuperAdmin(auth.user.id)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const { id } = await params;

  const [existing] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  if (existing.isSystem) return NextResponse.json({ error: '系统角色不可修改' }, { status: 403 });

  const { displayName, description, permissions, clusterBindings } = await req.json();

  await db.update(roles).set({
    displayName, description, updatedAt: new Date(),
  }).where(eq(roles.id, id));

  // Replace permissions
  if (permissions && Array.isArray(permissions)) {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    for (const perm of permissions) {
      await db.insert(rolePermissions).values({ roleId: id, resource: perm.resource, actions: perm.actions });
    }
  }

  // Replace cluster bindings
  if (clusterBindings && Array.isArray(clusterBindings)) {
    await db.delete(roleClusterBindings).where(eq(roleClusterBindings.roleId, id));
    for (const cb of clusterBindings) {
      await db.insert(roleClusterBindings).values({
        roleId: id,
        clusterId: cb.clusterId || null,
        namespaces: cb.namespaces && cb.namespaces.length > 0 ? cb.namespaces : null,
      });
    }
  }

  await writeAuditLog({
    userId: auth.user.id, action: 'update', resourceType: 'role',
    resourceName: existing.name, requestMethod: 'PUT',
    requestPath: `/api/admin/roles/${id}`, responseStatus: 200,
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (!await isSuperAdmin(auth.user.id)) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const { id } = await params;

  const [existing] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!existing) return NextResponse.json({ error: '角色不存在' }, { status: 404 });
  if (existing.isSystem) return NextResponse.json({ error: '系统角色不可删除' }, { status: 403 });

  await db.delete(roles).where(eq(roles.id, id));

  await writeAuditLog({
    userId: auth.user.id, action: 'delete', resourceType: 'role',
    resourceName: existing.name, requestMethod: 'DELETE',
    requestPath: `/api/admin/roles/${id}`, responseStatus: 200,
  });

  return NextResponse.json({ success: true });
}
