'use client';

import { Select } from 'antd';
import { useClusterStore } from '@/hooks/use-cluster';
import { useRequest } from 'ahooks';

export default function ClusterSelector() {
  const { clusterId, setCluster } = useClusterStore();

  const { data: clusters = [] } = useRequest(async () => {
    const res = await fetch('/api/clusters');
    if (!res.ok) return [];
    return res.json();
  });

  return (
    <Select
      value={clusterId}
      onChange={(value, option: any) => setCluster(value, option?.label)}
      placeholder="选择集群"
      style={{ width: 200 }}
      options={clusters.map((c: any) => ({
        value: c.id,
        label: c.displayName || c.name,
      }))}
    />
  );
}
