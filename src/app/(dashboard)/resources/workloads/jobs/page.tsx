'use client';

import { useState } from 'react';
import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function JobsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('jobs', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: '完成数',
      key: 'completions',
      render: (_: any, r: any) =>
        `${r.status?.succeeded || 0}/${r.spec?.completions || 1}`,
    },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: any) => {
        if (r.status?.succeeded) return <Tag color="green">Complete</Tag>;
        if (r.status?.failed) return <Tag color="red">Failed</Tag>;
        return <Tag color="blue">Running</Tag>;
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
      <h2>Jobs / CronJobs</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
