import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import {
  filterPodsBySelector,
  podMatchesSelector,
  collectConfigRefs,
  workloadStatus,
} from '../pages/workloads/DeploymentDetail';
import type { K8sObject } from '../api/resource';

vi.mock('../api/resource', () => ({
  resourceApi: {
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../api/me', () => ({
  meApi: { capabilities: vi.fn() },
}));

import ResourceTable from '../components/ResourceTable';
import { resourceApi } from '../api/resource';
import { meApi } from '../api/me';
import { useCtxStore } from '../store/ctx';
import { useCapsStore } from '../store/caps';

const pod = (name: string, labels: Record<string, string>): K8sObject => ({
  metadata: { name, namespace: 'default', labels },
});

describe('pod selector matching', () => {
  const pods = [
    pod('nginx-a', { app: 'nginx', tier: 'web' }),
    pod('nginx-b', { app: 'nginx', tier: 'web', extra: 'x' }),
    pod('redis-a', { app: 'redis' }),
    pod('nolabels', {}),
  ];

  it('matches pods that contain all selector labels (superset allowed)', () => {
    expect(podMatchesSelector(pods[0], { app: 'nginx' })).toBe(true);
    expect(podMatchesSelector(pods[1], { app: 'nginx', tier: 'web' })).toBe(true);
    expect(podMatchesSelector(pods[2], { app: 'nginx' })).toBe(false);
    expect(podMatchesSelector(pods[3], { app: 'nginx' })).toBe(false);
  });

  it('filters a pod list down to the deployment selector', () => {
    const out = filterPodsBySelector(pods, { app: 'nginx', tier: 'web' });
    expect(out.map((p) => p.metadata?.name)).toEqual(['nginx-a', 'nginx-b']);
  });

  it('returns nothing for an empty/undefined selector', () => {
    expect(filterPodsBySelector(pods, {})).toEqual([]);
    expect(filterPodsBySelector(pods, undefined)).toEqual([]);
  });
});

describe('pod controller-kind filtering (name collisions)', () => {
  const owned = (
    name: string,
    labels: Record<string, string>,
    ownerKind: string,
    ownerName: string,
  ): K8sObject => ({
    metadata: {
      name,
      namespace: 'default',
      labels,
      ownerReferences: [{ kind: ownerKind, name: ownerName, controller: true }],
    },
  });

  // A Deployment and a CronJob both named voc-label-worker, whose pods share
  // the app label. The CronJob's Job pod must NOT show up on the Deployment.
  const rsPod = owned(
    'voc-label-worker-5f76968986-fdtgm',
    { app: 'voc-label-worker' },
    'ReplicaSet',
    'voc-label-worker-5f76968986',
  );
  const jobPod = owned(
    'voc-label-worker-29725441-zqw6m',
    { app: 'voc-label-worker', 'job-name': 'voc-label-worker-29725441' },
    'Job',
    'voc-label-worker-29725441',
  );

  it("excludes a same-named CronJob's Job pods from a Deployment's list", () => {
    const out = filterPodsBySelector(
      [rsPod, jobPod],
      { app: 'voc-label-worker' },
      'ReplicaSet',
    );
    expect(out.map((p) => p.metadata?.name)).toEqual([
      'voc-label-worker-5f76968986-fdtgm',
    ]);
  });

  it('keeps orphan pods (no controller ref) that match the selector', () => {
    const orphan: K8sObject = {
      metadata: { name: 'bare', namespace: 'default', labels: { app: 'voc-label-worker' } },
    };
    const out = filterPodsBySelector([orphan], { app: 'voc-label-worker' }, 'ReplicaSet');
    expect(out.map((p) => p.metadata?.name)).toEqual(['bare']);
  });

  it('matches on labels only when no controller kind is given (back-compat)', () => {
    const out = filterPodsBySelector([rsPod, jobPod], { app: 'voc-label-worker' });
    expect(out.length).toBe(2);
  });
});

describe('config reference collection', () => {
  it('dedupes ConfigMap/Secret refs across env, envFrom and volumes', () => {
    const dep: K8sObject = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'app',
                env: [
                  { name: 'A', valueFrom: { configMapKeyRef: { name: 'cm1', key: 'a' } } },
                  { name: 'B', valueFrom: { secretKeyRef: { name: 'sec1', key: 'b' } } },
                ],
                envFrom: [{ configMapRef: { name: 'cm1' } }, { secretRef: { name: 'sec2' } }],
              },
            ],
            volumes: [
              { name: 'v1', configMap: { name: 'cm2' } },
              { name: 'v2', secret: { secretName: 'sec1' } },
            ],
          },
        },
      },
    };
    const refs = collectConfigRefs(dep);
    expect(refs).toEqual([
      { kind: 'configmap', name: 'cm1' },
      { kind: 'secret', name: 'sec1' },
      { kind: 'secret', name: 'sec2' },
      { kind: 'configmap', name: 'cm2' },
    ]);
  });
});

describe('per-kind workload status', () => {
  it('reads replica fields for a deployment', () => {
    const { ready, desired, stats } = workloadStatus(
      'deployment',
      { replicas: 3 },
      { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 },
    );
    expect({ ready, desired }).toEqual({ ready: 2, desired: 3 });
    expect(stats.map((s) => [s.labelKey, s.value])).toEqual([
      ['workloadDetail.desired', 3],
      ['resource.ready', 2],
      ['resource.upToDate', 3],
      ['resource.available', 2],
    ]);
  });

  it('includes currentReplicas for a statefulset', () => {
    const { ready, desired, stats } = workloadStatus(
      'statefulset',
      { replicas: 3 },
      { readyReplicas: 3, currentReplicas: 3, updatedReplicas: 2 },
    );
    expect({ ready, desired }).toEqual({ ready: 3, desired: 3 });
    expect(stats.map((s) => s.labelKey)).toContain('workloadDetail.current');
  });

  it('reads node-scheduling fields for a daemonset (no spec.replicas)', () => {
    const { ready, desired, stats } = workloadStatus(
      'daemonset',
      {},
      {
        desiredNumberScheduled: 5,
        numberReady: 4,
        numberAvailable: 4,
        updatedNumberScheduled: 5,
        numberMisscheduled: 1,
      },
    );
    expect({ ready, desired }).toEqual({ ready: 4, desired: 5 });
    expect(stats.map((s) => [s.labelKey, s.value])).toEqual([
      ['workloadDetail.desired', 5],
      ['resource.ready', 4],
      ['resource.available', 4],
      ['resource.upToDate', 5],
      ['workloadDetail.misscheduled', 1],
    ]);
  });
});

describe('ResourceTable nameLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resourceApi.list as any).mockResolvedValue([
      {
        metadata: {
          name: 'nginx',
          namespace: 'default',
          creationTimestamp: new Date().toISOString(),
        },
      },
    ]);
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view'] });
    useCtxStore.setState({ currentCluster: 'c1', currentNamespace: null });
    useCapsStore.setState({ resources: {}, loading: false, loadedKey: null, pendingKey: null });
  });

  it('renders the name as a router link to the detail path', async () => {
    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <ConfigProvider>
            <AntdApp>
              <ResourceTable
                title="Deployments"
                resource="deployments"
                nameLink={(d) =>
                  `/workloads/deployments/${d.metadata?.namespace}/${d.metadata?.name}`
                }
              />
            </AntdApp>
          </ConfigProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );

    const link = (await screen.findByText('nginx')).closest('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('/workloads/deployments/default/nginx');
  });
});
