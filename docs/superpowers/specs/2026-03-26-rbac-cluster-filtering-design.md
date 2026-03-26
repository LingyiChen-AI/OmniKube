# RBAC 集群级权限过滤修复

## 问题

用户绑定角色时可指定集群范围（`userRoleBindings.clusterId`），但系统中多个 API 和前端组件完全忽略了这个约束：

1. `/api/clusters` 返回所有集群，不按用户权限过滤
2. `/api/dashboard` 遍历所有集群聚合统计，不按用户权限过滤
3. `ClusterSelector` 展示所有集群
4. `/api/k8s/[clusterId]/logs/...` 完全没有权限检查
5. 前端无法知道用户可以访问哪些集群

## 目标

用户只能看到和操作自己有权限的集群。super-admin 看到全部。

## 设计

### 1. 新增 `getUserAccessibleClusterIds(userId)` 工具函数

位置：`src/lib/rbac/check.ts`

逻辑：
- 查询 `userRoleBindings` 中该用户的所有绑定
- 如果任一绑定 `clusterId = NULL`，返回 `null`（表示全局权限，可访问所有集群）
- 否则返回去重的 `clusterId[]`

```ts
export async function getUserAccessibleClusterIds(userId: string): Promise<string[] | null> {
  const bindings = await db
    .select({ clusterId: userRoleBindings.clusterId })
    .from(userRoleBindings)
    .where(eq(userRoleBindings.userId, userId));

  // 任一绑定 clusterId 为 null = 全局权限
  if (bindings.some(b => b.clusterId === null)) return null;

  // 返回去重的 clusterIds
  return [...new Set(bindings.map(b => b.clusterId!))];
}
```

返回值约定：
- `null` = 全局权限，不需要过滤
- `string[]` = 只能访问这些集群（可能为空数组）

### 2. 修改 `/api/clusters` GET

- 调用 `getUserAccessibleClusterIds(userId)`
- 如果返回 `null`，查询所有集群（不变）
- 如果返回 `string[]`，用 `WHERE id IN (...)` 过滤

注意：POST（创建集群）不受影响，创建权限由管理员控制。

### 3. 修改 `/api/dashboard` GET

- 同样调用 `getUserAccessibleClusterIds(userId)` 过滤集群列表
- 只统计用户可访问的集群的 Pods / Deployments / Events

### 4. 给 logs API 补权限检查

在 `/api/k8s/[clusterId]/logs/[namespace]/[pod]/route.ts` 中：
- 调用 `getUserBindings(userId)`
- 调用 `checkPermission(bindings, { clusterId, namespace, resource: 'pods', action: 'get' })`
- 无权限返回 403

### 5. 前端 ClusterSelector 自动过滤

`ClusterSelector` 已从 `/api/clusters` 获取集群列表。API 过滤后，前端自动只显示有权限的集群，无需额外改动。

### 6. 不需要改动的部分

- `/api/k8s/[clusterId]/[...resource]` — 已有 `checkPermission` 检查，无需修改
- `/api/rbac/check` — 已正确使用 `checkPermission` 校验集群+资源+操作
- 权限数据模型 — 结构合理，不需要改
- `usePermissions` hook — 已传 `clusterId`，配合后端过滤正确工作

## 涉及文件

| 文件 | 改动 |
|-----|------|
| `src/lib/rbac/check.ts` | 新增 `getUserAccessibleClusterIds()` |
| `src/app/api/clusters/route.ts` | GET 加集群过滤 |
| `src/app/api/dashboard/route.ts` | 加集群过滤 |
| `src/app/api/k8s/[clusterId]/logs/[namespace]/[pod]/route.ts` | 加权限检查 |
