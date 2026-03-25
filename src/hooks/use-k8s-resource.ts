'use client';

import { useRequest } from 'ahooks';
import { useClusterStore } from './use-cluster';

export function useK8sResource(kind: string, namespace?: string) {
  const { clusterId } = useClusterStore();

  const path = namespace
    ? `/api/k8s/${clusterId}/namespaces/${namespace}/${kind}`
    : `/api/k8s/${clusterId}/${kind}`;

  return useRequest(
    async () => {
      if (!clusterId) return [];
      const res = await fetch(path);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    {
      refreshDeps: [clusterId, namespace, kind],
      ready: !!clusterId,
    },
  );
}
