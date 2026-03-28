'use client';

import { Dropdown } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useClusterStore } from '@/hooks/use-cluster';
import { useRequest } from 'ahooks';
import { usePathname, useRouter } from 'next/navigation';
import { request } from '@/lib/request';

const statusColors: Record<string, string> = {
  connected: '#4ade80',
  disconnected: '#94a3b8',
  error: '#f87171',
};

export default function ClusterSelector() {
  const { clusterId, clusterName, setCluster, version } = useClusterStore();
  const pathname = usePathname();
  const router = useRouter();

  const { data: clusters = [] } = useRequest(async () => {
    const res = await request('/api/clusters');
    if (!res.ok) return [];
    return res.json();
  }, { refreshDeps: [version] });

  const currentCluster = clusters.find((c: any) => c.id === clusterId);
  const statusColor = statusColors[currentCluster?.status] || statusColors.disconnected;

  const handleClusterChange = (id: string, name: string) => {
    setCluster(id, name);
    // If on a resource detail page, navigate back to the list page
    // Detail pages have a dynamic segment after the resource type,
    // e.g. /resources/workloads/deployments/my-deploy → /resources/workloads/deployments
    const resourceDetailMatch = pathname.match(/^(\/resources\/(?:workloads|networking|config|storage)\/[^/]+)\/[^/]+/);
    if (resourceDetailMatch) {
      router.push(resourceDetailMatch[1]);
    }
  };

  const items = clusters.map((c: any) => ({
    key: c.id,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColors[c.status] || statusColors.disconnected,
          flexShrink: 0,
        }} />
        <span>{c.displayName || c.name}</span>
      </div>
    ),
    onClick: () => handleClusterChange(c.id, c.displayName || c.name),
  }));

  return (
    <Dropdown menu={{ items, selectedKeys: clusterId ? [clusterId] : [] }} trigger={['click']}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'linear-gradient(135deg, #326CE5, #1a4bc7)',
        borderRadius: 100,
        padding: '4px 12px',
        cursor: 'pointer',
        userSelect: 'none',
        lineHeight: 1,
        height: 28,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: 'white', whiteSpace: 'nowrap' }}>
          {clusterName || '选择集群'}
        </span>
        <DownOutlined style={{ fontSize: 8, color: 'rgba(255,255,255,0.5)' }} />
      </div>
    </Dropdown>
  );
}
