import { useEffect, useState } from 'react';
import {
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from 'antd';
import {
  DeploymentUnitOutlined,
  ContainerOutlined,
  ClusterOutlined,
  RocketOutlined,
  BellOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCtxStore } from '../../store/ctx';
import { useCapabilities } from '../../store/caps';
import { useAuthStore } from '../../store/auth';
import { resourceApi, type K8sObject } from '../../api/resource';
import { clusterApi, type Cluster } from '../../api/cluster';
import { releaseApi, countTodayReleases } from '../../api/release';
import { metricsApi, formatCpu, formatBytes, type NodeMetric } from '../../api/metrics';
import { useApi } from '../../hooks/useApi';
import { ClusterStatusBadge, formatAge } from '../../utils';

const { Title, Text, Paragraph } = Typography;

/** Tri-state for async values: loading → ok(data) | error. */
type Async<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; data: T };

const LOADING = { status: 'loading' } as const;

interface MetricView {
  key: string;
  label: string;
  value: Async<number>;
  /** Optional faded suffix, e.g. "/ 42" total. */
  suffix?: string;
  icon: React.ReactNode;
  gradient: string;
  route?: string;
}

interface EventItem {
  uid: string;
  type: string;
  reason: string;
  message: string;
  objectKind: string;
  objectName: string;
  namespace: string;
  ts?: string;
}

const GRADIENTS = {
  indigo: 'linear-gradient(135deg, #38BDF8 0%, #0284C7 100%)',
  green: 'linear-gradient(135deg, #16A34A 0%, #047857 100%)',
  sky: 'linear-gradient(135deg, #0EA5E9 0%, #0369A1 100%)',
  orange: 'linear-gradient(135deg, #F97316 0%, #C2410C 100%)',
};

function eventTimestamp(ev: K8sObject): string | undefined {
  return (
    (ev.lastTimestamp as string) ||
    (ev.eventTime as string) ||
    (ev.firstTimestamp as string) ||
    ev.metadata?.creationTimestamp
  );
}

function toEventItem(ev: K8sObject, idx: number): EventItem {
  const involved = (ev.involvedObject as Record<string, string>) || {};
  return {
    uid: ev.metadata?.uid || `${ev.metadata?.name ?? ''}-${idx}`,
    type: (ev.type as string) || 'Normal',
    reason: (ev.reason as string) || '',
    message: (ev.message as string) || '',
    objectKind: involved.kind || '',
    objectName: involved.name || '',
    namespace: involved.namespace || ev.metadata?.namespace || '',
    ts: eventTimestamp(ev),
  };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();
  const { currentCluster, currentNamespace } = useCtxStore();
  const { can } = useCapabilities();
  const isAdmin = !!useAuthStore((s) => s.user?.is_admin);
  // Nodes are cluster-scoped; events aren't in the RBAC model (admin-only).
  // Gate both so namespace-scoped users don't trigger dashboard 403s.
  const canNodes = isAdmin || can('nodes', 'view');
  const canEvents = isAdmin;

  // Cluster-independent: the set of clusters the user can access.
  const [clusters, setClusters] = useState<Async<Cluster[]>>(LOADING);
  // Cluster-scoped resource-derived numbers (require a selected cluster).
  const [pods, setPods] = useState<Async<{ running: number; total: number }>>(LOADING);
  const [deployments, setDeployments] = useState<Async<number>>(LOADING);
  const [nodes, setNodes] = useState<Async<number>>(LOADING);
  const [todayReleases, setTodayReleases] = useState<Async<number>>(LOADING);
  const [events, setEvents] = useState<Async<EventItem[]>>(LOADING);

  // Accessible clusters — independent of the active cluster selection.
  useEffect(() => {
    let active = true;
    setClusters(LOADING);
    clusterApi
      .list()
      .then((data) => active && setClusters({ status: 'ok', data }))
      .catch(() => active && setClusters({ status: 'error' }));
    return () => {
      active = false;
    };
  }, []);

  // Cluster-scoped data: pods / deployments / nodes / releases / events.
  useEffect(() => {
    if (!currentCluster) return;
    let active = true;
    const ns = currentNamespace ?? undefined;
    setPods(LOADING);
    setDeployments(LOADING);
    setTodayReleases(LOADING);

    resourceApi
      .list('pods', ns)
      .then((items) => {
        if (!active) return;
        const running = items.filter((p) => p.status?.phase === 'Running').length;
        setPods({ status: 'ok', data: { running, total: items.length } });
      })
      .catch(() => active && setPods({ status: 'error' }));

    resourceApi
      .list('deployments', ns)
      .then((items) => active && setDeployments({ status: 'ok', data: items.length }))
      .catch(() => active && setDeployments({ status: 'error' }));

    releaseApi
      .list({ cluster_id: currentCluster, limit: 500 })
      .then((items) => active && setTodayReleases({ status: 'ok', data: countTodayReleases(items) }))
      .catch(() => active && setTodayReleases({ status: 'error' }));

    return () => {
      active = false;
    };
  }, [currentCluster, currentNamespace]);

  // Nodes (cluster-scoped) + events (admin-only) are permission-gated so a
  // namespace-scoped user never fires a call that would 403. Re-runs when the
  // capability resolves. Not permitted → show the degraded state (— / no-perm).
  useEffect(() => {
    if (!currentCluster) return;
    let active = true;
    const ns = currentNamespace ?? undefined;

    if (canNodes) {
      setNodes(LOADING);
      resourceApi
        .list('nodes')
        .then((items) => active && setNodes({ status: 'ok', data: items.length }))
        .catch(() => active && setNodes({ status: 'error' }));
    } else {
      setNodes({ status: 'error' });
    }

    if (canEvents) {
      setEvents(LOADING);
      resourceApi
        .list('events', ns)
        .then((items) => {
          if (!active) return;
          const sorted = items
            .map(toEventItem)
            .sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''))
            .slice(0, 10);
          setEvents({ status: 'ok', data: sorted });
        })
        .catch(() => active && setEvents({ status: 'error' }));
    } else {
      setEvents({ status: 'error' });
    }

    return () => {
      active = false;
    };
  }, [currentCluster, currentNamespace, canNodes, canEvents]);

  const clusterCount: Async<number> =
    clusters.status === 'ok'
      ? { status: 'ok', data: clusters.data.length }
      : clusters;

  // Without a selected cluster, resource-derived cards show an em dash.
  const noCluster = !currentCluster;
  const gated = <T,>(v: Async<T>): Async<T> => (noCluster ? { status: 'error' } : v);

  const nodeMetrics = useApi(() => metricsApi.nodes(), [currentCluster], {
    initial: { available: false, nodes: [] as NodeMetric[] },
    skip: noCluster,
  });

  const metrics: MetricView[] = [
    {
      key: 'clusters',
      label: t('dashboard.clustersCard'),
      value: clusterCount,
      icon: <ClusterOutlined />,
      gradient: GRADIENTS.indigo,
      route: '/clusters',
    },
    {
      key: 'pods',
      label: t('dashboard.runningPods'),
      value: gated(
        pods.status === 'ok'
          ? { status: 'ok', data: pods.data.running }
          : pods,
      ),
      suffix:
        !noCluster && pods.status === 'ok' ? ` / ${pods.data.total}` : undefined,
      icon: <ContainerOutlined />,
      gradient: GRADIENTS.green,
      route: '/workloads/pods',
    },
    {
      key: 'deployments',
      label: t('dashboard.deploymentsCard'),
      value: gated(deployments),
      icon: <DeploymentUnitOutlined />,
      gradient: GRADIENTS.sky,
      route: '/workloads/deployments',
    },
    {
      key: 'releases',
      label: t('dashboard.todayReleases'),
      value: gated(todayReleases),
      icon: <RocketOutlined />,
      gradient: GRADIENTS.orange,
      route: '/releases',
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ marginBottom: 4 }}>
          {t('dashboard.title')}
        </Title>
        <Text type="secondary">
          {t('dashboard.cluster')}{' '}
          <Tag color={currentCluster ? 'geekblue' : 'default'}>
            {currentCluster || t('dashboard.noCluster')}
          </Tag>
          {' · '}
          {t('dashboard.namespace')}{' '}
          <Tag color={currentNamespace ? 'cyan' : 'default'}>
            {currentNamespace || t('dashboard.allNamespaces')}
          </Tag>
        </Text>
      </div>

      {/* Summary cards */}
      <Row gutter={[16, 16]}>
        {metrics.map((m) => (
          <Col key={m.key} xs={12} md={6}>
            <Card
              className="ok-metric"
              role="button"
              tabIndex={0}
              onClick={() => m.route && navigate(m.route)}
              onKeyDown={(e) => {
                if (m.route && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  navigate(m.route);
                }
              }}
              style={{ background: m.gradient }}
              styles={{ body: { padding: 20 } }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.88)',
                      marginBottom: 10,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {m.label}
                  </div>
                  {m.value.status === 'loading' ? (
                    <Skeleton.Button
                      active
                      size="large"
                      style={{ width: 56, height: 34, background: 'rgba(255,255,255,0.25)' }}
                    />
                  ) : (
                    <div
                      className="ok-metric__value"
                      style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}
                    >
                      {m.value.status === 'ok' ? m.value.data : '—'}
                      {m.suffix && (
                        <span style={{ fontSize: 16, fontWeight: 500, color: 'rgba(255,255,255,0.7)' }}>
                          {m.suffix}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 44,
                    height: 44,
                    flexShrink: 0,
                    borderRadius: 12,
                    fontSize: 22,
                    color: '#fff',
                    background: 'rgba(255,255,255,0.18)',
                  }}
                >
                  {m.icon}
                </span>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Cluster resource water-level (metrics-server) */}
      {!noCluster && nodeMetrics.data?.available && nodeMetrics.data.nodes.length > 0 && (
        <Row style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card
              title={
                <Space>
                  <DatabaseOutlined style={{ color: token.colorPrimary }} />
                  {t('metrics.clusterUsage')}
                </Space>
              }
            >
              <ResourceWaterLevel nodes={nodeMetrics.data.nodes} />
            </Card>
          </Col>
        </Row>
      )}

      {/* Recent events + cluster status */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={15}>
          <Card
            title={
              <Space>
                <BellOutlined style={{ color: token.colorPrimary }} />
                {t('dashboard.recentEvents')}
              </Space>
            }
            styles={{ body: { padding: events.status === 'ok' && events.data.length ? 0 : 24 } }}
          >
            <RecentEvents events={noCluster ? { status: 'error' } : events} noCluster={noCluster} />
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card
            title={
              <Space>
                <ClusterOutlined style={{ color: token.colorPrimary }} />
                {t('dashboard.clusterStatus')}
              </Space>
            }
            styles={{ body: { padding: 12 } }}
          >
            <ClusterStatusPanel
              clusters={clusters}
              currentCluster={currentCluster}
              nodes={nodes}
              pods={pods}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

/** Aggregate node CPU/memory usage vs allocatable, as two water-level bars. */
function ResourceWaterLevel({ nodes }: { nodes: NodeMetric[] }) {
  const { t } = useTranslation();
  const sum = nodes.reduce(
    (a, n) => ({
      cpu: a.cpu + n.cpu,
      cpuCap: a.cpuCap + n.cpu_capacity,
      mem: a.mem + n.memory,
      memCap: a.memCap + n.mem_capacity,
    }),
    { cpu: 0, cpuCap: 0, mem: 0, memCap: 0 },
  );
  const cpuPct = sum.cpuCap ? Math.round((sum.cpu * 100) / sum.cpuCap) : 0;
  const memPct = sum.memCap ? Math.round((sum.mem * 100) / sum.memCap) : 0;

  return (
    <Row gutter={[24, 12]}>
      <Col xs={24} md={12}>
        <Text type="secondary">
          {t('metrics.cpu')} · {formatCpu(sum.cpu)} / {formatCpu(sum.cpuCap)}
        </Text>
        <Progress percent={cpuPct} status={cpuPct >= 90 ? 'exception' : 'normal'} />
      </Col>
      <Col xs={24} md={12}>
        <Text type="secondary">
          {t('metrics.memory')} · {formatBytes(sum.mem)} / {formatBytes(sum.memCap)}
        </Text>
        <Progress percent={memPct} status={memPct >= 90 ? 'exception' : 'normal'} />
      </Col>
    </Row>
  );
}

function RecentEvents({
  events,
  noCluster,
}: {
  events: Async<EventItem[]>;
  noCluster: boolean;
}) {
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();

  if (noCluster) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.selectClusterHint')} />;
  }
  if (events.status === 'loading') {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }
  if (events.status === 'error' || events.data.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.noEvents')} />;
  }

  return (
    <div>
      {events.data.map((ev, i) => {
        const warning = ev.type === 'Warning';
        return (
          <div
            key={ev.uid}
            style={{
              display: 'flex',
              gap: 12,
              padding: '12px 24px',
              borderTop: i === 0 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Tag
              color={warning ? 'warning' : 'success'}
              style={{ marginTop: 2, height: 22, flexShrink: 0 }}
            >
              {t(warning ? 'dashboard.eventWarning' : 'dashboard.eventNormal')}
            </Tag>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Text strong style={{ fontSize: 13 }}>
                  {ev.reason || '—'}
                </Text>
                {(ev.objectKind || ev.objectName) && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {ev.objectKind}
                    {ev.objectKind && ev.objectName ? '/' : ''}
                    {ev.objectName}
                    {ev.namespace ? ` · ${ev.namespace}` : ''}
                  </Text>
                )}
              </div>
              <Tooltip title={ev.message}>
                <Paragraph
                  type="secondary"
                  ellipsis={{ rows: 1 }}
                  style={{ fontSize: 12, margin: '2px 0 0' }}
                >
                  {ev.message || '—'}
                </Paragraph>
              </Tooltip>
            </div>
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {formatAge(ev.ts)}
            </Text>
          </div>
        );
      })}
    </div>
  );
}

function ClusterStatusPanel({
  clusters,
  currentCluster,
  nodes,
  pods,
}: {
  clusters: Async<Cluster[]>;
  currentCluster: string | null;
  nodes: Async<number>;
  pods: Async<{ running: number; total: number }>;
}) {
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();

  if (clusters.status === 'loading') {
    return <Skeleton active paragraph={{ rows: 4 }} />;
  }
  if (clusters.status === 'error' || clusters.data.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.noClusters')} />;
  }

  const renderCount = (v: Async<number>): React.ReactNode =>
    v.status === 'loading' ? '…' : v.status === 'ok' ? v.data : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {clusters.data.map((c) => {
        const isCurrent = c.id === currentCluster;
        return (
          <div
            key={c.id}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${isCurrent ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
              background: isCurrent ? token.colorPrimaryBg : token.colorFillQuaternary,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Space size={8} style={{ minWidth: 0 }}>
                <ClusterStatusBadge status={c.status} />
                <Text strong style={{ fontSize: 13 }} ellipsis>
                  {c.name}
                </Text>
                {isCurrent && <Tag color="geekblue" style={{ margin: 0 }}>{t('dashboard.current')}</Tag>}
              </Space>
            </div>
            {isCurrent && (
              <div style={{ display: 'flex', gap: 16, marginTop: 8, paddingLeft: 2 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <DatabaseOutlined style={{ marginRight: 4 }} />
                  {t('dashboard.nodes')}: {renderCount(nodes)}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <ContainerOutlined style={{ marginRight: 4 }} />
                  {t('dashboard.pods')}: {pods.status === 'ok' ? pods.data.total : pods.status === 'loading' ? '…' : '—'}
                </Text>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
