import client from './client';
import { unwrapList } from './normalize';

/** A rule's scope: the whole cluster, or specific namespaces within it. */
export type RuleScope = 'cluster' | 'namespace';

/**
 * Tree action names, aligned with the backend permission tree.
 * `exec` only applies to pods, `reveal` only to secrets.
 */
export type TreeAction = 'view' | 'create' | 'edit' | 'delete' | 'exec' | 'reveal';

/** The base actions every resource supports. */
export const BASE_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete'];
/** All tree actions, in canonical display order. */
export const TREE_ACTIONS: TreeAction[] = ['view', 'create', 'edit', 'delete', 'exec', 'reveal'];

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
  for (const res of ALL_RESOURCES) {
    const acts = (ops[res] ?? []).filter((a) => actionAppliesToResource(res, a));
    if (acts.length) out[res] = TREE_ACTIONS.filter((a) => acts.includes(a));
  }
  return out;
}

/** Global permission areas (platform-level, not per-cluster). */
export type GlobalArea = 'clusters' | 'users' | 'roles' | 'releases' | 'audit';

/** View-only global areas (no create/edit/delete). */
export const VIEW_ONLY_AREAS: GlobalArea[] = ['releases', 'audit'];

/** The system-management areas (each supports view/create/edit/delete). */
export const SYSTEM_AREAS: Exclude<GlobalArea, 'releases' | 'audit'>[] = ['clusters', 'users', 'roles'];
export const GLOBAL_AREAS: GlobalArea[] = ['clusters', 'users', 'roles', 'releases', 'audit'];

/** Actions applicable to a global area (`releases`/`audit` are view-only). */
export function actionsForGlobalArea(area: GlobalArea): TreeAction[] {
  return VIEW_ONLY_AREAS.includes(area) ? ['view'] : BASE_ACTIONS;
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
  for (const res of ALL_RESOURCES) {
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

export const roleApi = {
  list: () => client.get('/roles').then((r) => unwrapList<RoleView>(r.data)),

  get: (id: number) => client.get<RoleView>(`/roles/${id}`).then((r) => r.data),

  create: (payload: RolePayload) =>
    client.post<RoleView>('/roles', payload).then((r) => r.data),

  update: (id: number, payload: RolePayload) =>
    client.put<RoleView>(`/roles/${id}`, payload).then((r) => r.data),

  remove: (id: number) => client.delete(`/roles/${id}`).then((r) => r.data),
};
