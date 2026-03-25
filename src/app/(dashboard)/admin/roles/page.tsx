'use client';

import { useState } from 'react';
import {
  Table, Button, Tag, Space, Popconfirm, message, Modal, Form, Input, Checkbox,
} from 'antd';
import { PlusOutlined, DeleteOutlined, LockOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';

const RESOURCES = ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'pods', 'services', 'ingresses', 'configmaps', 'secrets', 'persistentvolumeclaims', 'storageclasses', 'namespaces', 'nodes'];
const ACTIONS = ['get', 'list', 'create', 'update', 'delete'];

export default function RolesPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [permissions, setPermissions] = useState<Record<string, string[]>>({});

  const { data: roles = [], loading, refresh } = useRequest(async () => {
    const res = await fetch('/api/admin/roles');
    return res.json();
  });

  const toggleAction = (resource: string, action: string) => {
    setPermissions((prev) => {
      const current = prev[resource] || [];
      const updated = current.includes(action)
        ? current.filter((a) => a !== action)
        : [...current, action];
      return { ...prev, [resource]: updated };
    });
  };

  const handleAdd = async (values: any) => {
    const permList = Object.entries(permissions)
      .filter(([, actions]) => actions.length > 0)
      .map(([resource, actions]) => ({ resource, actions }));

    const res = await fetch('/api/admin/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, permissions: permList }),
    });
    if (res.ok) {
      message.success('角色创建成功');
      setAddOpen(false);
      form.resetFields();
      setPermissions({});
      refresh();
    } else {
      const data = await res.json();
      message.error(data.error || '创建失败');
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/admin/roles/${id}`, { method: 'DELETE' });
    if (res.ok) {
      message.success('已删除');
      refresh();
    } else {
      const data = await res.json();
      message.error(data.error || '删除失败');
    }
  };

  const columns = [
    {
      title: '角色名',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, r: any) => (
        <Space>
          {r.isSystem && <LockOutlined style={{ color: '#faad14' }} />}
          {v}
        </Space>
      ),
    },
    { title: '显示名称', dataIndex: 'displayName', key: 'displayName' },
    {
      title: '类型',
      dataIndex: 'isSystem',
      key: 'isSystem',
      render: (v: boolean) => <Tag color={v ? 'gold' : 'blue'}>{v ? '系统' : '自定义'}</Tag>,
    },
    { title: '描述', dataIndex: 'description', key: 'description', render: (v: string) => v || '-' },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          {!record.isSystem && (
            <Popconfirm title="确认删除此角色?" onConfirm={() => handleDelete(record.id)}>
              <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
          {record.isSystem && <Tag>系统角色</Tag>}
        </Space>
      ),
    },
  ];

  const permColumns = [
    {
      title: '资源',
      dataIndex: 'resource',
      key: 'resource',
      fixed: 'left' as const,
      width: 180,
      render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
    },
    ...ACTIONS.map((action) => ({
      title: action,
      key: action,
      width: 80,
      align: 'center' as const,
      render: (_: any, record: { resource: string }) => (
        <Checkbox
          checked={(permissions[record.resource] || []).includes(action)}
          onChange={() => toggleAction(record.resource, action)}
        />
      ),
    })),
  ];

  const permData = RESOURCES.map((r) => ({ key: r, resource: r }));

  return (
    <>
      <PageContainer
        title="角色管理"
        description="管理系统角色和权限配置"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)} style={gradientBtnStyle}>
            创建角色
          </Button>
        }
      >
        <Table columns={columns} dataSource={roles} rowKey="id" loading={loading} size="middle" />
      </PageContainer>

      <Modal
        title="创建角色"
        open={addOpen}
        onCancel={() => { setAddOpen(false); form.resetFields(); setPermissions({}); }}
        onOk={() => form.submit()}
        width={700}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleAdd}>
          <Form.Item name="name" label="角色标识" rules={[{ required: true }]}>
            <Input placeholder="如: ops-viewer" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
            <Input placeholder="如: 运维只读" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
        <div>
          <p style={{ fontWeight: 600, marginBottom: 8, color: '#0f172a' }}>权限配置</p>
          <Table
            columns={permColumns}
            dataSource={permData}
            pagination={false}
            size="small"
            bordered
          />
        </div>
      </Modal>
    </>
  );
}
