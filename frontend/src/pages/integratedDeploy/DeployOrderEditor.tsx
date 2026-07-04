import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Col, Descriptions, Divider, Empty, Form, Input, Modal, Row, Select,
  Space, Steps, Tag, Timeline,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  integratedDeployApi, orderedItems, DEPLOY_KIND_GROUP,
  type DeployItem, type DeployRun, type ItemResult,
} from '../../api/integratedDeploy';
import { clusterApi } from '../../api/cluster';
import { useAuthStore } from '../../store/auth';
import { useCtxStore } from '../../store/ctx';
import { canGlobal } from '../../nav';
import ManifestDrawer, { type ManifestDrawerMode } from './ManifestDrawer';
import ResourceItemCard from './ResourceItemCard';

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
  // 新建工单默认跟随顶部全局选择:集群取当前集群,命名空间取当前 NS(未选/全部时留空,
  // 让用户在本卡片里选)。编辑已有工单时由下方 effect 从工单本身回填。
  const globalCluster = useCtxStore((s) => s.currentCluster);
  const globalNamespace = useCtxStore((s) => s.currentNamespace);
  const [clusterId, setClusterId] = useState(isNew ? globalCluster ?? '' : '');
  const [namespace, setNamespace] = useState(isNew ? globalNamespace ?? '' : '');
  const [nsOptions, setNsOptions] = useState<string[]>([]);
  const [items, setItems] = useState<DeployItem[]>([]);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [lastRun, setLastRun] = useState<DeployRun | null>(null);

  // 加载集群列表(用于新建时选择)。
  useEffect(() => {
    clusterApi.list().then((cs) => setClusters(cs.map((c) => ({ id: c.id, name: c.name })))).catch(() => undefined);
  }, []);

  // 命名空间下拉:按当前选中集群拉取(不依赖全局 X-Cluster-ID 头)。
  useEffect(() => {
    if (!clusterId) {
      setNsOptions([]);
      return;
    }
    integratedDeployApi.namespaces(clusterId).then(setNsOptions).catch(() => setNsOptions([]));
  }, [clusterId]);

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
  const inOrder = useMemo(() => new Set(items.map((i) => `${i.kind}:${i.name}`)), [items]);

  // —— 资源条目 Drawer:从集群选取 / 新建资源 / 编辑 ——
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ManifestDrawerMode>('select-add');
  const [drawerEditIdx, setDrawerEditIdx] = useState<number | null>(null);

  const openSelectAdd = () => {
    setDrawerMode('select-add');
    setDrawerEditIdx(null);
    setDrawerOpen(true);
  };

  const openNewAdd = () => {
    setDrawerMode('new-add');
    setDrawerEditIdx(null);
    setDrawerOpen(true);
  };

  const openEditByIdx = (idx: number) => {
    setDrawerMode('edit');
    setDrawerEditIdx(idx);
    setDrawerOpen(true);
  };

  const openEditMount = (kind: string, name: string) => {
    const idx = items.findIndex((i) => i.kind === kind && i.name === name);
    if (idx >= 0) openEditByIdx(idx);
  };

  const handleDrawerConfirm = ({ kind, name, yaml }: { kind: string; name: string; yaml: string }) => {
    if (drawerMode === 'edit' && drawerEditIdx !== null) {
      // A rename must not collide with a DIFFERENT existing item.
      if (items.some((i, idx) => idx !== drawerEditIdx && i.kind === kind && i.name === name)) {
        message.error(t('integratedDeploy.duplicateItem'));
        return;
      }
      setItems(items.map((it, i) => (i === drawerEditIdx ? { ...it, name, manifest_yaml: yaml } : it)));
    } else {
      if (items.some((i) => i.kind === kind && i.name === name)) {
        message.error(t('integratedDeploy.duplicateItem'));
        return;
      }
      const source = drawerMode === 'select-add' ? 'selected' : 'authored';
      const nextIndex = items.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[kind]).length;
      setItems([...items, { kind, name, source, manifest_yaml: yaml, sort_index: nextIndex }]);
    }
    setDrawerOpen(false);
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

  const drawerEditItem = drawerMode === 'edit' && drawerEditIdx !== null ? items[drawerEditIdx] : null;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title={t('integratedDeploy.title')}>
        <Form form={form} layout="vertical" disabled={!canEdit}>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item label={t('integratedDeploy.cluster')} required>
                <Select
                  style={{ width: '100%' }}
                  value={clusterId || undefined}
                  disabled={locked}
                  placeholder={t('integratedDeploy.cluster')}
                  showSearch
                  optionFilterProp="label"
                  onChange={(v) => {
                    setClusterId(v);
                    setNamespace(''); // 换集群后命名空间失效,需重选
                  }}
                  options={clusters.map((c) => ({ value: c.id, label: c.name }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item label={t('integratedDeploy.namespace')} required>
                <Select
                  style={{ width: '100%' }}
                  value={namespace || undefined}
                  disabled={locked || !clusterId}
                  placeholder={t('integratedDeploy.namespace')}
                  showSearch
                  optionFilterProp="label"
                  onChange={setNamespace}
                  options={nsOptions.map((n) => ({ value: n, label: n }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="title" label={t('integratedDeploy.orderTitle')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label={t('integratedDeploy.description')}>
            <Input.TextArea rows={5} />
          </Form.Item>
        </Form>
      </Card>

      <Card
        title={t('integratedDeploy.items')}
        extra={
          canEdit && (
            <Space>
              <Button
                onClick={openSelectAdd}
                disabled={!clusterId || !namespace}
              >
                {t('integratedDeploy.addSelected')}
              </Button>
              <Button onClick={openNewAdd} disabled={!clusterId || !namespace}>
                {t('integratedDeploy.newResource')}
              </Button>
            </Space>
          )
        }
      >
        {items.length === 0 ? (
          <Empty />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: 16,
            }}
          >
            {items.map((item, idx) => (
              <ResourceItemCard
                key={`${item.kind}:${item.name}:${idx}`}
                item={item}
                groupLabel={t(GROUP_KEY[DEPLOY_KIND_GROUP[item.kind] ?? 3])}
                inOrder={inOrder}
                canEdit={canEdit}
                onEdit={() => openEditByIdx(idx)}
                onDelete={() => removeItem(idx)}
                onOpenMount={openEditMount}
              />
            ))}
          </div>
        )}
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
        <Button onClick={() => navigate('/integrated-deploy')}>{t('common.back')}</Button>
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

      <ManifestDrawer
        open={drawerOpen}
        mode={drawerMode}
        clusterId={clusterId}
        namespace={namespace}
        initialKind={drawerEditItem?.kind}
        initialYaml={drawerEditItem?.manifest_yaml}
        readOnly={!canEdit}
        onClose={() => setDrawerOpen(false)}
        onConfirm={handleDrawerConfirm}
      />
    </Space>
  );
}
