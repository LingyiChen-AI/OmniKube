'use client';

import { useState } from 'react';
import { Button, Table, Tag, Space, Popconfirm, message } from 'antd';
import {
  PlusOutlined, DeleteOutlined, ApiOutlined, EditOutlined,
  CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined, LoadingOutlined,
} from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { useRequest } from 'ahooks';
import PageContainer from '@/components/page-container';
import { gradientBtnStyle } from '@/lib/styles';

const statusMap: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  connected: { color: 'success', label: '已连接', icon: <CheckCircleOutlined /> },
  disconnected: { color: 'default', label: '未连接', icon: <MinusCircleOutlined /> },
  error: { color: 'error', label: '连接异常', icon: <CloseCircleOutlined /> },
};

const authTypeMap: Record<string, string> = {
  kubeconfig: 'Kubeconfig',
  token: 'SA Token',
};

export default function ClustersPage() {
  const router = useRouter();
  const [testingId, setTestingId] = useState<string | null>(null);

  const { data: clusters = [], loading, refresh } = useRequest(async () => {
    const res = await fetch('/api/clusters');
    return res.json();
  });

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch(`/api/clusters/${id}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        message.success(`连接成功，K8s 版本: ${data.version}`);
      } else {
        message.error(`连接失败: ${data.error}`);
      }
      refresh();
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/clusters/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      message.error(data.error || '删除失败');
      return;
    }
    message.success('已删除');
    refresh();
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (text: string, record: any) => (
        <a onClick={() => router.push(`/clusters/${record.id}`)} style={{ fontWeight: 500 }}>{text}</a>
      ),
    },
    { title: '标识', dataIndex: 'name', key: 'name' },
    {
      title: 'API Server',
      dataIndex: 'apiServerUrl',
      key: 'apiServerUrl',
      ellipsis: true,
      render: (url: string) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.8 }}>{url}</span>
      ),
    },
    {
      title: '认证方式',
      dataIndex: 'authType',
      key: 'authType',
      render: (type: string) => authTypeMap[type] || type,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const s = statusMap[status] || statusMap.disconnected;
        return <Tag color={s.color} icon={s.icon}>{s.label}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right' as const,
      width: 220,
      render: (_: any, record: any) => (
        <Space size="middle">
          <Button
            size="small"
            type="link"
            icon={testingId === record.id ? <LoadingOutlined /> : <ApiOutlined />}
            loading={testingId === record.id}
            onClick={() => handleTest(record.id)}
          >
            测试
          </Button>
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            onClick={() => router.push(`/clusters/${record.id}`)}
          >
            编辑
          </Button>
          <Popconfirm title="确认删除此集群?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <PageContainer
      title="集群管理"
      description="管理和监控 Kubernetes 集群连接"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/clusters/new')} style={gradientBtnStyle}>
          添加集群
        </Button>
      }
    >
      <Table
        columns={columns}
        dataSource={clusters}
        rowKey="id"
        loading={loading}
        size="middle"
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </PageContainer>
  );
}
