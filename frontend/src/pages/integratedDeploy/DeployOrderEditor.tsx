import { useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Col, Descriptions, Divider, Empty, Form, Input, Modal, Row, Select,
  Space, Steps, Tag,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  integratedDeployApi, orderedItems, DEPLOY_KINDS, DEPLOY_KIND_GROUP,
  type DeployItem, type DeployRun,
} from '../../api/integratedDeploy';
import { clusterApi } from '../../api/cluster';
import { useAuthStore } from '../../store/auth';
import { useCtxStore } from '../../store/ctx';
import { canGlobal } from '../../nav';
import { fromYAML } from '../../components/editor/util';
import { extractMounts } from './mounts';
import { baseDrifted } from './reconcile';
import DiffView from '../../components/editor/DiffView';
import ManifestDrawer from './ManifestDrawer';
import PublishDrawer from './PublishDrawer';
import ResourceItemCard from './ResourceItemCard';
import { formatTime } from '../../utils';

const GROUP_KEY: Record<number, string> = {
  1: 'integratedDeploy.group1',
  2: 'integratedDeploy.group2',
  3: 'integratedDeploy.group3',
};

export default function DeployOrderEditor() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id;
  const me = useAuthStore((s) => s.user);
  const hasEditPerm = canGlobal('integrated_deploy', 'edit', me) || (isNew && canGlobal('integrated_deploy', 'create', me));
  const hasPublishPerm = canGlobal('integrated_deploy', 'publish', me);
  const [orderStatus, setOrderStatus] = useState<string>('draft');
  // 已发布的工单(非草稿)只读:仅可查看 + 复制,不可编辑/发布,直到复制为新草稿。
  const published = !isNew && orderStatus !== 'draft';
  const canEdit = hasEditPerm && !published;
  const canPublish = hasPublishPerm && !published;

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
  const [publishOpen, setPublishOpen] = useState(false);

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

  // 编辑:加载工单(发布完成后也用它刷新 runs/orderStatus,使工单转为只读)。
  useEffect(() => {
    if (!id) return;
    integratedDeployApi.get(Number(id)).then((d) => {
      setClusterId(d.order.cluster_id);
      setNamespace(d.order.namespace);
      setItems(d.order.items ?? []);
      setRuns(d.runs ?? []);
      setOrderStatus(d.order.status);
      form.setFieldsValue({ title: d.order.title, description: d.order.description });
    }).catch(() => undefined);
  }, [id, form]);

  const refetchOrder = () => {
    if (!id) return;
    integratedDeployApi.get(Number(id)).then((d) => {
      setRuns(d.runs ?? []);
      setOrderStatus(d.order.status);
    }).catch(() => undefined);
  };

  const preview = useMemo(() => orderedItems(items), [items]);
  const inOrder = useMemo(() => new Set(items.map((i) => `${i.kind}:${i.name}`)), [items]);

  // —— 从集群选取:内联在条目卡片顶部 ——
  const [selKind, setSelKind] = useState('configmaps');
  const [selName, setSelName] = useState('');
  const [selectableNames, setSelectableNames] = useState<string[]>([]);

  // 拉可选资源名单(按写权限过滤;走工单所属 clusterId,而非全局当前集群)。
  useEffect(() => {
    if (!clusterId || !namespace) {
      setSelectableNames([]);
      return;
    }
    integratedDeployApi.selectable(clusterId, namespace, selKind).then(setSelectableNames).catch(() => setSelectableNames([]));
  }, [clusterId, namespace, selKind]);

  // Given a just-added workload's manifest, snapshot + append any mounted
  // configmaps/secrets not already in the order. Returns the new items array.
  const withAutoMounts = async (manifestYaml: string, base: DeployItem[]): Promise<DeployItem[]> => {
    let obj;
    try {
      obj = fromYAML(manifestYaml);
    } catch {
      return base;
    }
    const mounts = extractMounts(obj); // [] for non-workloads
    let next = base;
    for (const m of mounts) {
      if (next.some((i) => i.kind === m.kind && i.name === m.name)) continue;
      try {
        const y = await integratedDeployApi.snapshot(clusterId, namespace, m.kind, m.name);
        const idx = next.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[m.kind]).length;
        next = [...next, { kind: m.kind, name: m.name, source: 'selected', manifest_yaml: y.manifest_yaml, sort_index: idx, resource_version: y.resource_version }];
      } catch {
        /* skip: no write perm / not found in cluster */
      }
    }
    return next;
  };

  const addSelected = async () => {
    if (!clusterId || !namespace || !selName) return;
    if (items.some((i) => i.kind === selKind && i.name === selName)) {
      message.error(t('integratedDeploy.duplicateItem'));
      return;
    }
    try {
      const snap = await integratedDeployApi.snapshot(clusterId, namespace, selKind, selName);
      const nextIndex = items.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[selKind]).length;
      const withItem = [...items, { kind: selKind, name: selName, source: 'selected' as const, manifest_yaml: snap.manifest_yaml, sort_index: nextIndex, resource_version: snap.resource_version }];
      const withMounts = await withAutoMounts(snap.manifest_yaml, withItem);
      setItems(withMounts);
      setSelName('');
      const n = withMounts.length - withItem.length;
      if (n > 0) message.success(t('integratedDeploy.mountsAutoAdded', { n }));
    } catch {
      /* axios interceptor already toasts */
    }
  };

  // —— Drawer:编辑已有条目,或编辑一份来自集群的快照(挂载点点击时新增) ——
  // drawerEditIdx !== null → 编辑既有条目;=== null → 新增(mount-click 快照)。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerEditIdx, setDrawerEditIdx] = useState<number | null>(null);
  const [drawerKind, setDrawerKind] = useState('');
  const [drawerYaml, setDrawerYaml] = useState('');
  // resourceVersion of the base the drawer was opened with — carried onto the
  // item so publish can run optimistic-concurrency against it.
  const [drawerBaseRV, setDrawerBaseRV] = useState('');

  // 集群与工单快照不一致时的对比确认弹窗。
  const [reconcile, setReconcile] = useState<
    { idx: number; stored: string; storedRV: string; live: string; liveRV: string } | null
  >(null);

  const openDrawerWith = (idx: number | null, kind: string, yaml: string, rv: string) => {
    setDrawerEditIdx(idx);
    setDrawerKind(kind);
    setDrawerYaml(yaml);
    setDrawerBaseRV(rv);
    setDrawerOpen(true);
  };

  // 编辑既有条目:先从集群拉最新做漂移检测(仅可编辑态)。若集群对象自快照后已被
  // 改动,弹出对比让用户选择"用集群最新"还是"保留工单快照";否则直接编辑。
  const openEditDrawer = async (idx: number) => {
    const item = items[idx];
    const storedRV = item.resource_version ?? '';
    if (!canEdit || !clusterId || !namespace) {
      openDrawerWith(idx, item.kind, item.manifest_yaml, storedRV);
      return;
    }
    try {
      const live = await integratedDeployApi.snapshot(clusterId, namespace, item.kind, item.name);
      if (baseDrifted(item, live)) {
        setReconcile({ idx, stored: item.manifest_yaml, storedRV, live: live.manifest_yaml, liveRV: live.resource_version });
        return;
      }
    } catch {
      /* live fetch failed (deleted / 403) → fall back to editing the stored snapshot */
    }
    openDrawerWith(idx, item.kind, item.manifest_yaml, storedRV);
  };

  // 保留工单快照:按原快照编辑(RV 不变,发布时若集群已变会被乐观锁拦下)。
  const reconcileKeep = () => {
    if (!reconcile) return;
    const { idx, stored, storedRV } = reconcile;
    setReconcile(null);
    openDrawerWith(idx, items[idx].kind, stored, storedRV);
  };

  // 用集群最新:把条目基线替换为集群最新(manifest + RV),再进入编辑。
  const reconcileUseLive = () => {
    if (!reconcile) return;
    const { idx, live, liveRV } = reconcile;
    setItems(items.map((it, i) => (i === idx ? { ...it, manifest_yaml: live, resource_version: liveRV } : it)));
    setReconcile(null);
    openDrawerWith(idx, items[idx].kind, live, liveRV);
  };

  // 点击挂载点:已在工单里则打开其编辑;否则从集群快照后以"新增"模式打开,
  // 确认时追加到工单(排序会把 configmaps/secrets 排在工作负载之前,一起发布)。
  const openEditMount = async (kind: string, name: string) => {
    const idx = items.findIndex((i) => i.kind === kind && i.name === name);
    if (idx >= 0) {
      await openEditDrawer(idx);
      return;
    }
    if (!clusterId || !namespace) return;
    try {
      const snap = await integratedDeployApi.snapshot(clusterId, namespace, kind, name);
      openDrawerWith(null, kind, snap.manifest_yaml, snap.resource_version);
    } catch {
      /* axios interceptor already toasts (e.g. 403/404) */
    }
  };

  const handleDrawerConfirm = async ({ kind, name, yaml }: { kind: string; name: string; yaml: string }) => {
    if (drawerEditIdx !== null) {
      // 编辑既有条目:重命名不得与其他条目冲突。
      if (items.some((i, idx) => idx !== drawerEditIdx && i.kind === kind && i.name === name)) {
        message.error(t('integratedDeploy.duplicateItem'));
        return;
      }
      setItems(items.map((it, i) => (i === drawerEditIdx ? { ...it, name, manifest_yaml: yaml, resource_version: drawerBaseRV } : it)));
    } else {
      // 新增(mount-click 快照):去重后追加,并自动带上其挂载的 configmaps/secrets。
      if (items.some((i) => i.kind === kind && i.name === name)) {
        message.error(t('integratedDeploy.duplicateItem'));
        return;
      }
      const nextIndex = items.filter((i) => DEPLOY_KIND_GROUP[i.kind] === DEPLOY_KIND_GROUP[kind]).length;
      const withItem = [...items, { kind, name, source: 'selected' as const, manifest_yaml: yaml, sort_index: nextIndex, resource_version: drawerBaseRV }];
      const withMounts = await withAutoMounts(yaml, withItem);
      setItems(withMounts);
      const n = withMounts.length - withItem.length;
      if (n > 0) message.success(t('integratedDeploy.mountsAutoAdded', { n }));
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
                    // 换集群会使已选资源失效(它们属于旧集群),清空未保存的选择与条目。
                    setSelName('');
                    setItems([]);
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

      <Card title={t('integratedDeploy.items')}>
        {canEdit && (
          <Space wrap style={{ marginBottom: 16 }}>
            <Select
              style={{ width: 200 }}
              value={selKind}
              onChange={(v) => {
                setSelKind(v);
                setSelName('');
              }}
              options={DEPLOY_KINDS.map((k) => ({ value: k, label: k }))}
            />
            <Select
              style={{ width: 280 }}
              showSearch
              placeholder={t('integratedDeploy.selectResource')}
              value={selName || undefined}
              onChange={setSelName}
              options={selectableNames.map((n) => ({ value: n, label: n }))}
              notFoundContent={t('integratedDeploy.noSelectable')}
            />
            <Button type="primary" onClick={addSelected} disabled={!clusterId || !namespace || !selName}>
              {t('integratedDeploy.addItem')}
            </Button>
          </Space>
        )}
        {items.length === 0 ? (
          <Empty />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {items.map((item, idx) => (
              <ResourceItemCard
                key={`${item.kind}:${item.name}:${idx}`}
                item={item}
                groupLabel={t(GROUP_KEY[DEPLOY_KIND_GROUP[item.kind] ?? 3])}
                inOrder={inOrder}
                canEdit={canEdit}
                onEdit={() => { void openEditDrawer(idx); }}
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
        {!isNew && canPublish && <Button onClick={() => setPublishOpen(true)}>{t('integratedDeploy.publish')}</Button>}
        <Button onClick={() => navigate('/integrated-deploy')}>{t('common.back')}</Button>
      </Space>

      {!isNew && runs.length > 0 && (
        <Card title={t('integratedDeploy.publishHistory')}>
          {runs.map((r) => (
            <Descriptions key={r.id} size="small" column={1} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={formatTime(r.created_at)}>
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
        kind={drawerKind}
        initialYaml={drawerYaml}
        readOnly={!canEdit}
        onClose={() => setDrawerOpen(false)}
        onConfirm={handleDrawerConfirm}
      />

      <Modal
        open={!!reconcile}
        width="min(1100px, 92vw)"
        title={t('integratedDeploy.reconcileTitle')}
        onCancel={() => setReconcile(null)}
        footer={[
          <Button key="keep" onClick={reconcileKeep}>{t('integratedDeploy.keepSnapshot')}</Button>,
          <Button key="live" type="primary" onClick={reconcileUseLive}>{t('integratedDeploy.useCluster')}</Button>,
        ]}
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('integratedDeploy.reconcileDesc')} />
        <div style={{ height: '60vh', display: 'flex', flexDirection: 'column' }}>
          {reconcile && <DiffView original={reconcile.stored} current={reconcile.live} />}
        </div>
      </Modal>

      {!isNew && (
        <PublishDrawer
          open={publishOpen}
          orderId={Number(id)}
          items={preview}
          onClose={() => setPublishOpen(false)}
          onDone={refetchOrder}
        />
      )}
    </Space>
  );
}
