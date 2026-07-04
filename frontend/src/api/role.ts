import client from './client';
import { unwrapList } from './normalize';

/** A rule's scope: the whole cluster, or specific namespaces within it. */
export type RuleScope = 'cluster' | 'namespace';

/**
 * Tree action names, aligned with the backend permission tree.
 * `exec` only applies to pods, `reveal` only to secrets.
 */
export type TreeAction = 'view' | 'create' | 'edit' | 'delete' | 'exec' | 'reveal' | 'publish';

/** The base actions every resource supports. */
export const BASE_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete'];
/** All tree actions, in canonical display order. */
export const TREE_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete', 'exec', 'reveal', 'publish'];
/** Columns shown in the GLOBAL permission matrix. Includes `publish` (only the
 *  integrated_deploy area uses it); non-applicable cells render greyed/disabled. */
export const GLOBAL_MATRIX_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete', 'publish'];

/** Concrete k8s resources, grouped by display module. */
export type ModuleKey = 'workloads' | 'networking' | 'storage' | 'nodes';

/** A concrete resource submenu (k8s plural), as used by /me nav + capabilities. */
export type ResourceKey =
  | 'deployments'
  | 'statefulsets'
  | 'daemonsets'
  | 'pods'
  | 'jobs'
  | 'cronjobs'
  | 'services'
  | 'ingresses'
  | 'configmaps'
  | 'secrets'
  | 'persistentvolumeclaims'
  | 'persistentvolumes'
  | 'nodes';

/** Display-module → concrete resource submenus (frontend-only grouping). */
export const MODULE_RESOURCES: Record<ModuleKey, ResourceKey[]> = {
  workloads: ['deployments', 'statefulsets', 'daemonsets', 'pods', 'jobs', 'cronjobs'],
  networking: ['services', 'ingresses'],
  storage: ['configmaps', 'secrets', 'persistentvolumeclaims', 'persistentvolumes'],
  nodes: ['nodes'],
};

export const MODULE_KEYS: ModuleKey[] = ['workloads', 'networking', 'storage', 'nodes'];

/** All concrete resources, in canonical order. */
export const ALL_RESOURCES: ResourceKey[] = MODULE_KEYS.flatMap((m) => MODULE_RESOURCES[m]);

/** 粗粒度伪资源:承载所有非内置资源(CRD 等)的权限。与后端 rbac.CustomResource 对齐。 */
export const CUSTOM_RESOURCE = 'customresources';

/** 判断是否为内置(有专页)的具体资源。 */
export function isBuiltinResource(resource: string): boolean {
  return (ALL_RESOURCES as string[]).includes(resource);
}

/** 角色资源矩阵要渲染/持久化的资源:内置资源 + customresources 行。 */
export const MATRIX_RESOURCES: string[] = [...ALL_RESOURCES, CUSTOM_RESOURCE];

/**
 * Cluster-scoped k8s resources (no namespace). A namespace-scoped rule cannot
 * grant these — access is evaluated at the cluster domain, which a
 * per-namespace rule never covers — so the role matrix disables them when the
 * rule scope is 指定命名空间, and any stale grants get stripped.
 */
export const CLUSTER_SCOPED_RESOURCES: readonly string[] = ['nodes', 'persistentvolumes'];

export function isClusterScopedResource(resource: string): boolean {
  return CLUSTER_SCOPED_RESOURCES.includes(resource);
}

/** Drop grants for cluster-scoped resources (used when a rule becomes namespace-scoped). */
export function stripClusterScopedOps(ops: Operations): Operations {
  const out: Operations = {};
  for (const [res, acts] of Object.entries(ops)) {
    if (!isClusterScopedResource(res)) out[res] = acts;
  }
  return out;
}

/** Resolve the module a concrete resource belongs to. */
export function moduleOfResource(resource: string): ModuleKey | undefined {
  return MODULE_KEYS.find((m) => (MODULE_RESOURCES[m] as string[]).includes(resource));
}

/**
 * Whether a (resource, action) cell is applicable:
 * - `exec` only applies to pods.
 * - `reveal` only applies to secrets.
 * - view/create/edit/delete apply to every resource.
 */
export function actionAppliesToResource(resource: string, action: TreeAction): boolean {
  if (action === 'exec') return resource === 'pods';
  if (action === 'reveal') return resource === 'secrets';
  if (action === 'publish') return false; // global-only, via actionsForGlobalArea('integrated_deploy')
  return true;
}

/** The applicable actions for a concrete resource, in canonical order. */
export function actionsForResource(resource: string): TreeAction[] {
  return TREE_ACTIONS.filter((a) => actionAppliesToResource(resource, a));
}

/** Per-resource operations matrix: resource → granted tree actions. */
export type Operations = Record<string, TreeAction[]>;

/** Drop empty resources and inapplicable actions from an operations matrix. */
export function cleanOperations(ops: Operations): Operations {
  const out: Operations = {};
  for (const res of MATRIX_RESOURCES) {
    const acts = (ops[res] ?? []).filter((a) => actionAppliesToResource(res, a));
    if (acts.length) out[res] = TREE_ACTIONS.filter((a) => acts.includes(a));
  }
  return out;
}

/** Global permission areas (platform-level, not per-cluster). */
export type GlobalArea = 'clusters' | 'users' | 'roles' | 'releases' | 'audit' | 'ai' | 'integrated_deploy';

/** View-only global areas (no create/edit/delete). */
export const VIEW_ONLY_AREAS: GlobalArea[] = ['releases', 'audit'];

/** The system-management areas (each supports view/create/edit/delete). */
export const SYSTEM_AREAS: Exclude<GlobalArea, 'releases' | 'audit'>[] = ['clusters', 'users', 'roles', 'ai'];
export const GLOBAL_AREAS: GlobalArea[] = ['clusters', 'users', 'roles', 'releases', 'audit', 'ai', 'integrated_deploy'];

/** Actions applicable to a global area (`releases`/`audit` are view-only; `ai` is view/edit; `integrated_deploy` adds `publish`). */
export function actionsForGlobalArea(area: GlobalArea): TreeAction[] {
  if (VIEW_ONLY_AREAS.includes(area)) return ['view'];
  // `ai`: view=查看配置, edit=编辑模型配置, create=启用/停用开关（单独授权）。
  if (area === 'ai') return ['view', 'edit', 'create'];
  if (area === 'integrated_deploy') return ['view', 'create', 'edit', 'delete', 'publish'];
  return BASE_ACTIONS;
}

/** Global permissions map: area → granted actions. */
export type GlobalPerms = Partial<Record<GlobalArea, TreeAction[]>>;

/** Drop empty areas and inapplicable actions from a global-perms map. */
export function cleanGlobalPerms(gp: GlobalPerms): GlobalPerms {
  const out: GlobalPerms = {};
  for (const area of GLOBAL_AREAS) {
    const allowed = actionsForGlobalArea(area);
    const acts = (gp[area] ?? []).filter((a) => allowed.includes(a));
    if (acts.length) out[area] = allowed.filter((a) => acts.includes(a));
  }
  return out;
}

/** Special cluster id meaning "all clusters" (only valid with cluster scope). */
export const ALL_CLUSTERS = '*';

// ---------------------------------------------------------------------------
// Tree <-> model mapping helpers (used by the hierarchical role editor trees).
// Leaf-action keys carry the data; parent (module/resource/area) keys are
// structural and derived automatically by the checkable Tree.
// ---------------------------------------------------------------------------

/** A resource-tree action leaf key, e.g. `a:pods:exec`. */
export function resActionKey(resource: string, action: TreeAction): string {
  return `a:${resource}:${action}`;
}
/** A resource-tree resource node key, e.g. `r:pods`. */
export function resNodeKey(resource: string): string {
  return `r:${resource}`;
}
/** A resource-tree module node key, e.g. `m:workloads`. */
export function moduleNodeKey(module: ModuleKey): string {
  return `m:${module}`;
}

/** Leaf-action keys representing an operations matrix (for Tree `checkedKeys`). */
export function operationsToCheckedKeys(operations: Operations): string[] {
  const keys: string[] = [];
  for (const res of MATRIX_RESOURCES) {
    for (const a of operations[res] ?? []) {
      if (actionAppliesToResource(res, a)) keys.push(resActionKey(res, a));
    }
  }
  return keys;
}

/** Rebuild an operations matrix from a Tree's checked keys (leaf keys only). */
export function checkedKeysToOperations(keys: (string | number)[]): Operations {
  const ops: Operations = {};
  for (const k of keys) {
    if (typeof k !== 'string' || !k.startsWith('a:')) continue;
    const [, resource, action] = k.split(':');
    if (!actionAppliesToResource(resource, action as TreeAction)) continue;
    (ops[resource] ??= []).push(action as TreeAction);
  }
  return cleanOperations(ops);
}

/** A global-perms area leaf key, e.g. `gp:clusters:edit`. */
export function globalActionKey(area: GlobalArea, action: TreeAction): string {
  return `gp:${area}:${action}`;
}
/** A global-perms area node key, e.g. `ga:clusters`. */
export function globalAreaKey(area: GlobalArea): string {
  return `ga:${area}`;
}

/** Leaf-action keys representing a global-perms map (for Tree `checkedKeys`). */
export function globalPermsToCheckedKeys(gp: GlobalPerms): string[] {
  const keys: string[] = [];
  for (const area of GLOBAL_AREAS) {
    const allowed = actionsForGlobalArea(area);
    for (const a of gp[area] ?? []) {
      if (allowed.includes(a)) keys.push(globalActionKey(area, a));
    }
  }
  return keys;
}

/** Rebuild a global-perms map from a Tree's checked keys (leaf keys only). */
export function checkedKeysToGlobalPerms(keys: (string | number)[]): GlobalPerms {
  const gp: GlobalPerms = {};
  for (const k of keys) {
    if (typeof k !== 'string' || !k.startsWith('gp:')) continue;
    const [, area, action] = k.split(':');
    const a = area as GlobalArea;
    if (!GLOBAL_AREAS.includes(a)) continue;
    if (!actionsForGlobalArea(a).includes(action as TreeAction)) continue;
    (gp[a] ??= []).push(action as TreeAction);
  }
  return cleanGlobalPerms(gp);
}

/** A lightweight role reference, as embedded in user views. */
export interface RoleRef {
  id: number;
  name: string;
  /** Stable preset key (e.g. "cluster-admin") for i18n; empty for custom roles. */
  key?: string;
}

/** One rule row as returned by the backend (single cluster, per-resource operations). */
export interface RoleRuleView {
  cluster_id: string;
  scope: RuleScope;
  namespaces: string[];
  operations: Operations;
}

/** A full role view: GET /roles returns `{ roles: RoleView[] }`. */
export interface RoleView {
  id: number;
  name: string;
  description: string;
  /** Stable preset key (e.g. "cluster-admin") for i18n; empty for custom roles. */
  key?: string;
  system: boolean;
  /** Global (platform-level) permissions granted by this role. */
  global_perms: GlobalPerms;
  rules: RoleRuleView[];
  user_count: number;
}

/** One rule in a create/update payload — a single cluster with per-resource operations. */
export interface RoleRulePayload {
  cluster_id: string;
  scope: RuleScope;
  namespaces: string[];
  operations: Operations;
}

export interface RolePayload {
  name: string;
  description: string;
  global_perms: GlobalPerms;
  rules: RoleRulePayload[];
}

export interface RoleListPagedParams {
  limit?: number;
  offset?: number;
}

export const roleApi = {
  list: () => client.get('/roles').then((r) => unwrapList<RoleView>(r.data)),

  /** Server-side paginated list, returning the page + total count. */
  listPaged: (params: RoleListPagedParams = {}) =>
    client
      .get<{ roles: RoleView[]; total: number }>('/roles', { params })
      .then((r) => ({ roles: r.data.roles ?? [], total: r.data.total ?? 0 })),

  get: (id: number) => client.get<RoleView>(`/roles/${id}`).then((r) => r.data),

  create: (payload: RolePayload) =>
    client.post<RoleView>('/roles', payload).then((r) => r.data),

  update: (id: number, payload: RolePayload) =>
    client.put<RoleView>(`/roles/${id}`, payload).then((r) => r.data),

  remove: (id: number) => client.delete(`/roles/${id}`).then((r) => r.data),
};
