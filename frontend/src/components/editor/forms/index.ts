import type { FormComponent } from './types';
import WorkloadForm from './WorkloadForm';
import PodForm from './PodForm';
import JobForm from './JobForm';
import CronJobForm from './CronJobForm';
import ServiceForm from './ServiceForm';
import IngressForm from './IngressForm';
import ConfigMapForm from './ConfigMapForm';
import SecretForm from './SecretForm';
import PVCForm from './PVCForm';
import PVForm from './PVForm';

export type { FormComponent, FormProps } from './types';

/** kind → visual form. Kinds absent here have no visual editor (YAML only). */
const REGISTRY: Record<string, FormComponent> = {
  Deployment: WorkloadForm,
  StatefulSet: WorkloadForm,
  DaemonSet: WorkloadForm,
  Pod: PodForm,
  Job: JobForm,
  CronJob: CronJobForm,
  Service: ServiceForm,
  Ingress: IngressForm,
  ConfigMap: ConfigMapForm,
  Secret: SecretForm,
  PersistentVolumeClaim: PVCForm,
  PersistentVolume: PVForm,
};

/** Look up the visual form for a kind, or null when none is registered. */
export function getResourceForm(kind?: string): FormComponent | null {
  if (!kind) return null;
  return REGISTRY[kind] ?? null;
}

/** Best-effort plural-resource → Kind mapping for callers that only know the plural. */
const RESOURCE_TO_KIND: Record<string, string> = {
  deployments: 'Deployment',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  pods: 'Pod',
  jobs: 'Job',
  cronjobs: 'CronJob',
  replicasets: 'ReplicaSet',
  services: 'Service',
  ingresses: 'Ingress',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  persistentvolumes: 'PersistentVolume',
  nodes: 'Node',
};

export function kindFromResource(resource: string): string | undefined {
  return RESOURCE_TO_KIND[resource];
}

/** Minimal K8s manifest shape used by the create-mode templates. */
export interface CreateTemplate {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [k: string]: unknown;
}

/**
 * A minimal starter manifest per Kind for create mode. Placeholder identity
 * fields (name, labels, selectors, images, sample data, host, schedule) are left
 * BLANK on purpose — the user fills them in the visual form or YAML before
 * POSTing. Only genuine Kubernetes API defaults (replicas: 1, restart policy,
 * Service type, Secret type, ingress path/pathType, PVC access mode/size) are
 * pre-set. Kinds not covered fall back to a generic skeleton (see createTemplate).
 */
const TEMPLATES: Record<string, (ns: string) => CreateTemplate> = {
  Deployment: (ns) => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: '', namespace: ns, labels: {} },
    spec: {
      replicas: 1,
      selector: { matchLabels: {} },
      template: {
        metadata: { labels: {} },
        spec: { containers: [{ name: '', image: '' }] },
      },
    },
  }),
  StatefulSet: (ns) => ({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: '', namespace: ns, labels: {} },
    spec: {
      replicas: 1,
      serviceName: '',
      selector: { matchLabels: {} },
      template: {
        metadata: { labels: {} },
        spec: { containers: [{ name: '', image: '' }] },
      },
    },
  }),
  DaemonSet: (ns) => ({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: '', namespace: ns, labels: {} },
    spec: {
      selector: { matchLabels: {} },
      template: {
        metadata: { labels: {} },
        spec: { containers: [{ name: '', image: '' }] },
      },
    },
  }),
  Service: (ns) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: '', namespace: ns },
    spec: {
      // ClusterIP is the real API default; selector left for the user. One
      // default port row is pre-added (a Service almost always needs a port).
      type: 'ClusterIP',
      selector: {},
      ports: [{ port: 80, protocol: 'TCP' }],
    },
  }),
  Ingress: (ns) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: '', namespace: ns },
    spec: {
      rules: [
        {
          host: '',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: '', port: {} } },
              },
            ],
          },
        },
      ],
    },
  }),
  ConfigMap: (ns) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: '', namespace: ns },
    data: {},
  }),
  Secret: (ns) => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: '', namespace: ns },
    type: 'Opaque',
    data: {},
  }),
  Pod: (ns) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: '', namespace: ns, labels: {} },
    spec: {
      restartPolicy: 'Always',
      containers: [{ name: '', image: '' }],
    },
  }),
  Job: (ns) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: '', namespace: ns },
    spec: {
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [{ name: '', image: '' }],
        },
      },
    },
  }),
  CronJob: (ns) => ({
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: '', namespace: ns },
    spec: {
      schedule: '',
      jobTemplate: {
        spec: {
          template: {
            spec: {
              restartPolicy: 'Never',
              containers: [{ name: '', image: '' }],
            },
          },
        },
      },
    },
  }),
  PersistentVolumeClaim: (ns) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: '', namespace: ns },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '1Gi' } },
    },
  }),
  // Cluster-scoped — no namespace.
  PersistentVolume: () => ({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: '' },
    spec: {
      capacity: { storage: '10Gi' },
      accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain',
      hostPath: { path: '' },
    },
  }),
};

/**
 * Build a starter manifest for create mode. Looks up a per-kind template by the
 * resource plural (→ Kind); unknown kinds fall back to a generic skeleton so the
 * user can still author any resource by hand.
 */
export function createTemplate(
  resource: string,
  namespace: string,
  hint?: { apiVersion?: string; kind?: string },
): CreateTemplate {
  const ns = namespace || 'default';
  const kind = kindFromResource(resource) ?? hint?.kind;
  const make = kind ? TEMPLATES[kind] : undefined;
  if (make) return make(ns);
  return {
    apiVersion: hint?.apiVersion ?? 'v1',
    kind: kind ?? '',
    metadata: { name: '', namespace: ns },
  };
}
