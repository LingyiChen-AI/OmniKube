'use client';

import { Table, Tag } from 'antd';
import { useRequest } from 'ahooks';
import PageContainer from '@/components/page-container';

const statusColors: Record<string, string> = {
  applied: 'green',
  pending: 'gold',
  failed: 'red',
  rolled_back: 'default',
};

export default function ReleasesPage() {
  const { data: releases = [], loading } = useRequest(async () => {
    const res = await fetch('/api/apps/releases');
    return res.json();
  });

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '命名空间', dataIndex: 'namespace', key: 'namespace' },
    {
      title: '版本',
      dataIndex: 'revision',
      key: 'revision',
      render: (v: number) => <Tag color="blue">r{v}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{s}</Tag>,
    },
    {
      title: '变更说明',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (msg: string) => msg || '-',
    },
    {
      title: '操作人',
      dataIndex: 'operator',
      key: 'operator',
      render: (v: string) => v || '-',
    },
    {
      title: '发布时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (t: string) => new Date(t).toLocaleString(),
    },
  ];

  return (
    <PageContainer title="发布记录" description="查看应用发布历史">
      <Table columns={columns} dataSource={releases} rowKey="id" loading={loading} size="middle" />
    </PageContainer>
  );
}
