'use client';

import { useState } from 'react';
import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

const phaseColors: Record<string, string> = {
  Bound: 'green',
  Pending: 'gold',
  Lost: 'red',
};

export default function PVCsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('persistentvolumeclaims', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: any) => {
        const phase = r.status?.phase || 'Unknown';
        return <Tag color={phaseColors[phase] || 'default'}>{phase}</Tag>;
      },
    },
    {
      title: '容量',
      key: 'capacity',
      render: (_: any, r: any) => r.status?.capacity?.storage || r.spec?.resources?.requests?.storage || '-',
    },
    {
      title: 'StorageClass',
      dataIndex: ['spec', 'storageClassName'],
      key: 'storageClass',
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
      <h2>PV / PVC</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
