'use client';

import { useState } from 'react';
import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

const phaseColors: Record<string, string> = {
  Running: 'green',
  Pending: 'gold',
  Succeeded: 'blue',
  Failed: 'red',
  Unknown: 'default',
};

export default function PodsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('pods', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: '状态',
      key: 'phase',
      render: (_: any, r: any) => {
        const phase = r.status?.phase || 'Unknown';
        return <Tag color={phaseColors[phase] || 'default'}>{phase}</Tag>;
      },
    },
    {
      title: '重启次数',
      key: 'restarts',
      render: (_: any, r: any) => {
        const containers = r.status?.containerStatuses || [];
        const total = containers.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
        return total;
      },
    },
    {
      title: 'Pod IP',
      dataIndex: ['status', 'podIP'],
      key: 'ip',
      render: (v: string) => v || '-',
    },
    {
      title: '节点',
      dataIndex: ['spec', 'nodeName'],
      key: 'node',
      render: (v: string) => v || '-',
    },
    {
      title: '创建时间',
      dataIndex: ['metadata', 'creationTimestamp'],
      key: 'created',
      render: (t: string) => new Date(t).toLocaleString(),
    },
  ];

  return (
    <div>
      <h2>Pods</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
