'use client';

import { useState } from 'react';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import { useK8sResource } from '@/hooks/use-k8s-resource';

export default function IngressesPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading } = useK8sResource('ingresses', namespace);

  const columns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    { title: '命名空间', dataIndex: ['metadata', 'namespace'], key: 'namespace' },
    {
      title: 'Hosts',
      key: 'hosts',
      render: (_: any, r: any) => {
        const rules = r.spec?.rules || [];
        return rules.map((rule: any) => rule.host || '*').join(', ') || '-';
      },
    },
    {
      title: 'Paths',
      key: 'paths',
      render: (_: any, r: any) => {
        const rules = r.spec?.rules || [];
        const paths: string[] = [];
        for (const rule of rules) {
          for (const http of rule.http?.paths || []) {
            paths.push(http.path || '/');
          }
        }
        return paths.join(', ') || '-';
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
      <h2>Ingresses</h2>
      <NamespaceSelector value={namespace} onChange={setNamespace} />
      <ResourceTable data={data} loading={loading} columns={columns} />
    </div>
  );
}
