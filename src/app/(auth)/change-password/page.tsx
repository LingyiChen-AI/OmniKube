'use client';
import { useState } from 'react';
import { Form, Input, Button, message, Alert } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import AuthBrand from '@/components/auth-brand';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { currentPassword: string; newPassword: string }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) { message.error(data.error); return; }
      message.success('密码修改成功');
      router.push('/');
    } finally { setLoading(false); }
  };

  return (
    <>
      <style>{`@media (max-width: 768px) { .auth-brand-panel { display: none !important; } }`}</style>
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <div className="auth-brand-panel" style={{ flex: 1 }}>
          <AuthBrand />
        </div>
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 24px',
          background: '#fff',
        }}>
          <div style={{ width: '100%', maxWidth: 400 }}>
            <h2 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>修改密码</h2>
            <p style={{ color: '#94a3b8', marginBottom: 24, fontSize: 14 }}>首次登录需要修改密码</p>
            <Alert message="请设置新的登录密码" type="warning" showIcon style={{ marginBottom: 24 }} />
            <Form onFinish={handleSubmit} size="large">
              <Form.Item name="currentPassword" rules={[{ required: true, message: '请输入当前密码' }]}><Input.Password prefix={<LockOutlined />} placeholder="当前密码" /></Form.Item>
              <Form.Item name="newPassword" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '密码至少 8 位' }]}><Input.Password prefix={<LockOutlined />} placeholder="新密码 (至少 8 位)" /></Form.Item>
              <Form.Item name="confirmPassword" dependencies={['newPassword']} rules={[{ required: true, message: '请确认新密码' }, ({ getFieldValue }) => ({ validator(_, value) { if (!value || getFieldValue('newPassword') === value) return Promise.resolve(); return Promise.reject(new Error('两次输入的密码不一致')); } })]}>
                <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
              </Form.Item>
              <Form.Item><Button type="primary" htmlType="submit" loading={loading} block>确认修改</Button></Form.Item>
            </Form>
          </div>
        </div>
      </div>
    </>
  );
}
