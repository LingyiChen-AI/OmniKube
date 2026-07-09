import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Result,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  theme,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  KeyOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { Popconfirm } from 'antd';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../../api/resource';
import { useApi } from '../../hooks/useApi';
import { useCtxStore } from '../../store/ctx';
import { useCapabilities } from '../../store/caps';
import { execUrl, logsUrl } from '../../api/ws';
import { StatusTag, formatAge, formatTime } from '../../utils';
import TerminalPanel from '../../components/TerminalPanel';
import EditResourceDrawer from '../../components/EditResourceDrawer';
import { kindFromResource } from '../../components/editor/forms';
import { defaultTableProps, defaultPagination, colW, tableScrollX } from '../../components/tableConfig';

const { Title, Text } = Typography;

/** Workload kinds that share this detail page. */
export type WorkloadKind = 'deployment' | 'statefulset' | 'daemonset';

interface KindConfig {
  /** k8s plural used by the resource API. */
  resource: string;
  /** List page path (back button / breadcrumb / delete redirect). */
  listPath: string;
  /** i18n key for the breadcrumb list label. */
  navKey: string;
  /** i18n key for the singular kind label (not-found message). */
  kindKey: string;
}

const KIND_CONFIG: Record<WorkloadKind, KindConfig> = {
  deployment: {
    resource: 'deployments',
    listPath: '/workloads/deployments',
    navKey: 'nav.deployments',
    kindKey: 'workloadDetail.kinds.deployment',
  },
  statefulset: {
    resource: 'statefulsets',
    listPath: '/workloads/statefulsets',
    navKey: 'nav.statefulsets',
    kindKey: 'workloadDetail.kinds.statefulset',
  },
  daemonset: {
    resource: 'daemonsets',
    listPath: '/workloads/daemonsets',
    navKey: 'nav.daemonsets',
    kindKey: 'workloadDetail.kinds.daemonset',
  },
};

/** Controller kind that directly owns the pods of each workload type. */
const POD_CONTROLLER_KIND: Record<WorkloadKind, string> = {
  deployment: 'ReplicaSet',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
};

/** Kind of the pod's controlling ownerReference, if any. */
function podControllerKind(pod: K8sObject): string | undefined {
  const refs = (pod.metadata?.ownerReferences as any[]) || [];
  const controller = refs.find((r) => r?.controller) ?? refs[0];
  return controller?.kind;
}

/** True when a pod carries every label in the workload's matchLabels. */
export function podMatchesSelector(
  pod: K8sObject,
  selector?: Record<string, string>,
): boolean {
  if (!selector) return false;
  const labels = pod.metadata?.labels || {};
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/**
 * Filter a pod list down to those belonging to the workload.
 *
 * Label selectors are not unique across controllers of different kinds — e.g.
 * a CronJob whose Job pods reuse the Deployment's `app` label would otherwise
 * leak into the Deployment's pod list. When `controllerKind` is given we also
 * require the pod's controlling owner to be that kind (Deployment→ReplicaSet,
 * StatefulSet→StatefulSet, DaemonSet→DaemonSet). Orphan pods with no
 * controller fall back to selector-only matching.
 */
export function filterPodsBySelector(
  pods: K8sObject[],
  selector?: Record<string, string>,
  controllerKind?: string,
): K8sObject[] {
  if (!selector || Object.keys(selector).length === 0) return [];
  return pods.filter((p) => {
    if (!podMatchesSelector(p, selector)) return false;
    if (!controllerKind) return true;
    const owner = podControllerKind(p);
    return !owner || owner === controllerKind;
  });
}

interface ConfigRef {
  kind: 'configmap' | 'secret';
  name: string;
}

/** Collect deduped ConfigMap / Secret references from the pod template. */
export function collectConfigRefs(dep?: K8sObject): ConfigRef[] {
  const seen = new Set<string>();
  const refs: ConfigRef[] = [];
  const add = (kind: ConfigRef['kind'], name?: string) => {
    if (!name) return;
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, name });
  };
  const tpl = dep?.spec?.template?.spec || {};
  const containers = [
    ...((tpl.containers as any[]) || []),
    ...((tpl.initContainers as any[]) || []),
  ];
  for (const c of containers) {
    for (const e of (c.env as any[]) || []) {
      add('configmap', e?.valueFrom?.configMapKeyRef?.name);
      add('secret', e?.valueFrom?.secretKeyRef?.name);
    }
    for (const ef of (c.envFrom as any[]) || []) {
      add('configmap', ef?.configMapRef?.name);
      add('secret', ef?.secretRef?.name);
    }
  }
  for (const v of (tpl.volumes as any[]) || []) {
    add('configmap', v?.configMap?.name);
    add('secret', v?.secret?.secretName);
  }
  return refs;
}

interface ReplicaStat {
  /** i18n key for the label. */
  labelKey: string;
  value: number;
}

/**
 * Per-kind ready/desired plus the extra replica stats shown in the overview.
 * Deployment / StatefulSet read replica fields; DaemonSet reads node-scheduling
 * fields (no spec.replicas).
 */
export function workloadStatus(
  kind: WorkloadKind,
  spec: Record<string, any>,
  status: Record<string, any>,
): { ready: number; desired: number; stats: ReplicaStat[] } {
  if (kind === 'daemonset') {
    const desired = status.desiredNumberScheduled ?? 0;
    const ready = status.numberReady ?? 0;
    return {
      ready,
      desired,
      stats: [
        { labelKey: 'workloadDetail.desired', value: desired },
        { labelKey: 'resource.ready', value: ready },
        { labelKey: 'resource.available', value: status.numberAvailable ?? 0 },
        { labelKey: 'resource.upToDate', value: status.updatedNumberScheduled ?? 0 },
        { labelKey: 'workloadDetail.misscheduled', value: status.numberMisscheduled ?? 0 },
      ],
    };
  }

  const desired = spec.replicas ?? status.replicas ?? 0;
  const ready = status.readyReplicas ?? 0;

  if (kind === 'statefulset') {
    return {
      ready,
      desired,
      stats: [
        { labelKey: 'workloadDetail.desired', value: desired },
        { labelKey: 'resource.ready', value: ready },
        { labelKey: 'workloadDetail.current', value: status.currentReplicas ?? 0 },
        { labelKey: 'resource.upToDate', value: status.updatedReplicas ?? 0 },
      ],
    };
  }

  // deployment
  return {
    ready,
    desired,
    stats: [
      { labelKey: 'workloadDetail.desired', value: desired },
      { labelKey: 'resource.ready', value: ready },
      { labelKey: 'resource.upToDate', value: status.updatedReplicas ?? 0 },
      { labelKey: 'resource.available', value: status.availableReplicas ?? 0 },
    ],
  };
}

function containerNames(pod: K8sObject): string[] {
  return ((pod.spec?.containers as any[]) || []).map((c) => c.name).filter(Boolean);
}

function readyCount(pod: K8sObject): string {
  const statuses = (pod.status?.containerStatuses as any[]) || [];
  const ready = statuses.filter((s) => s.ready).length;
  return `${ready}/${statuses.length || (pod.spec?.containers || []).length || 0}`;
}

function restarts(pod: K8sObject): number {
  const statuses = (pod.status?.containerStatuses as any[]) || [];
  return statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
}

const condColor: Record<string, string> = {
  Available: 'green',
  Progressing: 'blue',
  ReplicaFailure: 'red',
};

type PanelKind = 'logs' | 'exec';

export interface WorkloadDetailProps {
  kind: WorkloadKind;
}

export default function WorkloadDetail({ kind }: WorkloadDetailProps) {
  const cfg = KIND_CONFIG[kind];
  const { t } = useTranslation();
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { currentCluster } = useCtxStore();
  const { can } = useCapabilities();

  const canWrite = can(cfg.resource, 'edit');
  const canDelete = can(cfg.resource, 'delete');
  const canExec = can('pods', 'exec');

  const [yamlMode, setYamlMode] = useState<'view' | 'edit' | null>(null);
  const [refView, setRefView] = useState<ConfigRef | null>(null);
  const [panel, setPanel] = useState<{ pod: K8sObject; kind: PanelKind } | null>(null);
  const [container, setContainer] = useState('');

  const dep = useApi<K8sObject | undefined>(
    () =>
      currentCluster
        ? resourceApi.get(namespace, cfg.resource, name)
        : Promise.resolve(undefined),
    [currentCluster, namespace, name, cfg.resource],
    { skip: !currentCluster },
  );

  const selector: Record<string, string> | undefined =
    dep.data?.spec?.selector?.matchLabels;

  const podsApi = useApi<K8sObject[]>(
    () =>
      currentCluster ? resourceApi.list('pods', namespace) : Promise.resolve([]),
    [currentCluster, namespace],
    { initial: [], skip: !currentCluster },
  );

  const pods = useMemo(
    () => filterPodsBySelector(podsApi.data || [], selector, POD_CONTROLLER_KIND[kind]),
    [podsApi.data, selector, kind],
  );

  const reloadAll = () => {
    dep.reload();
    podsApi.reload();
  };

  // Auto-detect changes: silently poll the workload + its pods so the pod list
  // (容器组) updates on its own after an edit/release. Poll fast while the
  // workload is settling (rollout in progress), slow once stable.
  const desiredNow =
    dep.data?.spec?.replicas ?? dep.data?.status?.replicas ?? dep.data?.status?.desiredNumberScheduled ?? 0;
  const readyNow = dep.data?.status?.readyReplicas ?? dep.data?.status?.numberReady ?? 0;
  const settled =
    desiredNow > 0 &&
    readyNow === desiredNow &&
    pods.length > 0 &&
    pods.every((p) => p.status?.phase === 'Running');

  const { reloadSilent: reloadDep } = dep;
  const { reloadSilent: reloadPods } = podsApi;
  useEffect(() => {
    if (!currentCluster) return;
    const ms = settled ? 15000 : 3500;
    const id = window.setInterval(() => {
      reloadPods();
      reloadDep();
    }, ms);
    return () => window.clearInterval(id);
  }, [currentCluster, namespace, name, cfg.resource, settled, reloadDep, reloadPods]);

  const onDelete = async () => {
    try {
      await resourceApi.remove(namespace, cfg.resource, name);
      message.success(t('resource.deleted', { name }));
      navigate(cfg.listPath);
    } catch {
      /* interceptor toast */
    }
  };

  const containers = useMemo(
    () => (panel ? containerNames(panel.pod) : []),
    [panel],
  );

  const openPanel = (pod: K8sObject, panelKind: PanelKind) => {
    setContainer(containerNames(pod)[0] || '');
    setPanel({ pod, kind: panelKind });
  };

  const wsUrl = useMemo(() => {
    if (!panel || !currentCluster) return '';
    const base = {
      cluster_id: currentCluster,
      namespace: panel.pod.metadata?.namespace || namespace || 'default',
      pod: panel.pod.metadata?.name || '',
      container: container || undefined,
    };
    return panel.kind === 'logs'
      ? logsUrl({ ...base, follow: true, tail: 500 })
      : execUrl(base);
  }, [panel, container, currentCluster, namespace]);

  const breadcrumb = (
    <Breadcrumb
      items={[
        { title: t('nav.workloads') },
        {
          title: <Link to={cfg.listPath}>{t(cfg.navKey)}</Link>,
        },
        { title: name },
      ]}
    />
  );

  // ---- guard / loading / error states -------------------------------------
  if (!currentCluster) {
    return (
      <Card>
        <Result
          status="info"
          title={t('resource.noCluster')}
          subTitle={t('resource.noClusterDesc')}
        />
      </Card>
    );
  }

  if (dep.loading && !dep.data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {breadcrumb}
        <Card>
          <Skeleton active paragraph={{ rows: 2 }} />
        </Card>
        <Card>
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      </div>
    );
  }

  if (dep.error || !dep.data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {breadcrumb}
        <Card>
          <Result
            status="404"
            title={t('workloadDetail.notFound', { kind: t(cfg.kindKey) })}
            subTitle={t('workloadDetail.notFoundDesc', { name })}
            extra={
              <Button type="primary" onClick={() => navigate(cfg.listPath)}>
                {t('workloadDetail.back')}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const d = dep.data;
  const spec = d.spec || {};
  const status = d.status || {};
  const { ready, desired, stats } = workloadStatus(kind, spec, status);
  const tplContainers = (spec.template?.spec?.containers as any[]) || [];
  const images: string[] = tplContainers.map((c) => c.image).filter(Boolean);
  const conditions = (status.conditions as any[]) || [];
  // Deployments use spec.strategy; StatefulSet/DaemonSet use spec.updateStrategy.
  const strategy = spec.strategy || spec.updateStrategy || {};
  const configRefs = collectConfigRefs(d);

  const badgeStatus: 'success' | 'warning' | 'error' =
    desired > 0 && ready === desired ? 'success' : ready === 0 ? 'error' : 'warning';

  // ---- pods table ---------------------------------------------------------
  const podColumns: ColumnsType<K8sObject> = [
    {
      title: t('resource.name'),
      key: 'name',
      width: colW.name,
      fixed: 'left',
      ellipsis: true,
      render: (_, r) => (
        <Text strong ellipsis={{ tooltip: r.metadata?.name }} style={{ maxWidth: '100%' }}>
          {r.metadata?.name}
        </Text>
      ),
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: colW.status,
      align: 'center',
      render: (_, r) => <StatusTag phase={r.status?.phase} />,
    },
    {
      title: t('resource.ready'),
      key: 'ready',
      width: colW.metric,
      align: 'center',
      render: (_, r) => <Tag>{readyCount(r)}</Tag>,
    },
    {
      title: t('resource.restarts'),
      key: 'restarts',
      width: colW.metric,
      align: 'center',
      render: (_, r) => {
        const n = restarts(r);
        return <Text type={n > 0 ? 'warning' : undefined}>{n}</Text>;
      },
    },
    {
      title: t('resource.node'),
      key: 'node',
      width: colW.text,
      ellipsis: true,
      render: (_, r) => <Text type="secondary">{r.spec?.nodeName || '—'}</Text>,
    },
    {
      title: t('resource.age'),
      key: 'age',
      width: colW.age,
      render: (_, r) => formatAge(r.metadata?.creationTimestamp),
    },
    {
      title: t('resource.actions'),
      key: 'actions',
      align: 'right',
      width: colW.actionsSm,
      fixed: 'right',
      render: (_, r) => (
        <Space size={2}>
          <Tooltip title={t('pod.logs')}>
            <Button
              type="text"
              size="small"
              icon={<FileSearchOutlined />}
              onClick={() => openPanel(r, 'logs')}
            />
          </Tooltip>
          {canExec && (
            <Tooltip title={t('pod.terminal')}>
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                onClick={() => openPanel(r, 'exec')}
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {breadcrumb}

      {/* Header card */}
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Space size={8} align="center" wrap>
              <Button
                type="text"
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate(cfg.listPath)}
              >
                {t('workloadDetail.back')}
              </Button>
            </Space>
            <Space size={12} align="center" wrap style={{ marginTop: 6 }}>
              <Title level={3} style={{ margin: 0 }} ellipsis={{ tooltip: name }}>
                {name}
              </Title>
              <Tag color="geekblue">{namespace}</Tag>
              <Badge
                status={badgeStatus}
                text={t('workloadDetail.readyReplicas', { ready, desired })}
              />
            </Space>
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                {t('workloadDetail.created', {
                  age: formatAge(d.metadata?.creationTimestamp),
                  time: formatTime(d.metadata?.creationTimestamp),
                })}
              </Text>
            </div>
          </div>

          <Space>
            <Button icon={<ReloadOutlined />} onClick={reloadAll} loading={dep.loading}>
              {t('resource.refresh')}
            </Button>
            <Button icon={<EyeOutlined />} onClick={() => setYamlMode('view')}>
              {t('resource.view')}
            </Button>
            {canWrite && (
              <Button icon={<EditOutlined />} onClick={() => setYamlMode('edit')}>
                {t('resource.edit')}
              </Button>
            )}
            {canDelete && (
              <Popconfirm
                title={t('resource.deleteResource')}
                description={t('resource.deleteConfirm', { name })}
                okText={t('resource.delete')}
                okButtonProps={{ danger: true }}
                onConfirm={onDelete}
              >
                <Button danger icon={<DeleteOutlined />}>
                  {t('resource.delete')}
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      </Card>

      {/* Overview — bordered grid so rows/labels align and spacing is uniform. */}
      <Card title={t('workloadDetail.overview')} styles={{ body: { paddingTop: 16 } }}>
        <Descriptions
          bordered
          column={2}
          size="middle"
          labelStyle={{ width: 160, whiteSpace: 'nowrap' }}
        >
          <Descriptions.Item label={t('workloadDetail.images')} span={2}>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {images.length
                ? images.map((img) => (
                    <Text key={img} code copyable={{ text: img }}>
                      {img}
                    </Text>
                  ))
                : '—'}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('workloadDetail.replicas')}>
            <Space size={4} wrap>
              {stats.map((s, i) => (
                <Tag
                  key={s.labelKey}
                  color={
                    i === 1
                      ? badgeStatus === 'success'
                        ? 'green'
                        : 'gold'
                      : undefined
                  }
                >
                  {t(s.labelKey)}: {s.value}
                </Tag>
              ))}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('workloadDetail.strategy')}>
            <Space size={4} wrap>
              <Tag color="cyan">{strategy.type || 'RollingUpdate'}</Tag>
              {strategy.rollingUpdate?.maxSurge != null && (
                <Tag>maxSurge: {String(strategy.rollingUpdate.maxSurge)}</Tag>
              )}
              {strategy.rollingUpdate?.maxUnavailable != null && (
                <Tag>maxUnavailable: {String(strategy.rollingUpdate.maxUnavailable)}</Tag>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label={t('workloadDetail.selector')} span={2}>
            {selector && Object.keys(selector).length ? (
              <Space size={4} wrap>
                {Object.entries(selector).map(([k, v]) => (
                  <Tag key={k} color="blue">{`${k}=${v}`}</Tag>
                ))}
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t('workloadDetail.conditions')} span={2}>
            {conditions.length ? (
              <Space size={6} wrap>
                {conditions.map((c) => (
                  <Tooltip
                    key={c.type}
                    title={c.message || c.reason || ''}
                  >
                    <Tag color={c.status === 'True' ? condColor[c.type] || 'default' : 'red'}>
                      {c.type}
                      {c.reason ? ` · ${c.reason}` : ''}
                    </Tag>
                  </Tooltip>
                ))}
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* Containers */}
      <Card title={t('workloadDetail.containers')} styles={{ body: { paddingTop: 12 } }}>
        <Collapse
          defaultActiveKey={tplContainers.map((c) => c.name)}
          items={tplContainers.map((c) => ({
            key: c.name,
            label: (
              <Space size={8} wrap>
                <Text strong>{c.name}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {c.image}
                </Text>
              </Space>
            ),
            children: <ContainerBody c={c} t={t} />,
          }))}
        />
      </Card>

      {/* Config references — click a card to inspect that ConfigMap/Secret in a drawer. */}
      <Card title={t('workloadDetail.configRefs')}>
        {configRefs.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {configRefs.map((r) => (
              <ConfigRefCard
                key={`${r.kind}/${r.name}`}
                r={r}
                onOpen={() => setRefView(r)}
              />
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('workloadDetail.noConfigRefs')}
          />
        )}
      </Card>

      {/* Pods */}
      <Card
        title={
          <Space>
            {t('workloadDetail.pods')}
            <Tag>{pods.length}</Tag>
            <Tooltip title={t('workloadDetail.autoRefresh')}>
              <Badge status="processing" />
            </Tooltip>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table<K8sObject>
          rowKey={(r) => r.metadata?.name || ''}
          columns={podColumns}
          dataSource={pods}
          loading={podsApi.loading}
          {...defaultTableProps}
          scroll={tableScrollX(podColumns)}
          pagination={defaultPagination}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t('workloadDetail.noPods')}
              />
            ),
          }}
        />
      </Card>

      {/* Edit drawer (visual + YAML + diff) */}
      {yamlMode && (
        <EditResourceDrawer
          open
          resource={cfg.resource}
          kind={kindFromResource(cfg.resource)}
          namespace={namespace}
          name={name}
          readOnly={yamlMode === 'view'}
          onClose={() => setYamlMode(null)}
          onSaved={reloadAll}
        />
      )}

      {/* Config reference detail (read-only) */}
      {refView && (
        <EditResourceDrawer
          open
          resource={refView.kind === 'secret' ? 'secrets' : 'configmaps'}
          kind={refView.kind === 'secret' ? 'Secret' : 'ConfigMap'}
          namespace={namespace}
          name={refView.name}
          readOnly
          onClose={() => setRefView(null)}
        />
      )}

      {/* Logs / terminal drawer */}
      <Drawer
        open={!!panel}
        onClose={() => setPanel(null)}
        width={920}
        destroyOnClose
        styles={{ body: { display: 'flex', flexDirection: 'column', padding: 16, height: '100%' } }}
        title={
          <Text strong>
            {panel?.kind === 'logs' ? t('pod.logsTitle') : t('pod.terminalTitle')} ·{' '}
            {panel?.pod.metadata?.name}
          </Text>
        }
        extra={
          containers.length > 1 ? (
            <Space>
              <Text type="secondary">{t('pod.container')}</Text>
              <Select
                size="small"
                value={container}
                style={{ width: 180 }}
                onChange={setContainer}
                options={containers.map((c) => ({ value: c, label: c }))}
              />
            </Space>
          ) : null
        }
      >
        {panel && wsUrl && (
          <TerminalPanel
            key={`${panel.kind}-${container}`}
            url={wsUrl}
            interactive={panel.kind === 'exec'}
          />
        )}
      </Drawer>
    </div>
  );
}

function kv(obj?: Record<string, any>): [string, string][] {
  if (!obj) return [];
  return Object.entries(obj).map(([k, v]) => [k, String(v)]);
}

/** A clickable ConfigMap/Secret reference; opens the resource in a read-only drawer. */
function ConfigRefCard({ r, onOpen }: { r: ConfigRef; onOpen: () => void }) {
  const { token } = theme.useToken();
  const [hover, setHover] = useState(false);
  const isSecret = r.kind === 'secret';
  const accent = isSecret ? token.colorWarning : token.colorInfo;
  const Icon = isSecret ? KeyOutlined : FileTextOutlined;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        padding: '9px 14px 9px 11px',
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${hover ? accent : token.colorBorderSecondary}`,
        background: hover
          ? `color-mix(in srgb, ${accent} 7%, ${token.colorBgContainer})`
          : token.colorBgContainer,
        boxShadow: hover ? token.boxShadowTertiary : 'none',
        transition: 'background .18s, border-color .18s, box-shadow .18s',
        maxWidth: 340,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 8,
          background: `color-mix(in srgb, ${accent} 15%, transparent)`,
          color: accent,
          fontSize: 15,
          flex: '0 0 auto',
        }}
      >
        <Icon />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span
          style={{
            fontSize: 11,
            letterSpacing: '.05em',
            textTransform: 'uppercase',
            color: token.colorTextTertiary,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          {isSecret ? 'Secret' : 'ConfigMap'}
        </span>
        <span
          style={{
            fontFamily: token.fontFamilyCode,
            fontSize: 13,
            fontWeight: 600,
            color: token.colorText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {r.name}
        </span>
      </div>
      <RightOutlined
        style={{ fontSize: 11, color: hover ? accent : token.colorTextQuaternary, marginLeft: 2, flex: '0 0 auto' }}
      />
    </div>
  );
}

/** One aligned label→value row in the container spec sheet. */
function SpecRow({
  label,
  alignTop,
  token,
  children,
}: {
  label: string;
  alignTop?: boolean;
  token: ReturnType<typeof theme.useToken>['token'];
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '124px minmax(0, 1fr)',
        columnGap: 20,
        alignItems: alignTop ? 'start' : 'center',
      }}
    >
      <div
        style={{
          color: token.colorTextTertiary,
          fontSize: 13,
          paddingTop: alignTop ? 3 : 0,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

const RES_LABEL: Record<string, string> = { cpu: 'CPU', memory: 'Memory' };

function ContainerBody({
  c,
  t,
}: {
  c: any;
  t: (k: string, o?: any) => string;
}) {
  const { token } = theme.useToken();
  const ports = (c.ports as any[]) || [];
  const env = (c.env as any[]) || [];
  const envFrom = (c.envFrom as any[]) || [];
  const mounts = (c.volumeMounts as any[]) || [];
  const requests = Object.fromEntries(kv(c.resources?.requests));
  const limits = Object.fromEntries(kv(c.resources?.limits));
  const resKeys = Array.from(new Set([...Object.keys(requests), ...Object.keys(limits)]));

  const mono = { fontFamily: token.fontFamilyCode } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 2px' }}>
      <SpecRow label={t('workloadDetail.image')} token={token} alignTop>
        <Text code copyable={{ text: c.image }} style={{ ...mono, fontSize: 12.5, wordBreak: 'break-all' }}>
          {c.image}
        </Text>
      </SpecRow>

      <SpecRow label={t('workloadDetail.pullPolicy')} token={token}>
        <Tag style={{ margin: 0 }}>{c.imagePullPolicy || 'IfNotPresent'}</Tag>
      </SpecRow>

      {ports.length > 0 && (
        <SpecRow label={t('resource.ports')} token={token} alignTop>
          <Space size={6} wrap>
            {ports.map((p, i) => (
              <Tag key={i} color="geekblue" style={{ margin: 0, ...mono }}>
                {p.containerPort}
                {p.protocol ? `/${p.protocol}` : ''}
                {p.name ? ` · ${p.name}` : ''}
              </Tag>
            ))}
          </Space>
        </SpecRow>
      )}

      {resKeys.length > 0 && (
        <SpecRow label={t('workloadDetail.resources')} token={token} alignTop>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {resKeys.map((k) => (
              <div
                key={k}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadiusLG,
                  background: token.colorFillQuaternary,
                  padding: '7px 12px',
                  minWidth: 168,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: token.colorTextTertiary,
                    fontWeight: 600,
                    marginBottom: 5,
                  }}
                >
                  {RES_LABEL[k] || k}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                  <span>
                    <span style={{ color: token.colorTextTertiary }}>{t('workloadDetail.requests')} </span>
                    <span style={{ ...mono, fontWeight: 600, color: token.colorText }}>
                      {requests[k] ?? '—'}
                    </span>
                  </span>
                  <span style={{ color: token.colorTextQuaternary || token.colorTextTertiary }}>·</span>
                  <span>
                    <span style={{ color: token.colorTextTertiary }}>{t('workloadDetail.limits')} </span>
                    <span style={{ ...mono, fontWeight: 600, color: token.colorText }}>
                      {limits[k] ?? '—'}
                    </span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </SpecRow>
      )}

      {env.length > 0 && (
        <SpecRow label={t('workloadDetail.env')} token={token} alignTop>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {env.map((e, i) => (
              <div key={i} style={{ ...mono, fontSize: 12.5, minWidth: 0 }}>
                <Text strong style={{ ...mono, color: token.colorPrimary }}>
                  {e.name}
                </Text>
                <span style={{ color: token.colorTextQuaternary || token.colorTextTertiary }}> = </span>
                {e.value != null ? (
                  <Text style={mono}>{e.value}</Text>
                ) : (
                  <Text type="secondary" style={mono}>
                    {envFromSource(e.valueFrom)}
                  </Text>
                )}
              </div>
            ))}
          </Space>
        </SpecRow>
      )}

      {envFrom.length > 0 && (
        <SpecRow label="envFrom" token={token} alignTop>
          <Space size={6} wrap>
            {envFrom.map((ef, i) => {
              const cm = ef.configMapRef?.name;
              const sec = ef.secretRef?.name;
              return (
                <Tag key={i} color={sec ? 'volcano' : 'cyan'} style={{ margin: 0 }}>
                  {sec ? `Secret · ${sec}` : `ConfigMap · ${cm}`}
                </Tag>
              );
            })}
          </Space>
        </SpecRow>
      )}

      {mounts.length > 0 && (
        <SpecRow label={t('workloadDetail.mounts')} token={token} alignTop>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {mounts.map((m, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 13 }}>
                <Text strong>{m.name}</Text>
                <span style={{ color: token.colorTextQuaternary || token.colorTextTertiary }}>→</span>
                <Text style={{ ...mono, color: token.colorTextSecondary }} ellipsis={{ tooltip: m.mountPath }}>
                  {m.mountPath}
                </Text>
                {m.readOnly && (
                  <Tag color="default" style={{ margin: 0, fontSize: 11, lineHeight: '18px' }}>
                    ro
                  </Tag>
                )}
              </div>
            ))}
          </Space>
        </SpecRow>
      )}
    </div>
  );
}

function envFromSource(valueFrom?: any): string {
  if (!valueFrom) return '—';
  if (valueFrom.configMapKeyRef)
    return `ConfigMap ${valueFrom.configMapKeyRef.name}.${valueFrom.configMapKeyRef.key}`;
  if (valueFrom.secretKeyRef)
    return `Secret ${valueFrom.secretKeyRef.name}.${valueFrom.secretKeyRef.key}`;
  if (valueFrom.fieldRef) return `field ${valueFrom.fieldRef.fieldPath}`;
  if (valueFrom.resourceFieldRef) return `resource ${valueFrom.resourceFieldRef.resource}`;
  return '—';
}
