'use client';

import { Table, Select, Tag } from 'antd';
import { useRequest } from 'ahooks';
import { useState } from 'react';
import PageContainer from '@/components/page-container';

export default function AuditPage() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);

  const { data: logs = [], loading } = useRequest(
    async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20', ...filters });
      const res = await fetch(`/api/audit?${params}`);
      return res.json();
    },
    { refreshDeps: [page, filters] },
  );

  const actionColors: Record<string, string> = {
    create: 'green', update: 'blue', delete: 'red',
    login: 'cyan', logout: 'default', login_failed: 'orange',
  };

  const columns = [
    {
      title: '时间', dataIndex: 'createdAt', key: 'createdAt',
      render: (t: string) => new Date(t).toLocaleString(),
    },
    { title: '用户', dataIndex: 'username', key: 'username', render: (v: string) => v || '-' },
    {
      title: '操作', dataIndex: 'action', key: 'action',
      render: (a: string) => <Tag color={actionColors[a] || 'default'}>{a}</Tag>,
    },
    { title: '资源类型', dataIndex: 'resourceType', key: 'resourceType' },
    { title: '资源名称', dataIndex: 'resourceName', key: 'resourceName', render: (v: string) => v || '-' },
    { title: '命名空间', dataIndex: 'namespace', key: 'namespace', render: (v: string) => v || '-' },
    { title: '状态码', dataIndex: 'responseStatus', key: 'responseStatus' },
    { title: 'IP', dataIndex: 'ipAddress', key: 'ipAddress', render: (v: string) => v || '-' },
  ];

  return (
    <PageContainer
      title="审计日志"
      description="查看系统操作记录"
      filters={
        <>
          <Select
            placeholder="操作类型"
            allowClear
            style={{ width: 150 }}
            onChange={(v) => { setFilters((f) => ({ ...f, ...(v ? { action: v } : { action: '' }) })); setPage(1); }}
            options={[
              { value: 'create', label: '创建' },
              { value: 'update', label: '更新' },
              { value: 'delete', label: '删除' },
              { value: 'login', label: '登录' },
              { value: 'logout', label: '登出' },
            ]}
          />
          <Select
            placeholder="资源类型"
            allowClear
            style={{ width: 150 }}
            onChange={(v) => { setFilters((f) => ({ ...f, ...(v ? { resourceType: v } : { resourceType: '' }) })); setPage(1); }}
            options={[
              { value: 'user', label: '用户' },
              { value: 'cluster', label: '集群' },
              { value: 'deployment', label: 'Deployment' },
              { value: 'service', label: 'Service' },
              { value: 'role', label: '角色' },
            ]}
          />
        </>
      }
    >
      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          onChange: setPage,
          pageSize: 20,
        }}
        size="middle"
      />
    </PageContainer>
  );
}
