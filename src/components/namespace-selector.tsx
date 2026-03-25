'use client';

import { Select } from 'antd';
import { useK8sResource } from '@/hooks/use-k8s-resource';

interface Props {
  value?: string;
  onChange?: (value: string | undefined) => void;
}

export default function NamespaceSelector({ value, onChange }: Props) {
  const { data: namespaces = [], loading } = useK8sResource('namespaces');

  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder="所有命名空间"
      allowClear
      loading={loading}
      style={{ width: 200, marginBottom: 16 }}
      options={namespaces.map((ns: any) => ({
        value: ns.metadata?.name,
        label: ns.metadata?.name,
      }))}
    />
  );
}
