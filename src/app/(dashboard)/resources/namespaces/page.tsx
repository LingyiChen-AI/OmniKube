'use client';

import { useState } from 'react';
import { Tag, Button, Space, App } from 'antd';
import ResourceTable from '@/components/resource-table';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';
import { isSystemResource } from '@/lib/k8s-helpers';
import { request } from '@/lib/request';

export default function NamespacesPage() {
  const { message } = App.useApp();
  const { data = [], loading, refresh } = useK8sResource('namespaces');
  const permissions = usePermissions('namespaces');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    if (!clusterId || !name) return;
    const res = await request(`/api/k8s/${clusterId}/namespaces/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`Namespace ${name} 已删除`); refresh(); }
    else { const d = await res.json().catch(() => ({})); message.error(d.error || '删除失败'); }
  };

  const columns = [
    {
      title: '名称', dataIndex: ['metadata', 'name'], key: 'name',
      render: (text: string, record: any) => (
        <a onClick={() => setDrawerState({ open: true, mode: 'view', record })}>{text}</a>
      ),
    },
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
    {
      title: '操作', key: 'actions', width: 80, fixed: 'right' as const,
      render: (_: any, record: any) => {
        const system = isSystemResource(record);
        return (
          <Space>
            {permissions.canDelete && !system && (
              <DeleteConfirm name={record.metadata?.name} kindLabel="Namespace" onConfirm={() => handleDelete(record)} />
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageContainer
        title="Namespaces"
        extra={permissions.canCreate ? (
          <Button type="primary" onClick={() => setDrawerState({ open: true, mode: 'create' })} style={gradientBtnStyle}>
            + 创建
          </Button>
        ) : undefined}
      >
        <ResourceTable data={data} loading={loading} columns={columns} />
      </PageContainer>
      <ResourceDrawer
        open={drawerState.open}
        mode={drawerState.mode}
        kind="namespaces"
        kindLabel="Namespace"
        record={drawerState.record}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </>
  );
}
