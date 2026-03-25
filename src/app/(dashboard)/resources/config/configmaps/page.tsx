'use client';

import { useState } from 'react';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function ConfigMapsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('configmaps', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: 'Data Keys',
      key: 'dataKeys',
      render: (_: any, r: any) => Object.keys(r.data || {}).length,
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
      <h2>ConfigMaps</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
