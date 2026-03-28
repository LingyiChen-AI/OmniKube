'use client';

import { useRequest } from 'ahooks';
import { useClusterStore } from './use-cluster';
import { useResourceWatch } from './use-resource-watch';
import { request } from '@/lib/request';

export function useK8sResource(kind: string, namespace?: string) {
  const { clusterId } = useClusterStore();

  const path = namespace
    ? `/api/k8s/${clusterId}/namespaces/${namespace}/${kind}`
    : `/api/k8s/${clusterId}/${kind}`;

  const { data, loading, refresh, mutate } = useRequest(
    async () => {
      if (!clusterId) return [];
      const res = await request(path);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    {
      refreshDeps: [clusterId, namespace, kind],
      ready: !!clusterId,
    },
  );

  // Watch for real-time changes via K8s Watch API
  useResourceWatch(clusterId, kind, namespace, refresh);

  return { data, loading, refresh, mutate };
}
