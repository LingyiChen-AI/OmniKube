'use client';

import { useState } from 'react';
import { Tag, Space, App } from 'antd';
import ResourceTable from '@/components/resource-table';
import NamespaceSelector from '@/components/namespace-selector';
import ResourceDrawer from '@/components/resource-drawer';
import DeleteConfirm from '@/components/delete-confirm';
import { useK8sResource } from '@/hooks/use-k8s-resource';
import { usePermissions } from '@/hooks/use-permissions';
import { useClusterStore } from '@/hooks/use-cluster';
import PageContainer from '@/components/page-container';
import { isSystemResource } from '@/lib/k8s-helpers';
import { request } from '@/lib/request';

const phaseColors: Record<string, string> = {
  Running: 'green',
  Pending: 'gold',
  Succeeded: 'blue',
  Failed: 'red',
  Unknown: 'default',
};

export default function PodsPage() {
  const { message } = App.useApp();
  const [namespace, setNamespace] = useState<string | undefined>();
  const { data = [], loading, refresh } = useK8sResource('pods', namespace);
  const permissions = usePermissions('pods');
  const { clusterId } = useClusterStore();
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create'; record?: any }>({ open: false, mode: 'view' });

  const handleDelete = async (record: any) => {
    const name = record.metadata?.name;
    const ns = record.metadata?.namespace;
    if (!clusterId || !name || !ns) return;
    const res = await request(`/api/k8s/${clusterId}/namespaces/${ns}/pods/${name}`, { method: 'DELETE' });
    if (res.ok) { message.success(`Pod ${name} 已删除`); refresh(); }
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
      key: 'phase',
      render: (_: any, r: any) => {
        const phase = r.status?.phase || 'Unknown';
        return <Tag color={phaseColors[phase] || 'default'}>{phase}</Tag>;
      },
    },
    {
      title: '重启次数',
      key: 'restarts',
      render: (_: any, r: any) => {
        const containers = r.status?.containerStatuses || [];
        const total = containers.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
        return total;
      },
    },
    {
      title: 'Pod IP',
      dataIndex: ['status', 'podIP'],
      key: 'ip',
      render: (v: string) => v || '-',
    },
    {
      title: '节点',
      dataIndex: ['spec', 'nodeName'],
      key: 'node',
      render: (v: string) => v || '-',
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
              <DeleteConfirm name={record.metadata?.name} kindLabel="Pod" onConfirm={() => handleDelete(record)} />
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageContainer
        title="Pods"
        filters={<NamespaceSelector value={namespace} onChange={handleNsChange} />}
      >
        <ResourceTable data={data} loading={loading} columns={columns} />
      </PageContainer>
      <ResourceDrawer
        open={drawerState.open}
        mode={drawerState.mode}
        kind="pods"
        kindLabel="Pod"
        record={drawerState.record}
        namespace={namespace}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); refresh(); }}
      />
    </>
  );
}
