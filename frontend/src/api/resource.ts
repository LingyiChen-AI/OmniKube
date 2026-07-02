import client from './client';
import { unwrapList } from './normalize';

/** Minimal shape we rely on; real objects are full k8s manifests. */
export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    [k: string]: any;
  };
  status?: Record<string, any>;
  spec?: Record<string, any>;
  data?: Record<string, string>;
  [k: string]: any;
}

export interface Namespace {
  name: string;
}

export const resourceApi = {
  namespaces: () =>
    client.get<any>('/namespaces').then((r) => normalizeNamespaces(r.data)),

  list: (resource: string, namespace?: string) =>
    client
      .get<any>(`/resources/${resource}`, {
        params: namespace ? { namespace } : undefined,
      })
      .then((r) => normalizeList(r.data)),

  get: (ns: string, resource: string, name: string) =>
    client
      .get<K8sObject>(`/namespaces/${ns}/resources/${resource}/${name}`)
      .then((r) => r.data),

  create: (ns: string, resource: string, body: K8sObject) =>
    client.post(`/namespaces/${ns}/resources/${resource}`, body).then((r) => r.data),

  update: (
    ns: string,
    resource: string,
    name: string,
    body: K8sObject,
    opts?: { releaseComment?: string },
  ) =>
    client
      .put(`/namespaces/${ns}/resources/${resource}/${name}`, body, {
        params: opts?.releaseComment ? { release_comment: opts.releaseComment } : undefined,
      })
      .then((r) => r.data),

  remove: (ns: string, resource: string, name: string) =>
    client
      .delete(`/namespaces/${ns}/resources/${resource}/${name}`)
      .then((r) => r.data),

  revealSecret: (ns: string, name: string) =>
    client
      .post<{ data: Record<string, string> }>(
        `/namespaces/${ns}/resources/secrets/${name}/reveal`,
      )
      .then((r) => r.data),

  // --- workload ops (subproject B) ---------------------------------------

  /** Scale a Deployment/StatefulSet to the given replica count. */
  scale: (ns: string, resource: string, name: string, replicas: number) =>
    client
      .put(`/namespaces/${ns}/resources/${resource}/${name}/scale`, { replicas })
      .then((r) => r.data),

  /** Trigger a rolling restart (Deployment/StatefulSet/DaemonSet). */
  restart: (ns: string, resource: string, name: string) =>
    client
      .put(`/namespaces/${ns}/resources/${resource}/${name}/restart`, {})
      .then((r) => r.data),

  /** List revision history (newest first). */
  revisions: (ns: string, resource: string, name: string) =>
    client
      .get<{ revisions: Revision[] }>(
        `/namespaces/${ns}/resources/${resource}/${name}/revisions`,
      )
      .then((r) => r.data.revisions ?? []),

  /** Roll a workload back to a prior revision. */
  rollback: (ns: string, resource: string, name: string, revision: number) =>
    client
      .put(`/namespaces/${ns}/resources/${resource}/${name}/rollback`, { revision })
      .then((r) => r.data),

  /** Events involving a specific object (newest first). */
  events: (ns: string, resource: string, name: string) =>
    client
      .get<{ events: K8sEvent[] }>(
        `/namespaces/${ns}/resources/${resource}/${name}/events`,
      )
      .then((r) => r.data.events ?? []),

  /** Manually trigger a CronJob (creates a Job from its jobTemplate). Returns the Job name. */
  triggerCronJob: (ns: string, name: string) =>
    client
      .put<{ job: string }>(`/namespaces/${ns}/resources/cronjobs/${name}/trigger`, {})
      .then((r) => r.data.job),
};

/** One workload revision (Deployment ReplicaSet / STS·DS ControllerRevision). */
export interface Revision {
  revision: number;
  created_at: string;
  images: string;
  changer: string;
  current: boolean;
}

/** A simplified k8s event for a resource. */
export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  last_seen: string;
  source: string;
}

/** Backends may return a bare array, {items}, {data}, or a named key — normalize. */
function normalizeList(data: any): K8sObject[] {
  return unwrapList<K8sObject>(data);
}

function normalizeNamespaces(data: any): string[] {
  const arr = unwrapList<any>(data);
  return arr
    .map((it) => (typeof it === 'string' ? it : it?.name || it?.metadata?.name))
    .filter(Boolean);
}
