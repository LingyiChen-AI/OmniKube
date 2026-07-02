import { useCallback, useEffect, useState } from 'react';
import { Button, Form, Input, Select, Space, Tooltip, Typography, App as AntApp } from 'antd';
import {
  UserOutlined,
  LockOutlined,
  ClusterOutlined,
  SafetyCertificateOutlined,
  CodeOutlined,
  AuditOutlined,
  GlobalOutlined,
  BulbOutlined,
  BulbFilled,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, type CaptchaResp } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { useUiStore } from '../store/ui';
import BrandMark from '../components/BrandMark';
import { LANG_OPTIONS, setLanguage, type Lang } from '../i18n';

const { Title, Text } = Typography;

const FEATURES = [
  { key: 'multiCluster', icon: <ClusterOutlined /> },
  { key: 'rbac', icon: <SafetyCertificateOutlined /> },
  { key: 'webssh', icon: <CodeOutlined /> },
  { key: 'audit', icon: <AuditOutlined /> },
] as const;

export default function Login() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const setAuth = useAuthStore((s) => s.setAuth);
  const { mode, toggleMode } = useUiStore();
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const [captcha, setCaptcha] = useState<CaptchaResp | null>(null);

  const refreshCaptcha = useCallback(async () => {
    try {
      const c = await authApi.captcha();
      // Empty id means captcha is disabled server-side; hide the field.
      setCaptcha(c.id ? c : null);
    } catch {
      setCaptcha(null);
    }
    form.setFieldValue('captcha', '');
  }, [form]);

  useEffect(() => {
    void refreshCaptcha();
  }, [refreshCaptcha]);

  const onFinish = async (values: { username: string; password: string; captcha?: string }) => {
    setLoading(true);
    try {
      const { token, must_reset } = await authApi.login(
        values.username,
        values.password,
        captcha?.id,
        values.captcha,
      );
      // Fetch the profile using the fresh token, then commit token + user in a
      // single store update so the app never renders the token-without-user
      // loader over the login page (no flash on the way in).
      const me = await authApi.me(token).catch(() => null);
      setAuth(
        token,
        me ?? {
          id: 0,
          username: values.username,
          is_admin: false,
          must_reset,
          nav: { submenus: [] },
          global: {},
        },
      );
      message.success(t('login.welcome'));
      navigate(must_reset || me?.must_reset ? '/change-password' : '/dashboard', { replace: true });
    } catch {
      // error toast already surfaced by the axios interceptor.
      // Captcha is one-time: refresh it after any failed attempt.
      void refreshCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const brandMark = (
    <span className="ok-brand-mark">
      <BrandMark />
    </span>
  );

  return (
    <div className="ok-login">
      {/* Left: premium brand showcase */}
      <section className="ok-login__showcase" aria-hidden="true">
        <div className="ok-login__aurora">
          <span />
          <span />
          <span />
        </div>

        <div className="ok-login__showcase-top">
          <div className="ok-login__brand">
            {brandMark}
            OmniKube
          </div>
        </div>

        <div className="ok-login__hero">
          <span className="ok-login__eyebrow">
            <span className="ok-dot" />
            {t('login.eyebrow')}
          </span>
          <h1 className="ok-login__headline">{t('login.heroTitle')}</h1>
          <p className="ok-login__subhead">{t('login.heroSubtitle')}</p>
        </div>

        <div className="ok-login__features">
          {FEATURES.map((f) => (
            <div className="ok-login__feature" key={f.key}>
              <span className="ok-login__feature-icon">{f.icon}</span>
              <div>
                <div className="ok-login__feature-title">
                  {t(`login.features.${f.key}.title`)}
                </div>
                <div className="ok-login__feature-desc">{t(`login.features.${f.key}.desc`)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="ok-login__showcase-foot">{t('login.footer')}</div>
      </section>

      {/* Right: sign-in form */}
      <section className="ok-login__form-side">
        <div className="ok-login__corner">
          <Select
            size="small"
            variant="borderless"
            value={i18n.language as Lang}
            onChange={(v) => setLanguage(v)}
            options={LANG_OPTIONS}
            suffixIcon={<GlobalOutlined />}
            popupMatchSelectWidth={false}
            aria-label={t('topbar.language')}
          />
          <Tooltip title={t('topbar.toggleTheme')}>
            <Button
              type="text"
              shape="circle"
              aria-label={t('topbar.toggleTheme')}
              icon={mode === 'dark' ? <BulbOutlined /> : <BulbFilled />}
              onClick={toggleMode}
            />
          </Tooltip>
        </div>

        <div className="ok-login__form">
          <div className="ok-login__mobile-brand">
            {brandMark}
            OmniKube
          </div>

          <div className="ok-login__form-head">
            <Title level={3} style={{ margin: 0, fontWeight: 700 }}>
              {t('login.title')}
            </Title>
            <Text type="secondary">{t('login.subtitle')}</Text>
          </div>

          <Form form={form} layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item
              label={t('login.username')}
              name="username"
              rules={[{ required: true, message: t('login.errUsername') }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder="username"
                autoComplete="username"
                autoFocus
              />
            </Form.Item>
            <Form.Item
              label={t('login.password')}
              name="password"
              rules={[{ required: true, message: t('login.errPassword') }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </Form.Item>
            {captcha && (
              <Form.Item
                label={t('login.captcha')}
                name="captcha"
                rules={[{ required: true, message: t('login.errCaptcha') }]}
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    prefix={<SafetyCertificateOutlined />}
                    placeholder={t('login.captchaPlaceholder')}
                    autoComplete="off"
                    maxLength={4}
                  />
                  <Tooltip title={t('login.captchaRefresh')}>
                    <img
                      src={captcha.image}
                      alt={t('login.captcha')}
                      onClick={refreshCaptcha}
                      style={{
                        height: 40,
                        borderRadius: 8,
                        cursor: 'pointer',
                        border: '1px solid var(--ok-border, rgba(0,0,0,0.1))',
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>
                </Space.Compact>
              </Form.Item>
            )}
            <Form.Item style={{ marginTop: 18, marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                {t('login.signIn')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </section>
    </div>
  );
}
