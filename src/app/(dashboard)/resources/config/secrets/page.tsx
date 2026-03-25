'use client';

import { useState } from 'react';
import { Tag, Button, Space, message } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';

export default function SecretsPage() {
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading, refresh } = useK8sResource('secrets', namespace);
  const permissions = usePermissions('secrets');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    const ns = record.metadata?.namespace;
    if (!clusterId || !name || !ns) return;
    const res = await fetch(`/api/k8s/${clusterId}/namespaces/${ns}/secrets/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`Secret ${name} 已删除`); refresh(); }
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
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (t: string) => <Tag>{t || 'Opaque'}</Tag>,
    },
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
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: any, record: any) => (
        <Space>
          {permissions.canUpdate && (
            <Button size="small" type="link" onClick={() => setDrawerState({ open: true, mode: 'edit', record })}>编辑</Button>
          )}
          {permissions.canDelete && (
            <DeleteConfirm name={record.metadata?.name} kindLabel="Secret" onConfirm={() => handleDelete(record)} />
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageContainer
        title="Secrets"
        extra={permissions.canCreate ? (
          <Button type="primary" onClick={() => setDrawerState({ open: true, mode: 'create' })} style={gradientBtnStyle}>
            + 创建
          </Button>
        ) : undefined}
        filters={<NamespaceSelector value={namespace} onChange={handleNsChange} />}
      >
        <ResourceTable data={data} loading={loading} columns={columns} />
      </PageContainer>
      <ResourceDrawer
        open={drawerState.open}
        mode={drawerState.mode}
        kind="secrets"
        kindLabel="Secret"
        record={drawerState.record}
        namespace={namespace}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </>
  );
}
