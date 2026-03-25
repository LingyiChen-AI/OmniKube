'use client';

import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function NamespacesPage() {
  const { data = [], loading } = useK8sResource('namespaces');

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: any) => {
        const phase = r.status?.phase || 'Unknown';
        return <Tag color={phase === 'Active' ? 'green' : 'red'}>{phase}</Tag>;
      },
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
      <h2>Namespaces</h2>
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
