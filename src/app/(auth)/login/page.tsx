'use client';
import { useState, useEffect } from 'react';
import { Form, Input, Button, Tabs, App } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import AuthBrand from '@/components/auth-brand';
import { gradientBtnStyle } from '@/lib/styles';
import { request, withBasePath } from '@/lib/request';

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [smtpEnabled, setSmtpEnabled] = useState(false);

  useEffect(() => {
    request('/api/auth/smtp-status').then(r => r.json()).then(d => setSmtpEnabled(d.enabled)).catch(() => {});
  }, []);

  const handlePasswordLogin = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      if (!res.ok) { const data = await res.json().catch(() => null); message.error(data?.error || '登录失败，请稍后再试'); return; }
      const data = await res.json();
      // Clear cluster selection so the new user doesn't inherit previous user's choice
      localStorage.removeItem('k8s-cluster');
      if (data.mustChangePassword) { window.location.href = withBasePath('/change-password'); } else { window.location.href = withBasePath('/'); }
    } finally { setLoading(false); }
  };

  const handleSendCode = async (email: string) => {
    const res = await request('/api/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    if (res.ok) {
      message.success('验证码已发送，请查收邮箱');
      setCountdown(60);
      const timer = setInterval(() => { setCountdown((c) => { if (c <= 1) { clearInterval(timer); return 0; } return c - 1; }); }, 1000);
    } else {
      const data = await res.json().catch(() => null);
      message.error(data?.error || '验证码发送失败');
    }
  };

  const handleCodeLogin = async (values: { email: string; code: string }) => {
    setLoading(true);
    try {
      const res = await request('/api/auth/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      if (!res.ok) { const data = await res.json().catch(() => null); message.error(data?.error || '登录失败，请稍后再试'); return; }
      const data = await res.json();
      localStorage.removeItem('k8s-cluster');
      if (data.mustChangePassword) { window.location.href = withBasePath('/change-password'); } else { window.location.href = withBasePath('/'); }
    } finally { setLoading(false); }
  };

  return (
    <>
      <style>{`
        html, body { margin: 0; padding: 0; overflow: hidden; height: 100%; }
        @media (max-width: 768px) { .auth-brand-panel { display: none !important; } }
      `}</style>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <div className="auth-brand-panel" style={{ flex: 1, minWidth: 0, height: '100vh' }}>
          <AuthBrand />
        </div>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 24px',
          background: '#fff',
          overflowY: 'auto',
        }}>
          <div style={{ width: '100%', maxWidth: 380 }}>
            <h2 style={{ fontSize: 26, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
              欢迎回来
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: 36, fontSize: 14 }}>
              登录以继续管理集群
            </p>
            <Tabs
              centered
              items={[
                {
                  key: 'password',
                  label: '账号密码',
                  children: (
                    <Form onFinish={handlePasswordLogin} size="large" style={{ marginTop: 8 }}>
                      <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                        <Input
                          prefix={<UserOutlined style={{ color: '#94a3b8' }} />}
                          placeholder="用户名"
                          style={{ borderRadius: 8, height: 44 }}
                        />
                      </Form.Item>
                      <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                        <Input.Password
                          prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
                          placeholder="密码"
                          style={{ borderRadius: 8, height: 44 }}
                        />
                      </Form.Item>
                      <Form.Item style={{ marginTop: 8 }}>
                        <Button
                          type="primary"
                          htmlType="submit"
                          loading={loading}
                          block
                          style={{ ...gradientBtnStyle, height: 44, borderRadius: 8, fontSize: 15, fontWeight: 600 }}
                        >
                          登录
                        </Button>
                      </Form.Item>
                    </Form>
                  ),
                },
                {
                  key: 'email',
                  label: '邮箱验证码',
                  children: smtpEnabled ? (
                    <Form onFinish={handleCodeLogin} size="large" style={{ marginTop: 8 }}>
                      <Form.Item name="email" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
                        <Input
                          prefix={<MailOutlined style={{ color: '#94a3b8' }} />}
                          placeholder="邮箱"
                          style={{ borderRadius: 8, height: 44 }}
                          suffix={
                            <Button
                              type="link"
                              size="small"
                              disabled={countdown > 0}
                              onClick={(e) => {
                                e.preventDefault();
                                const form = (e.target as HTMLElement).closest('form');
                                const emailInput = form?.querySelector<HTMLInputElement>('input[type="email"], input[id*="email"]');
                                if (emailInput?.value) handleSendCode(emailInput.value);
                              }}
                            >
                              {countdown > 0 ? `${countdown}s` : '发送验证码'}
                            </Button>
                          }
                        />
                      </Form.Item>
                      <Form.Item name="code" rules={[{ required: true, message: '请输入验证码' }]}>
                        <Input
                          prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
                          placeholder="6位验证码"
                          maxLength={6}
                          style={{ borderRadius: 8, height: 44 }}
                        />
                      </Form.Item>
                      <Form.Item style={{ marginTop: 8 }}>
                        <Button
                          type="primary"
                          htmlType="submit"
                          loading={loading}
                          block
                          style={{ ...gradientBtnStyle, height: 44, borderRadius: 8, fontSize: 15, fontWeight: 600 }}
                        >
                          登录
                        </Button>
                      </Form.Item>
                    </Form>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '32px 0', color: '#94a3b8', fontSize: 14 }}>
                      <MailOutlined style={{ fontSize: 32, color: '#cbd5e1', display: 'block', marginBottom: 12 }} />
                      未启用邮箱登录
                      <div style={{ fontSize: 12, marginTop: 4, color: '#cbd5e1' }}>
                        请配置 SMTP 相关环境变量以启用此功能
                      </div>
                    </div>
                  ),
                },
              ]}
            />

            <div style={{ textAlign: 'center', marginTop: 32, color: '#cbd5e1', fontSize: 12 }}>
              K8s Admin &copy; {new Date().getFullYear()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
