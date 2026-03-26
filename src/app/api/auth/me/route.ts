import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { userRoleBindings, roles } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const auth = await validateSession();
  if (!auth) { return NextResponse.json({ error: '未登录' }, { status: 401 }); }

  // Check if user has super-admin role
  const bindings = await db
    .select({ roleName: roles.name })
    .from(userRoleBindings)
    .innerJoin(roles, eq(userRoleBindings.roleId, roles.id))
    .where(eq(userRoleBindings.userId, auth.user.id));

  const isSuperAdmin = bindings.some(b => b.roleName === 'super-admin');

  return NextResponse.json({
    id: auth.user.id, username: auth.user.username, email: auth.user.email,
    mustChangePassword: auth.user.mustChangePassword,
    wsToken: auth.session.token,
    isSuperAdmin,
  });
}
