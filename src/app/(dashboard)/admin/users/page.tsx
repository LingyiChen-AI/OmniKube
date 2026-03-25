'use client';

import { useState } from 'react';
import {
  Table, Button, Tag, Space, Popconfirm, message, Modal, Form, Input, Select,
} from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';

export default function UsersPage() {
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<any>(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const { data: users = [], loading, refresh } = useRequest(async () => {
    const res = await fetch('/api/admin/users');
    return res.json();
  });

  const { data: roles = [] } = useRequest(async () => {
    const res = await fetch('/api/admin/roles');
    return res.json();
  });

  const handleAdd = async (values: any) => {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    if (res.ok) {
      message.success('用户创建成功');
      setAddOpen(false);
      addForm.resetFields();
      refresh();
    } else {
      const data = await res.json();
      message.error(data.error || '创建失败');
    }
  };

  const handleEdit = async (values: any) => {
    const res = await fetch(`/api/admin/users/${editUser.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, username: editUser.username }),
    });
    if (res.ok) {
      message.success('更新成功');
      setEditUser(null);
      refresh();
    } else {
      message.error('更新失败');
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    message.success('已删除');
    refresh();
  };

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    {
      title: '状态',
      dataIndex: 'isActive',
      key: 'isActive',
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '需要改密',
      dataIndex: 'mustChangePassword',
      key: 'mustChangePassword',
      render: (v: boolean) => v ? <Tag color="orange">是</Tag> : <Tag>否</Tag>,
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      render: (t: string) => t ? new Date(t).toLocaleString() : '-',
    },
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
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditUser(record);
              editForm.setFieldsValue({ email: record.email, isActive: record.isActive });
            }}
          >
            编辑
          </Button>
          <Popconfirm title="确认删除此用户?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <h2>用户管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          添加用户
        </Button>
      </div>
      <Table columns={columns} dataSource={users} rowKey="id" loading={loading} size="small" />

      {/* Add User Modal */}
      <Modal
        title="添加用户"
        open={addOpen}
        onCancel={() => { setAddOpen(false); addForm.resetFields(); }}
        onOk={() => addForm.submit()}
        destroyOnClose
      >
        <Form form={addForm} layout="vertical" onFinish={handleAdd}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 6 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name={['roleBindings', 0, 'roleId']} label="角色">
            <Select
              placeholder="选择角色"
              allowClear
              options={roles.map((r: any) => ({ value: r.id, label: r.displayName }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        title="编辑用户"
        open={!!editUser}
        onCancel={() => setEditUser(null)}
        onOk={() => editForm.submit()}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="isActive" label="状态">
            <Select options={[{ value: true, label: '启用' }, { value: false, label: '禁用' }]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
