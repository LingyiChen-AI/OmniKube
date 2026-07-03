import {
  MODULE_KEYS,
  MODULE_RESOURCES,
  type GlobalArea,
  type ModuleKey,
  type ResourceKey,
} from './api/role';

/** The minimal user shape the nav helpers read from /me. */
export type NavUser = {
  is_admin?: boolean;
  nav?: { submenus?: string[] };
  global?: Record<string, string[]>;
} | null | undefined;

/** Route a concrete resource submenu links to in the sidebar. */
export const RESOURCE_ROUTE: Record<ResourceKey, string> = {
  deployments: '/workloads/deployments',
  statefulsets: '/workloads/statefulsets',
  daemonsets: '/workloads/daemonsets',
  pods: '/workloads/pods',
  jobs: '/workloads/jobs',
  cronjobs: '/workloads/cronjobs',
  services: '/networking/services',
  ingresses: '/networking/ingresses',
  configmaps: '/storage/configmaps',
  secrets: '/storage/secrets',
  persistentvolumeclaims: '/storage/pvcs',
  persistentvolumes: '/storage/persistentvolumes',
  nodes: '/cluster/nodes',
};

/** Dashboard is always visible (fixed, not gated by nav/global). */
export const DASHBOARD_ROUTE = '/dashboard';

/** Whether the user may view a concrete resource submenu. */
export function canSeeResource(resource: string, user: NavUser): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return (user.nav?.submenus ?? []).includes(resource);
}

/** Whether a display module is visible (any of its resource submenus is). */
export function canSeeModule(module: ModuleKey, user: NavUser): boolean {
  return MODULE_RESOURCES[module].some((r) => canSeeResource(r, user));
}

/** Whether the user has a given action on a global (platform-level) area. */
export function canGlobal(area: GlobalArea, action: string, user: NavUser): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return (user.global?.[area] ?? []).includes(action);
}

/** Whether the system-management parent menu should be shown. */
export function canSeeSystem(user: NavUser): boolean {
  return (
    canGlobal('clusters', 'view', user) ||
    canGlobal('users', 'view', user) ||
    canGlobal('roles', 'view', user) ||
    canGlobal('ai', 'view', user) ||
    canGlobal('audit', 'view', user)
  );
}

/**
 * The landing route for a freshly authenticated user. Dashboard is always
 * visible, so it is the universal fallback.
 */
export function firstAllowedRoute(user: NavUser): string {
  void user;
  return DASHBOARD_ROUTE;
}

/** The visible concrete resources, in canonical order. */
export function visibleResources(user: NavUser): ResourceKey[] {
  return MODULE_KEYS.flatMap((m) => MODULE_RESOURCES[m]).filter((r) => canSeeResource(r, user));
}
