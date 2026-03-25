'use client';

import { useState } from 'react';
import { Tag, Button, Space, message } from 'antd';
import ResourceTable from '@/components/resource-table';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';
import { isSystemResource } from '@/lib/k8s-helpers';

export default function StorageClassesPage() {
  const { data = [], loading, refresh } = useK8sResource('storageclasses');
  const permissions = usePermissions('storageclasses');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    if (!clusterId || !name) return;
    const res = await fetch(`/api/k8s/${clusterId}/storageclasses/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`StorageClass ${name} 已删除`); refresh(); }
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
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: any, record: any) => {
        const system = isSystemResource(record);
        return (
          <Space>
            {permissions.canUpdate && !system && (
              <Button size="small" type="link" onClick={() => setDrawerState({ open: true, mode: 'edit', record })}>编辑</Button>
            )}
            {permissions.canDelete && !system && (
              <DeleteConfirm name={record.metadata?.name} kindLabel="StorageClass" onConfirm={() => handleDelete(record)} />
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageContainer
        title="StorageClasses"
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
        kind="storageclasses"
        kindLabel="StorageClass"
        record={drawerState.record}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </>
  );
}
