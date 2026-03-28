'use client';

import { useState } from 'react';
import { Tag, Button, Space, App } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';
import { isSystemResource } from '@/lib/k8s-helpers';
import { request } from '@/lib/request';

export default function StatefulSetsPage() {
  const { message } = App.useApp();
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading, refresh } = useK8sResource('statefulsets', namespace);
  const permissions = usePermissions('statefulsets');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    const ns = record.metadata?.namespace;
    if (!clusterId || !name || !ns) return;
    const res = await request(`/api/k8s/${clusterId}/namespaces/${ns}/statefulsets/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`StatefulSet ${name} 已删除`); refresh(); }
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
      title: '就绪',
      key: 'ready',
      render: (_: any, r: any) => `${r.status?.readyReplicas || 0}/${r.spec?.replicas || 0}`,
    },
    {
      title: '状态',
      key: 'status',
      render: (_: any, r: any) => {
        const ready = (r.status?.readyReplicas || 0) === (r.spec?.replicas || 0);
        return <Tag color={ready ? 'green' : 'orange'}>{ready ? 'Ready' : 'Updating'}</Tag>;
      },
    },
    {
      title: '镜像',
      key: 'image',
      ellipsis: true,
      render: (_: any, r: any) => r.spec?.template?.spec?.containers?.[0]?.image || '-',
    },
    {
      title: '创建时间',
      dataIndex: ['metadata', 'creationTimestamp'],
      key: 'created',
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作', key: 'actions', width: 150, fixed: 'right' as const,
      render: (_: any, record: any) => {
        const system = isSystemResource(record);
        return (
          <Space>
            {permissions.canUpdate && !system && (
              <Button size="small" type="link" onClick={() => setDrawerState({ open: true, mode: 'edit', record })}>编辑</Button>
            )}
            {permissions.canDelete && !system && (
              <DeleteConfirm name={record.metadata?.name} kindLabel="StatefulSet" onConfirm={() => handleDelete(record)} />
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageContainer
        title="StatefulSets"
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
        kind="statefulsets"
        kindLabel="StatefulSet"
        record={drawerState.record}
        namespace={namespace}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </>
  );
}
