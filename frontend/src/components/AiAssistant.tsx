import { useEffect, useState } from 'react';
import { App as AntApp, Badge, Button, Drawer, Empty, Input, Tooltip } from 'antd';
import { RobotOutlined, WarningOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../api/ai';

export default function AiAssistant() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    aiApi
      .status()
      .then((s) => {
        if (active) setReady(s.enabled && s.configured);
      })
      .catch(() => {
        if (active) setReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const onClick = () => {
    if (!ready) {
      message.warning(t('ai.notConfigured'));
      return;
    }
    setOpen(true);
  };

  return (
    <>
      {/* Fixed wrapper so nothing (Badge/Tooltip spans) leaks into normal flow
          and adds page height — that caused a white strip under the layout. */}
      <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1000 }}>
        <Tooltip title="OmniKube" placement="left">
          <Badge count={ready ? 0 : <WarningOutlined style={{ color: '#F59E0B' }} />} offset={[-4, 4]}>
            <Button
              aria-label="OmniKube assistant"
              type="primary"
              shape="circle"
              size="large"
              icon={<RobotOutlined />}
              onClick={onClick}
            />
          </Badge>
        </Tooltip>
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} width="min(480px, 92vw)" title="OmniKube">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <Empty description={t('ai.comingSoon')} />
          </div>
          <Input.TextArea rows={2} placeholder={t('ai.askPlaceholder')} disabled />
        </div>
      </Drawer>
    </>
  );
}
