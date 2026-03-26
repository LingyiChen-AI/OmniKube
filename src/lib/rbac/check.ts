import { db } from '@/lib/db';
import { userRoleBindings, rolePermissions, roleClusterBindings } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';

export interface Permission { resource: string; actions: string[]; }
export interface RoleBinding {
  roleId: string;
  clusterId: string | null;
  namespaces: string[] | null;
  permissions: Permission[];
}
export interface PermissionContext {
  clusterId: string; namespace: string; resource: string; action: string;
}

function bindingMatchesContext(binding: RoleBinding, ctx: PermissionContext): boolean {
  // clusterId=null means all clusters
  if (binding.clusterId !== null && binding.clusterId !== ctx.clusterId) return false;
  // namespaces=null/empty means all namespaces
  if (binding.namespaces && binding.namespaces.length > 0 && ctx.namespace !== '*') {
    if (!binding.namespaces.includes(ctx.namespace)) return false;
  }
  return true;
}

export function checkPermission(bindings: RoleBinding[], ctx: PermissionContext): boolean {
  // 列出命名空间是导航功能：只要用户对该集群有任何绑定就放行
  if (ctx.resource === 'namespaces' && (ctx.action === 'get' || ctx.action === 'list')) {
    for (const binding of bindings) {
      if (binding.clusterId === null || binding.clusterId === ctx.clusterId) {
        return true;
      }
    }
  }

  const matchingPermissions: Permission[] = [];
  for (const binding of bindings) {
    if (bindingMatchesContext(binding, ctx)) {
      matchingPermissions.push(...binding.permissions);
    }
  }
  for (const perm of matchingPermissions) {
    const resourceMatch = perm.resource === '*' || perm.resource === ctx.resource;
    const actionMatch = perm.actions.includes('*') || perm.actions.includes(ctx.action);
    if (resourceMatch && actionMatch) return true;
  }
  return false;
}

/**
 * 获取用户可访问的集群 ID 列表
 * 返回 null 表示全局权限（可访问所有集群）
 * 返回 string[] 表示只能访问这些集群
 */
export async function getUserAccessibleClusterIds(userId: string): Promise<string[] | null> {
  // 1. 获取用户绑定的所有 roleId
  const userBindings = await db
    .select({ roleId: userRoleBindings.roleId })
    .from(userRoleBindings)
    .where(eq(userRoleBindings.userId, userId));

  if (userBindings.length === 0) return [];

  const roleIds = userBindings.map(b => b.roleId);

  // 2. 获取这些角色的集群绑定
  const clusterBinds = await db
    .select({ roleId: roleClusterBindings.roleId, clusterId: roleClusterBindings.clusterId })
    .from(roleClusterBindings)
    .where(inArray(roleClusterBindings.roleId, roleIds));

  // 3. 如果任一角色没有 clusterBindings 行 = 全局权限
  const rolesWithBindings = new Set(clusterBinds.map(b => b.roleId));
  if (roleIds.some(id => !rolesWithBindings.has(id))) return null;

  // 4. 如果任一 binding 的 clusterId=null = 全局权限
  if (clusterBinds.some(b => b.clusterId === null)) return null;

  // 5. 返回去重的 clusterIds
  return [...new Set(clusterBinds.map(b => b.clusterId!))];
}

/**
 * 获取用户在指定集群下可访问的命名空间列表
 * 返回 null 表示可访问所有命名空间
 * 返回 string[] 表示只能访问这些命名空间
 */
export async function getUserAccessibleNamespaces(userId: string, clusterId: string): Promise<string[] | null> {
  const bindings = await getUserBindings(userId);

  const allNamespaces: string[] = [];
  for (const binding of bindings) {
    // 检查这个 binding 是否适用于此集群
    if (binding.clusterId !== null && binding.clusterId !== clusterId) continue;
    // binding 匹配此集群
    if (!binding.namespaces || binding.namespaces.length === 0) {
      return null; // 该绑定对此集群的所有命名空间有效
    }
    allNamespaces.push(...binding.namespaces);
  }

  if (allNamespaces.length === 0) return null; // 没有匹配的绑定，可能是全局角色
  return [...new Set(allNamespaces)];
}

/**
 * 获取用户的所有角色绑定（含权限和集群范围）
 */
export async function getUserBindings(userId: string): Promise<RoleBinding[]> {
  // 1. 获取用户绑定的角色
  const userBinds = await db
    .select({ roleId: userRoleBindings.roleId })
    .from(userRoleBindings)
    .where(eq(userRoleBindings.userId, userId));

  if (userBinds.length === 0) return [];

  const roleIds = userBinds.map(b => b.roleId);

  // 2. 获取角色的集群绑定
  const clusterBinds = await db
    .select({
      roleId: roleClusterBindings.roleId,
      clusterId: roleClusterBindings.clusterId,
      namespaces: roleClusterBindings.namespaces,
    })
    .from(roleClusterBindings)
    .where(inArray(roleClusterBindings.roleId, roleIds));

  // 3. 获取角色的资源权限
  const perms = await db
    .select({
      roleId: rolePermissions.roleId,
      resource: rolePermissions.resource,
      actions: rolePermissions.actions,
    })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, roleIds));

  // 4. 按 roleId 分组权限
  const permsByRole = new Map<string, Permission[]>();
  for (const p of perms) {
    if (!permsByRole.has(p.roleId)) permsByRole.set(p.roleId, []);
    permsByRole.get(p.roleId)!.push({ resource: p.resource, actions: p.actions as string[] });
  }

  // 5. 构建 RoleBinding 数组
  const result: RoleBinding[] = [];

  for (const roleId of roleIds) {
    const permissions = permsByRole.get(roleId) || [];
    const roleClusters = clusterBinds.filter(b => b.roleId === roleId);

    if (roleClusters.length === 0) {
      // 无集群绑定 = 全局权限
      result.push({ roleId, clusterId: null, namespaces: null, permissions });
    } else {
      for (const cb of roleClusters) {
        result.push({
          roleId,
          clusterId: cb.clusterId,
          namespaces: cb.namespaces as string[] | null,
          permissions,
        });
      }
    }
  }

  return result;
}
