'use client';

import { useState } from 'react';
import { Tag } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function ServicesPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('services', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: '类型',
      key: 'type',
      render: (_: any, r: any) => {
        const type = r.spec?.type || 'ClusterIP';
        const colors: Record<string, string> = {
          ClusterIP: 'blue', NodePort: 'orange', LoadBalancer: 'green', ExternalName: 'purple',
        };
        return <Tag color={colors[type] || 'default'}>{type}</Tag>;
      },
    },
    {
      title: 'Cluster IP',
      dataIndex: ['spec', 'clusterIP'],
      key: 'clusterIP',
      render: (v: string) => v || '-',
    },
    {
      title: '端口',
      key: 'ports',
      render: (_: any, r: any) => {
        const ports = r.spec?.ports || [];
        return ports.map((p: any) => `${p.port}/${p.protocol}`).join(', ') || '-';
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
      <h2>Services</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
