'use client';
import { useState } from 'react';
import { Form, Input, Button, Tabs, message } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import AuthBrand from '@/components/auth-brand';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const handlePasswordLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) { message.error(data.error); return; }
      if (data.mustChangePassword) { router.push('/change-password'); } else { router.push('/'); }
    } finally { setLoading(false); }
  };

  const handleSendCode = async (email: string) => {
    const res = await fetch('/api/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (res.ok) {
      message.success('验证码已发送');
      setCountdown(60);
      const timer = setInterval(() => { setCountdown((c) => { if (c <= 1) { clearInterval(timer); return 0; } return c - 1; }); }, 1000);
    }
  };

  const handleCodeLogin = async (values: { email: string; code: string }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const data = await res.json();
      if (!res.ok) { message.error(data.error); return; }
      if (data.mustChangePassword) { router.push('/change-password'); } else { router.push('/'); }
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
            <h2 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>欢迎回来</h2>
            <p style={{ color: '#94a3b8', marginBottom: 32, fontSize: 14 }}>登录以继续管理集群</p>
            <Tabs centered items={[
              { key: 'password', label: '账号密码', children: (
                <Form onFinish={handlePasswordLogin} size="large">
                  <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}><Input prefix={<UserOutlined />} placeholder="用户名" /></Form.Item>
                  <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} placeholder="密码" /></Form.Item>
                  <Form.Item><Button type="primary" htmlType="submit" loading={loading} block>登录</Button></Form.Item>
                </Form>
              )},
              { key: 'email', label: '邮箱验证码', children: (
                <Form onFinish={handleCodeLogin} size="large">
                  <Form.Item name="email" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
                    <Input prefix={<MailOutlined />} placeholder="邮箱" suffix={
                      <Button type="link" size="small" disabled={countdown > 0} onClick={(e) => {
                        e.preventDefault();
                        const form = (e.target as HTMLElement).closest('form');
                        const emailInput = form?.querySelector<HTMLInputElement>('input[type="email"], input[id*="email"]');
                        if (emailInput?.value) handleSendCode(emailInput.value);
                      }}>{countdown > 0 ? `${countdown}s` : '发送验证码'}</Button>
                    } />
                  </Form.Item>
                  <Form.Item name="code" rules={[{ required: true, message: '请输入验证码' }]}><Input prefix={<LockOutlined />} placeholder="6位验证码" maxLength={6} /></Form.Item>
                  <Form.Item><Button type="primary" htmlType="submit" loading={loading} block>登录</Button></Form.Item>
                </Form>
              )},
            ]} />
          </div>
        </div>
      </div>
    </>
  );
}
