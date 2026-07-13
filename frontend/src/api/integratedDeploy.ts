import client from './client';
import { wsBase } from './ws';
import { getToken } from '../store/auth';

export type DeploySource = 'selected' | 'authored';
export type ItemPhase = 'created' | 'updated' | 'failed' | 'skipped';

export interface DeployItem {
  kind: string;
  name: string;
  source: DeploySource;
  manifest_yaml: string;
  sort_index: number;
  /**
   * resourceVersion of the live cluster object at snapshot time. Enables
   * optimistic-concurrency on publish so a stale snapshot can't silently
   * overwrite a concurrent change. Empty for legacy/authored items.
   */
  resource_version?: string;
}

export interface DeployOrder {
  id: number;
  user_id: number;
  username: string;
  cluster_id: string;
  namespace: string;
  title: string;
  description: string;
  items: DeployItem[];
  status: string; // draft | succeeded | failed
  created_at: string;
  updated_at: string;
}

export interface ItemResult {
  kind: string;
  name: string;
  phase: ItemPhase;
  message: string;
}

export interface DeployRun {
  id: number;
  user_id?: number;
  username: string;
  status: string;
  results: ItemResult[];
  created_at: string;
}

export interface DeployOrderInput {
  cluster_id: string;
  namespace: string;
  title: string;
  description: string;
  items: DeployItem[];
}

/** 允许进入工单的资源类型 → 发布组序(与后端 deployKindGroup 值一致)。 */
export const DEPLOY_KIND_GROUP: Record<string, number> = {
  secrets: 1, configmaps: 1, persistentvolumeclaims: 1,
  deployments: 2, statefulsets: 2, daemonsets: 2, jobs: 2, cronjobs: 2,
  services: 3, ingresses: 3,
};

export const DEPLOY_KINDS: string[] = Object.keys(DEPLOY_KIND_GROUP);

/** 固定发布顺序排序:先按组序,再按 sort_index。 */
export function orderedItems(items: DeployItem[]): DeployItem[] {
  return [...items].sort((a, b) => {
    const ga = DEPLOY_KIND_GROUP[a.kind] ?? 99;
    const gb = DEPLOY_KIND_GROUP[b.kind] ?? 99;
    return ga !== gb ? ga - gb : a.sort_index - b.sort_index;
  });
}

export const integratedDeployApi = {
  list: (clusterId?: string) =>
    client
      .get<{ orders: DeployOrder[] }>('/integrated-deploy/orders', {
        params: clusterId ? { cluster_id: clusterId } : undefined,
      })
      .then((r) => r.data.orders ?? []),
  /** Server-side paginated list (newest-updated first), returning the page + total count. */
  listPaged: (clusterId: string | undefined, limit: number, offset: number) =>
    client
      .get<{ orders: DeployOrder[]; total: number }>('/integrated-deploy/orders', {
        params: { cluster_id: clusterId || undefined, limit, offset },
      })
      .then((r) => ({ orders: r.data.orders ?? [], total: r.data.total ?? 0 })),
  get: (id: number) =>
    client
      .get<{ order: DeployOrder; runs: DeployRun[] }>(`/integrated-deploy/orders/${id}`)
      .then((r) => r.data),
  create: (body: DeployOrderInput) =>
    client.post<DeployOrder>('/integrated-deploy/orders', body).then((r) => r.data),
  update: (id: number, body: DeployOrderInput) =>
    client.put<DeployOrder>(`/integrated-deploy/orders/${id}`, body).then((r) => r.data),
  remove: (id: number) =>
    client.delete(`/integrated-deploy/orders/${id}`).then((r) => r.data),
  copy: (id: number) =>
    client.post<DeployOrder>(`/integrated-deploy/orders/${id}/copy`).then((r) => r.data),
  publish: (id: number) =>
    client
      .post<{ run: DeployRun }>(`/integrated-deploy/orders/${id}/publish`)
      .then((r) => r.data.run),
  // Namespace options for the editor, scoped to the SELECTED cluster (not the
  // global X-Cluster-ID header) so the order's cluster can differ from the topbar.
  namespaces: (clusterId: string) =>
    client
      .get<{ namespaces: string[] }>('/integrated-deploy/namespaces', {
        params: { cluster_id: clusterId },
      })
      .then((r) => r.data.namespaces ?? []),
  selectable: (clusterId: string, ns: string, kind: string) =>
    client
      .get<{ names: string[] }>('/integrated-deploy/selectable', {
        params: { cluster_id: clusterId, ns, kind },
      })
      .then((r) => r.data.names ?? []),
  /**
   * Snapshot a live cluster resource as YAML, plus its resourceVersion (for
   * later optimistic-concurrency on publish). resource_version may be '' if the
   * backend/cluster didn't provide one.
   */
  snapshot: (clusterId: string, ns: string, kind: string, name: string) =>
    client
      .get<{ manifest_yaml: string; resource_version?: string }>('/integrated-deploy/snapshot', {
        params: { cluster_id: clusterId, ns, kind, name },
      })
      .then((r) => ({
        manifest_yaml: r.data.manifest_yaml,
        resource_version: r.data.resource_version ?? '',
      })),
};

/** A single server → client frame from the `/integrated-deploy/publish` WebSocket. */
export interface PublishEvent {
  type: 'item' | 'done' | 'error';
  index?: number;
  total?: number;
  kind?: string;
  name?: string;
  phase?: 'running' | 'created' | 'updated' | 'failed' | 'skipped';
  message?: string;
  status?: string;
}

/**
 * Build the `/integrated-deploy/publish` WebSocket URL. Browsers can't set headers on a
 * WS handshake, so the JWT rides in the query string (same pattern as exec/logs/ai/chat);
 * `id` (the order id) is validated by the backend before the upgrade.
 */
export function publishWsUrl(orderId: number): string {
  const q = new URLSearchParams({
    id: String(orderId),
    token: getToken() || '',
  });
  return `${wsBase()}/integrated-deploy/publish?${q.toString()}`;
}
