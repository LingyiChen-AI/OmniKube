import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Col, Collapse, Empty, Form, Input, InputNumber, Row, Skeleton, Switch } from 'antd';
import { useTranslation } from 'react-i18next';
import { aiApi } from '../../api/ai';
import { useClusterStore } from '../../store/clusters';
import { ResourceOpsMatrix } from '../roles/Roles';
import CodeBox from '../../components/editor/CodeBox';
import type { Operations } from '../../api/role';

/** Default OmniKube system prompt shown when none is configured yet. */
const DEFAULT_SYSTEM_PROMPT = `你是 OmniKube,一个 Kubernetes 多集群运维助手。你在用户当前选中的集群里,按用户的自然语言帮助查询和操作资源(部署、Pod、服务、配置等)。

规则:
- 严格遵守权限:只执行被授权、且当前用户本人也有权限的操作;无权限时如实说明,绝不臆造或越权。
- 写操作(创建/修改/删除)必须先清晰展示将要执行的动作,等用户确认后才执行。
- 不确定现状时先查询再行动;优先用最小、安全的操作达成目标。
- 回答简洁准确,使用中文;涉及资源时给出命名空间与名称。`;

/** Per-cluster AI permission matrix: lazily loads that cluster's grants when the
 *  panel is expanded, edits locally, and saves independently. */
function ClusterGrantPanel({ clusterId }: { clusterId: string }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [ops, setOps] = useState<Operations>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    aiApi
      .getGrants(clusterId)
      .then((o) => {
        if (active) {
          setOps(o);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clusterId]);

  const save = async () => {
    setSaving(true);
    try {
      await aiApi.putGrants(clusterId, ops);
      message.success(t('ai.saved'));
    } catch {
      /* interceptor toast */
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;
  return (
    <>
      <ResourceOpsMatrix operations={ops} onChange={setOps} />
      <div style={{ marginTop: 12 }}>
        <Button type="primary" loading={saving} onClick={save}>
          {t('ai.save')}
        </Button>
      </div>
    </>
  );
}

export default function AiConfig() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [hasKey, setHasKey] = useState(false);
  const { clusters, load: loadClusters } = useClusterStore();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);
  useEffect(() => {
    let active = true;
    aiApi.getConfig().then((c) => {
      if (!active) return;
      setHasKey(c.has_key);
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
      <Card title={t('ai.modelConfig')}>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ai.enabled')} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
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
            <CodeBox label="SYSTEM" minHeight={160} />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={saveConfig}>
            {t('ai.save')}
          </Button>
        </Form>
      </Card>

      <Card title={t('ai.permScope')}>
        {clusters.length === 0 ? (
          <Empty description={t('ai.noClusters')} />
        ) : (
          <Collapse
            accordion
            destroyInactivePanel
            items={clusters.map((c) => ({
              key: c.id,
              label: c.name || c.id,
              children: <ClusterGrantPanel clusterId={c.id} />,
            }))}
          />
        )}
      </Card>
    </div>
  );
}
