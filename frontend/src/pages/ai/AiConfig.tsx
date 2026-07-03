import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, InputNumber, Select, Switch } from 'antd';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../../api/ai';
import { useClusterStore } from '../../store/clusters';
import { ResourceOpsMatrix } from '../roles/Roles';
import type { Operations } from '../../api/role';

export default function AiConfig() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [hasKey, setHasKey] = useState(false);
  const { clusters, load: loadClusters } = useClusterStore();
  const [grantCluster, setGrantCluster] = useState<string>();
  const [ops, setOps] = useState<Operations>({});

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);
  useEffect(() => {
    aiApi.getConfig().then((c) => {
      setHasKey(c.has_key);
      form.setFieldsValue({ ...c, api_key: '' });
    });
  }, [form]);
  useEffect(() => {
    if (grantCluster) aiApi.getGrants(grantCluster).then(setOps);
  }, [grantCluster]);

  const saveConfig = async () => {
    const v = await form.validateFields();
    await aiApi.putConfig(v);
    message.success(t('ai.saved'));
    setHasKey(!!v.api_key || hasKey);
  };
  const saveGrants = async () => {
    if (!grantCluster) return;
    await aiApi.putGrants(grantCluster, ops);
    message.success(t('ai.saved'));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title={t('ai.modelConfig')}>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ai.enabled')} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="Base URL" name="base_url">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label={t('ai.apiKey')} name="api_key">
            <Input.Password placeholder={hasKey ? '••••••（已设置，留空保留）' : ''} autoComplete="off" />
          </Form.Item>
          <Form.Item label="Model" name="model_id">
            <Input placeholder="gpt-4o-mini" />
          </Form.Item>
          <Form.Item label={t('ai.temperature')} name="temperature">
            <InputNumber min={0} max={2} step={0.1} />
          </Form.Item>
          <Form.Item label={t('ai.maxSteps')} name="max_steps">
            <InputNumber min={1} max={50} />
          </Form.Item>
          <Form.Item label={t('ai.systemPrompt')} name="system_prompt">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Button type="primary" onClick={saveConfig}>
            {t('ai.save')}
          </Button>
        </Form>
      </Card>

      <Card title={t('ai.permScope')}>
        <Select
          style={{ width: 280, marginBottom: 12 }}
          placeholder={t('ai.selectCluster')}
          value={grantCluster}
          onChange={setGrantCluster}
          options={clusters.map((c) => ({ value: c.id, label: c.name || c.id }))}
        />
        {grantCluster && (
          <>
            <ResourceOpsMatrix operations={ops} onChange={setOps} />
            <div style={{ marginTop: 12 }}>
              <Button type="primary" onClick={saveGrants}>
                {t('ai.save')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
