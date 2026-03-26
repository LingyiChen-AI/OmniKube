import { db } from '@/lib/db';
import { userRoleBindings, roles } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * 检查用户是否为超级管理员
 */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const bindings = await db
    .select({ roleName: roles.name })
    .from(userRoleBindings)
    .innerJoin(roles, eq(userRoleBindings.roleId, roles.id))
    .where(eq(userRoleBindings.userId, userId));

  return bindings.some(b => b.roleName === 'super-admin');
}
