'use client';

import { useState } from 'react';
import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function StatefulSetsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('statefulsets', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: '就绪',
      key: 'ready',
      render: (_: any, r: any) => `${r.status?.readyReplicas || 0}/${r.spec?.replicas || 0}`,
    },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: any) => {
        const ready = (r.status?.readyReplicas || 0) === (r.spec?.replicas || 0);
        return <Tag color={ready ? 'green' : 'orange'}>{ready ? 'Ready' : 'Updating'}</Tag>;
      },
    },
    {
      title: '镜像',
      key: 'image',
      ellipsis: true,
      render: (_: any, r: any) => r.spec?.template?.spec?.containers?.[0]?.image || '-',
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
      <h2>StatefulSets</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
