import { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Col, Form, Input, InputNumber, Row, Switch, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../../api/ai';
import CodeBox from '../../components/editor/CodeBox';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';

/** Default OmniKube system prompt shown when none is configured yet. */
const DEFAULT_SYSTEM_PROMPT = `你是 OmniKube,一个 Kubernetes 多集群运维助手。你在用户当前选中的集群里,按用户的自然语言帮助查询和操作资源(部署、Pod、服务、配置等)。

规则:
- 严格遵守权限:只执行被授权、且当前用户本人也有权限的操作;无权限时如实说明,绝不臆造或越权。
- 写操作(创建/修改/删除)必须先清晰展示将要执行的动作,等用户确认后才执行。
- 不确定现状时先查询再行动;优先用最小、安全的操作达成目标。
- 回答简洁准确,使用中文;涉及资源时给出命名空间与名称。`;

export default function AiConfig() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  // Enable/disable is a separate permission (ai:create) from editing config (ai:edit).
  const me = useAuthStore((s) => s.user);
  const canToggle = canGlobal('ai', 'create', me);
  const canEdit = canGlobal('ai', 'edit', me);
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    let active = true;
    aiApi.getConfig().then((c) => {
      if (!active) return;
      setHasKey(c.has_key);
      setEnabled(c.enabled);
      form.setFieldsValue({
        ...c,
        api_key: '',
        system_prompt: c.system_prompt || DEFAULT_SYSTEM_PROMPT,
      });
    });
    return () => {
      active = false;
    };
  }, [form]);

  const toggleEnabled = async (next: boolean) => {
    setToggling(true);
    setEnabled(next); // optimistic
    try {
      await aiApi.setEnabled(next);
      message.success(t('ai.saved'));
    } catch {
      setEnabled(!next); // revert on failure
    } finally {
      setToggling(false);
    }
  };

  const saveConfig = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await aiApi.putConfig(v);
      message.success(t('ai.saved'));
      setHasKey(!!v.api_key || hasKey);
    } catch {
      /* interceptor toast */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert type="info" showIcon message={t('ai.followsUserPermsTitle')} description={t('ai.followsUserPerms')} />
      <Card title={t('ai.modelConfig')}>
        {/* Enable switch is OUTSIDE the config form: its own permission (ai:create) + endpoint. */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 6, color: 'rgba(0,0,0,0.88)' }}>{t('ai.enabled')}</div>
          <Tooltip title={!canToggle ? t('ai.enableNoPerm') : undefined}>
            <Switch checked={enabled} loading={toggling} disabled={!canToggle} onChange={toggleEnabled} />
          </Tooltip>
          {!canToggle && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{t('ai.enableNoPerm')}</div>
          )}
        </div>
        <Form form={form} layout="vertical" disabled={!canEdit}>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('ai.baseUrl')} name="base_url">
                <Input placeholder="https://api.openai.com/v1" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('ai.model')} name="model_id">
                <Input placeholder="gpt-4o-mini" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('ai.apiKey')} name="api_key">
            <Input.Password placeholder={hasKey ? t('ai.apiKeySet') : ''} autoComplete="off" />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={12} sm={12}>
              <Form.Item label={t('ai.temperature')} name="temperature">
                <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={12}>
              <Form.Item label={t('ai.maxSteps')} name="max_steps">
                <InputNumber min={1} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('ai.systemPrompt')} name="system_prompt">
            <CodeBox label="SYSTEM" minHeight={160} readOnly={!canEdit} />
          </Form.Item>
          {canEdit && (
            <Button type="primary" loading={saving} onClick={saveConfig}>
              {t('ai.save')}
            </Button>
          )}
        </Form>
      </Card>
    </div>
  );
}
