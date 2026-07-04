import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Descriptions, Divider, Form, Input, Modal, Select,
  Space, Steps, Table, Tag, Timeline,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  integratedDeployApi, orderedItems, DEPLOY_KINDS, DEPLOY_KIND_GROUP,
  type DeployItem, type DeployRun, type ItemResult,
} from '../../api/integratedDeploy';
import { clusterApi } from '../../api/cluster';
import { resourceApi } from '../../api/resource';
import CodeBox from '../../components/editor/CodeBox';
import { toYAML, fromYAML } from '../../components/editor/util';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';

const GROUP_KEY: Record<number, string> = {
  1: 'integratedDeploy.group1',
  2: 'integratedDeploy.group2',
  3: 'integratedDeploy.group3',
};

function phaseTag(phase: string, t: (k: string) => string) {
  const map: Record<string, { color: string; key: string }> = {
    created: { color: 'success', key: 'integratedDeploy.phaseCreated' },
    updated: { color: 'processing', key: 'integratedDeploy.phaseUpdated' },
    failed: { color: 'error', key: 'integratedDeploy.phaseFailed' },
    skipped: { color: 'default', key: 'integratedDeploy.phaseSkipped' },
  };
  const m = map[phase] ?? map.skipped;
  return <Tag color={m.color}>{t(m.key)}</Tag>;
}

export default function DeployOrderEditor() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id;
  const me = useAuthStore((s) => s.user);
  const canEdit = canGlobal('integrated_deploy', 'edit', me) || (isNew && canGlobal('integrated_deploy', 'create', me));
  const canPublish = canGlobal('integrated_deploy', 'publish', me);

  const [form] = Form.useForm();
  const [clusters, setClusters] = useState<{ id: string; name: string }[]>([]);
  const locked = !isNew; // 已存在的工单:集群/命名空间锁定(随路由重算)
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [items, setItems] = useState<DeployItem[]>([]);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [lastRun, setLastRun] = useState<DeployRun | null>(null);

  // 加载集群列表(用于新建时选择)。
  useEffect(() => {
    clusterApi.list().then((cs) => setClusters(cs.map((c) => ({ id: c.id, name: c.name })))).catch(() => undefined);
  }, []);

  // 编辑:加载工单。
  useEffect(() => {
    if (!id) return;
    integratedDeployApi.get(Number(id)).then((d) => {
      setClusterId(d.order.cluster_id);
      setNamespace(d.order.namespace);
      setItems(d.order.items ?? []);
      setRuns(d.runs ?? []);
      form.setFieldsValue({ title: d.order.title, description: d.order.description });
    }).catch(() => undefined);
  }, [id, form]);

  const preview = useMemo(() => orderedItems(items), [items]);

  // —— 增加资源条目 ——
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<'selected' | 'authored'>('selected');
  const [addKind, setAddKind] = useState('configmaps');
  const [selectableNames, setSelectableNames] = useState<string[]>([]);
  const [addName, setAddName] = useState('');
  const [addYaml, setAddYaml] = useState('');

  const openAdd = (mode: 'selected' | 'authored') => {
    setAddMode(mode);
    setAddKind('configmaps');
    setAddName('');
    setAddYaml('');
    setSelectableNames([]);
    setAddOpen(true);
  };

  // 选取模式:拉可选资源名单(按写权限过滤)。
  useEffect(() => {
    if (!addOpen || addMode !== 'selected' || !clusterId || !namespace) return;
    integratedDeployApi.selectable(clusterId, namespace, addKind).then(setSelectableNames).catch(() => setSelectableNames([]));
  }, [addOpen, addMode, addKind, clusterId, namespace]);

  const confirmAdd = async () => {
    let yamlText = addYaml;
    let name = addName;
    if (addMode === 'selected') {
      if (!name) {
        message.error(t('integratedDeploy.selectResource'));
        return;
      }
      // 快照选中资源当前 YAML。
      try {
        const obj = await resourceApi.get(namespace, addKind, name);
        yamlText = toYAML(obj);
      } catch {
        message.error(t('integratedDeploy.selectResource'));
        return;
      }
    } else {
      // 手写模式:从 YAML 解析出 metadata.name,立即用于表格/预览显示。
      try {
        const obj = fromYAML(addYaml);
        const parsedName = obj.metadata?.name;
        if (!parsedName) {
          message.error(t('integratedDeploy.nameRequired'));
          return;
        }
        name = parsedName;
      } catch {
        message.error(t('integratedDeploy.nameRequired'));
        return;
      }
    }
    const nextIndex = items.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[addKind]).length;
    setItems([...items, { kind: addKind, name, source: addMode, manifest_yaml: yamlText, sort_index: nextIndex }]);
    setAddOpen(false);
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const save = async () => {
    const v = await form.validateFields();
    const body = { cluster_id: clusterId, namespace, title: v.title, description: v.description ?? '', items };
    try {
      if (isNew) {
        const created = await integratedDeployApi.create(body);
        message.success(t('integratedDeploy.saved'));
        navigate(`/integrated-deploy/orders/${created.id}`);
      } else {
        await integratedDeployApi.update(Number(id), body);
        message.success(t('integratedDeploy.saved'));
      }
    } catch {
      /* interceptor toast */
    }
  };

  const doPublish = () => {
    Modal.confirm({
      title: t('integratedDeploy.publishConfirmTitle'),
      width: 560,
      content: (
        <div>
          <p>{t('integratedDeploy.publishConfirmDesc')}</p>
          <Steps
            direction="vertical"
            size="small"
            items={preview.map((it) => ({ title: `${it.kind}/${it.name}`, status: 'wait' }))}
          />
        </div>
      ),
      onOk: async () => {
        const run = await integratedDeployApi.publish(Number(id));
        setLastRun(run);
        setRuns([run, ...runs]);
      },
    });
  };

  const itemColumns = [
    { title: t('integratedDeploy.kind'), dataIndex: 'kind' },
    { title: t('integratedDeploy.resourceName'), dataIndex: 'name' },
    {
      title: t('integratedDeploy.source'),
      dataIndex: 'source',
      render: (s: string) =>
        s === 'selected' ? t('integratedDeploy.addSelected') : t('integratedDeploy.addAuthored'),
    },
    {
      title: t('integratedDeploy.actions'),
      key: 'x',
      render: (_: unknown, _r: DeployItem, idx: number) =>
        canEdit ? <Button size="small" danger onClick={() => removeItem(idx)}>{t('integratedDeploy.delete')}</Button> : null,
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title={t('integratedDeploy.title')}>
        <Form form={form} layout="vertical" disabled={!canEdit}>
          <Space size={16} wrap>
            <Form.Item label={t('integratedDeploy.cluster')} required>
              <Select
                style={{ width: 200 }}
                value={clusterId || undefined}
                disabled={locked}
                onChange={setClusterId}
                options={clusters.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
            <Form.Item label={t('integratedDeploy.namespace')} required>
              <Input style={{ width: 200 }} value={namespace} disabled={locked} onChange={(e) => setNamespace(e.target.value)} />
            </Form.Item>
          </Space>
          <Form.Item name="title" label={t('integratedDeploy.orderTitle')} rules={[{ required: true }]}>
            <Input style={{ maxWidth: 420 }} />
          </Form.Item>
          <Form.Item name="description" label={t('integratedDeploy.description')}>
            <Input.TextArea rows={2} style={{ maxWidth: 640 }} />
          </Form.Item>
        </Form>
      </Card>

      <Card
        title={t('integratedDeploy.items')}
        extra={
          canEdit && (
            <Space>
              <Button onClick={() => openAdd('selected')} disabled={!clusterId || !namespace}>
                {t('integratedDeploy.addSelected')}
              </Button>
              <Button onClick={() => openAdd('authored')}>{t('integratedDeploy.addAuthored')}</Button>
            </Space>
          )
        }
      >
        <Table rowKey={(_, i) => String(i)} columns={itemColumns} dataSource={items} pagination={false} size="small" />
        <Divider>{t('integratedDeploy.orderPreview')}</Divider>
        <Steps
          direction="vertical"
          size="small"
          items={preview.map((it) => ({
            title: `${it.kind}/${it.name}`,
            description: t(GROUP_KEY[DEPLOY_KIND_GROUP[it.kind] ?? 3]),
            status: 'process',
          }))}
        />
      </Card>

      <Space>
        {canEdit && <Button type="primary" onClick={save}>{t('integratedDeploy.save')}</Button>}
        {!isNew && canPublish && <Button onClick={doPublish}>{t('integratedDeploy.publish')}</Button>}
        <Button onClick={() => navigate('/integrated-deploy')}>{t('common.back') || '返回'}</Button>
      </Space>

      {lastRun && (
        <Card title={t('integratedDeploy.publishResult')}>
          <Timeline
            items={lastRun.results.map((r: ItemResult) => ({
              color: r.phase === 'failed' ? 'red' : r.phase === 'skipped' ? 'gray' : 'green',
              children: (
                <span>
                  {r.kind}/{r.name} {phaseTag(r.phase, t)} {r.message && <span style={{ color: '#cf1322' }}>{r.message}</span>}
                </span>
              ),
            }))}
          />
        </Card>
      )}

      {!isNew && runs.length > 0 && (
        <Card title={t('integratedDeploy.publishHistory')}>
          {runs.map((r) => (
            <Descriptions key={r.id} size="small" column={1} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={r.created_at}>
                <Tag color={r.status === 'failed' ? 'error' : 'success'}>
                  {r.status === 'failed' ? t('integratedDeploy.statusFailed') : t('integratedDeploy.statusSucceeded')}
                </Tag>
                {' — '}{r.username}
              </Descriptions.Item>
            </Descriptions>
          ))}
        </Card>
      )}

      <Modal
        open={addOpen}
        title={addMode === 'selected' ? t('integratedDeploy.addSelected') : t('integratedDeploy.addAuthored')}
        onOk={confirmAdd}
        onCancel={() => setAddOpen(false)}
        width={720}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: 240 }}
            value={addKind}
            onChange={setAddKind}
            options={DEPLOY_KINDS.map((k) => ({ value: k, label: k }))}
          />
          {addMode === 'selected' ? (
            <Select
              style={{ width: '100%' }}
              placeholder={t('integratedDeploy.selectResource')}
              value={addName || undefined}
              onChange={setAddName}
              options={selectableNames.map((n) => ({ value: n, label: n }))}
              notFoundContent={t('integratedDeploy.noSelectable')}
            />
          ) : (
            <CodeBox label="YAML" minHeight={280} value={addYaml} onChange={setAddYaml} />
          )}
        </Space>
      </Modal>
    </Space>
  );
}
