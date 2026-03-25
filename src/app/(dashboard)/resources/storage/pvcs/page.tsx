'use client';

import { useState } from 'react';
import { Tag, Typography, Button, Space, message } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';

const { Title } = Typography;

const phaseColors: Record<string, string> = {
  Bound: 'green',
  Pending: 'gold',
  Lost: 'red',
};

export default function PVCsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading, refresh } = useK8sResource('persistentvolumeclaims', namespace);
  const permissions = usePermissions('persistentvolumeclaims');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    const ns = record.metadata?.namespace;
    if (!clusterId || !name || !ns) return;
    const res = await fetch(`/api/k8s/${clusterId}/namespaces/${ns}/persistentvolumeclaims/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`PVC ${name} 已删除`); refresh(); }
    else { const d = await res.json().catch(() => ({})); message.error(d.error || '删除失败'); }
  };

  const handleNsChange = (v: string | undefined) => {
    setNamespace(v);
    setDrawerState(s => ({ ...s, open: false }));
  };

  const columns = [
    {
      title: '名称', dataIndex: ['metadata', 'name'], key: 'name',
      render: (text: string, record: any) => (
        <a onClick={() => setDrawerState({ open: true, mode: 'view', record })}>{text}</a>
      ),
    },
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
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: any, record: any) => (
        <Space>
          {permissions.canUpdate && (
            <Button size="small" type="link" onClick={() => setDrawerState({ open: true, mode: 'edit', record })}>编辑</Button>
          )}
          {permissions.canDelete && (
            <DeleteConfirm name={record.metadata?.name} kindLabel="PVC" onConfirm={() => handleDelete(record)} />
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={4} style={{ margin: 0 }}>PV / PVC</Title>
        {permissions.canCreate && (
          <Button type="primary" onClick={() => setDrawerState({ open: true, mode: 'create' })}>+ 创建</Button>
        )}
      </div>
      <NamespaceSelector value={namespace} onChange={handleNsChange} />
      <ResourceTable data={data} loading={loading} columns={columns} />
      <ResourceDrawer
        open={drawerState.open}
        mode={drawerState.mode}
        kind="persistentvolumeclaims"
        kindLabel="PVC"
        record={drawerState.record}
        namespace={namespace}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </div>
  );
}
