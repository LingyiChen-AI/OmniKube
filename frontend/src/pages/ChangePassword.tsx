import { useState } from 'react';
import { Alert, Button, Form, Input, Select, Tooltip, Typography, App as AntApp } from 'antd';
import {
  LockOutlined,
  GlobalOutlined,
  BulbOutlined,
  BulbFilled,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../api/auth';
import { useAuthStore } from '../store/auth';
import { useUiStore } from '../store/ui';
import BrandMark from '../components/BrandMark';
import { LANG_OPTIONS, setLanguage, type Lang } from '../i18n';

const { Title, Text } = Typography;

export default function ChangePassword() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const { user, token, clearMustReset } = useAuthStore();
  const { mode, toggleMode } = useUiStore();
  const [loading, setLoading] = useState(false);
  const forced = !!user?.must_reset;

  if (!token) {
    navigate('/login', { replace: true });
  }

  const onFinish = async (values: { old_password: string; new_password: string }) => {
    setLoading(true);
    try {
      await authApi.changePassword(values.old_password, values.new_password);
      clearMustReset();
      message.success(t('changePassword.updated'));
      navigate('/dashboard', { replace: true });
    } catch {
      // interceptor handles the toast
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
      {/* Left: brand showcase (matches the sign-in screen) */}
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
          <h1 className="ok-login__headline">
            {forced ? t('changePassword.setNew') : t('changePassword.change')}
          </h1>
          <p className="ok-login__subhead">
            {forced ? t('changePassword.forcedSubtitle') : t('changePassword.normalSubtitle')}
          </p>
        </div>

        <div className="ok-login__showcase-foot">{t('login.footer')}</div>
      </section>

      {/* Right: password form */}
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
              {forced ? t('changePassword.setNew') : t('changePassword.change')}
            </Title>
            <Text type="secondary">
              {forced ? t('changePassword.forcedSubtitle') : t('changePassword.normalSubtitle')}
            </Text>
          </div>

          {forced && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 18 }}
              message={t('changePassword.forcedAlert')}
            />
          )}

          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item
              label={t('changePassword.current')}
              name="old_password"
              rules={[{ required: true, message: t('changePassword.errCurrent') }]}
            >
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
            </Form.Item>
            <Form.Item
              label={t('changePassword.new')}
              name="new_password"
              rules={[
                { required: true, message: t('changePassword.errNew') },
                { min: 8, message: t('changePassword.errMin') },
              ]}
              hasFeedback
            >
              <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              label={t('changePassword.confirm')}
              name="confirm"
              dependencies={['new_password']}
              hasFeedback
              rules={[
                { required: true, message: t('changePassword.errConfirm') },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                    return Promise.reject(new Error(t('changePassword.mismatch')));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
            </Form.Item>
            <Form.Item style={{ marginTop: 18, marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" size="large" block loading={loading}>
                {t('changePassword.update')}
              </Button>
            </Form.Item>
          </Form>
        </div>
      </section>
    </div>
  );
}
