'use client';

import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function StorageClassesPage() {
  const { data = [], loading } = useK8sResource('storageclasses');

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    {
      title: 'Provisioner',
      dataIndex: 'provisioner',
      key: 'provisioner',
    },
    {
      title: 'Reclaim Policy',
      dataIndex: 'reclaimPolicy',
      key: 'reclaimPolicy',
      render: (v: string) => {
        const colors: Record<string, string> = { Retain: 'green', Delete: 'orange', Recycle: 'blue' };
        return <Tag color={colors[v] || 'default'}>{v || '-'}</Tag>;
      },
    },
    {
      title: '默认',
      key: 'default',
      render: (_: any, r: any) => {
        const isDefault = r.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
        return isDefault ? <Tag color="green">默认</Tag> : '-';
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
      <h2>StorageClasses</h2>
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
