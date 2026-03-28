'use client';

import { Table, Button, Tag, Space, Popconfirm, App } from 'antd';
import { PlusOutlined, DeleteOutlined, LockOutlined, EditOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { useRequest } from 'ahooks';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';
import { request } from '@/lib/request';

export default function RolesPage() {
  const { message } = App.useApp();
  const router = useRouter();

  const { data: roles = [], loading, refresh } = useRequest(async () => {
    const res = await request('/api/admin/roles');
    return res.json();
  });

  const handleDelete = async (id: string) => {
    const res = await request(`/api/admin/roles/${id}`, { method: 'DELETE' });
    if (res.ok) { message.success('已删除'); refresh(); }
    else { const data = await res.json(); message.error(data.error || '删除失败'); }
  };

  const columns = [
    {
      title: '角色名', dataIndex: 'name', key: 'name',
      render: (v: string, r: any) => (
        <Space>
          {r.isSystem && <LockOutlined style={{ color: '#faad14' }} />}
          {v}
        </Space>
      ),
    },
    { title: '显示名称', dataIndex: 'displayName', key: 'displayName' },
    {
      title: '类型', dataIndex: 'isSystem', key: 'isSystem',
      render: (v: boolean) => <Tag color={v ? 'gold' : 'blue'}>{v ? '系统' : '自定义'}</Tag>,
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: (v: string) => v || '-' },
    {
      title: '创建时间', dataIndex: 'createdAt', key: 'createdAt',
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作', key: 'actions', fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space>
          {!record.isSystem && (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={() => router.push(`/admin/roles/${record.id}/edit`)}>编辑</Button>
              <Popconfirm title="确认删除此角色?" onConfirm={() => handleDelete(record.id)}>
                <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
              </Popconfirm>
            </>
          )}
          {record.isSystem && <Tag>系统角色</Tag>}
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="角色管理"
      description="管理系统角色和权限配置"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/admin/roles/new')} style={gradientBtnStyle}>
          创建角色
        </Button>
      }
    >
      <Table columns={columns} dataSource={roles} rowKey="id" loading={loading} size="middle" scroll={{ x: 'max-content' }} />
    </PageContainer>
  );
}
