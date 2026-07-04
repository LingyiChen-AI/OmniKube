import client from './client';
import { unwrapList } from './normalize';

export type ClusterStatus = 'Healthy' | 'Unreachable' | 'Unknown' | string;

/** A release-notification bot webhook. */
export type WebhookType = 'dingtalk' | 'feishu' | 'wecom';
export interface Webhook {
  type: WebhookType;
  url: string;
  /** Optional signing secret (钉钉/飞书「加签」; 企业微信不用). */
  secret?: string;
}

export interface Cluster {
  id: string;
  name: string;
  status: ClusterStatus;
  last_check?: string;
  webhooks?: Webhook[];
}

export interface TestResult {
  ok?: boolean;
  code?: number;
  message?: string;
  server_version?: string;
}

export interface ClusterListPagedParams {
  limit?: number;
  offset?: number;
}

export const clusterApi = {
  // Clusters the current user can access (admin → all). Drives the top-bar
  // selector + management table; non-admins get only their granted clusters.
  list: () => client.get('/my/clusters').then((r) => unwrapList<Cluster>(r.data)),

  /** Server-side paginated list of accessible clusters, returning the page + total count. */
  listPaged: (params: ClusterListPagedParams = {}) =>
    client
      .get<{ clusters: Cluster[]; total: number }>('/my/clusters', { params })
      .then((r) => ({ clusters: r.data.clusters ?? [], total: r.data.total ?? 0 })),

  create: (payload: { id: string; name: string; kubeconfig: string }) =>
    client.post('/clusters', payload).then((r) => r.data),

  update: (
    id: string,
    payload: { name?: string; kubeconfig?: string; webhooks?: Webhook[] },
  ) => client.put(`/clusters/${id}`, payload).then((r) => r.data),

  remove: (id: string) => client.delete(`/clusters/${id}`).then((r) => r.data),

  test: (kubeconfig: string) =>
    client.post<TestResult>('/clusters/test', { kubeconfig }).then((r) => r.data),
};
