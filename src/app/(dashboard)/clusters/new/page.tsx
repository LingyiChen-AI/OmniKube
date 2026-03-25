'use client';

import { Form, Input, Select, Button, Card, message, Switch, Divider, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { gradientBtnStyle } from '@/lib/styles';

const { TextArea } = Input;
const { Text } = Typography;

export default function NewClusterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [authType, setAuthType] = useState('token');
  const [notifyEnabled, setNotifyEnabled] = useState(false);

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      const res = await fetch('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, notifyEnabled }),
      });
      if (res.ok) {
        message.success('集群添加成功');
        router.push('/clusters');
      } else {
        const data = await res.json();
        message.error(data.error || '添加失败');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="添加集群" style={{ maxWidth: 700 }}>
      <Form layout="vertical" onFinish={handleSubmit} initialValues={{ authType: 'token' }}>
        <Form.Item name="name" label="集群标识" rules={[{ required: true }]}>
          <Input placeholder="如: production, staging" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}>
          <Input placeholder="如: 生产环境" />
        </Form.Item>
        <Form.Item name="apiServerUrl" label="API Server URL" rules={[{ required: true }]}>
          <Input placeholder="https://kubernetes.example.com:6443" />
        </Form.Item>
        <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
          <Select onChange={setAuthType}>
            <Select.Option value="token">ServiceAccount Token</Select.Option>
            <Select.Option value="kubeconfig">Kubeconfig</Select.Option>
          </Select>
        </Form.Item>
        {authType === 'token' && (
          <Form.Item name="saToken" label="SA Token" rules={[{ required: true }]}>
            <TextArea rows={4} placeholder="ServiceAccount Bearer Token" />
          </Form.Item>
        )}
        {authType === 'kubeconfig' && (
          <Form.Item name="kubeconfig" label="Kubeconfig" rules={[{ required: true }]}>
            <TextArea rows={8} placeholder="粘贴 kubeconfig YAML 内容" style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </Form.Item>
        )}
        <Form.Item name="caCert" label="CA 证书 (可选)">
          <TextArea rows={4} placeholder="CA 证书 PEM 内容" style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <TextArea rows={2} />
        </Form.Item>

        <Divider>发版通知</Divider>

        <Form.Item label="启用飞书通知">
          <Switch checked={notifyEnabled} onChange={setNotifyEnabled} />
          <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
            发布/回滚时自动推送通知到飞书群
          </Text>
        </Form.Item>
        {notifyEnabled && (
          <Form.Item
            name="webhookUrl"
            label="飞书 Webhook 地址"
            rules={[{ required: true, message: '启用通知时必须填写 Webhook 地址' }]}
          >
            <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" />
          </Form.Item>
        )}

        <Form.Item style={{ marginTop: 24 }}>
          <Button type="primary" htmlType="submit" loading={loading} style={gradientBtnStyle}>添加</Button>
          <Button style={{ marginLeft: 8 }} onClick={() => router.back()}>取消</Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
