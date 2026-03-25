'use client';

import { Card, Descriptions, Tag, Form, Input, Switch, Button, message, Select, Tabs, Space } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined, SaveOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import PageContainer from '@/components/page-container';

const { TextArea } = Input;

const statusMap: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
  connected: { color: 'success', label: '已连接', icon: <CheckCircleOutlined /> },
  disconnected: { color: 'default', label: '未连接', icon: <MinusCircleOutlined /> },
  error: { color: 'error', label: '连接异常', icon: <CloseCircleOutlined /> },
};

export default function ClusterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [basicForm] = Form.useForm();
  const [notifyForm] = Form.useForm();

  const { data: cluster, loading, refresh } = useRequest(async () => {
    const res = await fetch(`/api/clusters/${id}`);
    return res.json();
  });

  useEffect(() => {
    if (cluster) {
      basicForm.setFieldsValue({
        displayName: cluster.displayName,
        apiServerUrl: cluster.apiServerUrl,
        description: cluster.description || '',
      });
      notifyForm.setFieldsValue({
        webhookUrl: cluster.webhookUrl || '',
        notifyEnabled: cluster.notifyEnabled || false,
      });
    }
  }, [cluster, basicForm, notifyForm]);

  const handleSaveBasic = async (values: any) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/clusters/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          authType: cluster.authType,
        }),
      });
      if (res.ok) {
        message.success('集群信息已保存');
        refresh();
      } else {
        message.error('保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNotify = async (values: any) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/clusters/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: cluster.displayName,
          apiServerUrl: cluster.apiServerUrl,
          authType: cluster.authType,
          webhookUrl: values.webhookUrl || null,
          notifyEnabled: values.notifyEnabled || false,
        }),
      });
      if (res.ok) {
        message.success('通知配置已保存');
        refresh();
      } else {
        message.error('保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || !cluster) return <Card loading />;

  const s = statusMap[cluster.status] || statusMap.disconnected;

  return (
    <PageContainer
      title={cluster.displayName}
      description={`集群标识: ${cluster.name}`}
      extra={
        <Space>
          <Tag color={s.color} icon={s.icon}>{s.label}</Tag>
          <Button onClick={() => router.push('/clusters')}>返回列表</Button>
        </Space>
      }
    >
      <div style={{ padding: '16px 24px' }}>
        <Tabs items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Card>
                <Form form={basicForm} layout="vertical" onFinish={handleSaveBasic} style={{ maxWidth: 600 }}>
                  <Form.Item label="集群标识">
                    <Input value={cluster.name} disabled />
                  </Form.Item>
                  <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="apiServerUrl" label="API Server URL" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label="认证方式">
                    <Input value={cluster.authType === 'kubeconfig' ? 'Kubeconfig' : 'SA Token'} disabled />
                  </Form.Item>
                  <Form.Item label="更新凭证 (留空则不修改)">
                    {cluster.authType === 'kubeconfig' ? (
                      <Form.Item name="kubeconfig" noStyle>
                        <TextArea rows={6} placeholder="粘贴新的 kubeconfig YAML 内容" style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      </Form.Item>
                    ) : (
                      <Form.Item name="saToken" noStyle>
                        <TextArea rows={3} placeholder="粘贴新的 SA Token" style={{ fontFamily: 'monospace', fontSize: 12 }} />
                      </Form.Item>
                    )}
                  </Form.Item>
                  <Form.Item name="caCert" label="CA 证书 (留空则不修改)">
                    <TextArea rows={3} placeholder="CA 证书 PEM 内容" style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  </Form.Item>
                  <Form.Item name="description" label="描述">
                    <TextArea rows={2} />
                  </Form.Item>
                  <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="最后检查">
                      {cluster.lastHealthCheckAt ? new Date(cluster.lastHealthCheckAt).toLocaleString() : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="创建时间">
                      {new Date(cluster.createdAt).toLocaleString()}
                    </Descriptions.Item>
                  </Descriptions>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />}>保存</Button>
                  </Form.Item>
                </Form>
              </Card>
            ),
          },
          {
            key: 'notify',
            label: '发版通知',
            children: (
              <Card>
                <Form form={notifyForm} layout="vertical" onFinish={handleSaveNotify} style={{ maxWidth: 600 }}>
                  <Form.Item name="notifyEnabled" label="启用飞书通知" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, cur) => prev.notifyEnabled !== cur.notifyEnabled}>
                    {({ getFieldValue }) =>
                      getFieldValue('notifyEnabled') ? (
                        <Form.Item
                          name="webhookUrl"
                          label="飞书 Webhook 地址"
                          rules={[{ required: true, message: '请填写 Webhook 地址' }]}
                          extra="在飞书群设置 > 群机器人 > 自定义机器人中获取"
                        >
                          <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" />
                        </Form.Item>
                      ) : null
                    }
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />}>保存配置</Button>
                  </Form.Item>
                </Form>
              </Card>
            ),
          },
        ]} />
      </div>
    </PageContainer>
  );
}
