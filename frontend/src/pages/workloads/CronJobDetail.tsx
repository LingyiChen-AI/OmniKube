import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Empty,
  Popconfirm,
  Result,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../../api/resource';
import { useApi } from '../../hooks/useApi';
import { useCtxStore } from '../../store/ctx';
import { useCapabilities } from '../../store/caps';
import { StatusTag, formatAge, formatTime } from '../../utils';
import EditResourceDrawer from '../../components/EditResourceDrawer';
import { defaultPagination } from '../../components/tableConfig';
import { podsForJob, jobPhase, isManualJob, jobsOwnedByCronJob, JobPodsDrawer } from '../../components/JobPods';

const { Title, Text } = Typography;

const LIST_PATH = '/workloads/cronjobs';

/**
 * CronJob detail page: schedule/overview + inline trigger history. Each historical
 * Job expands to its Pods; a Pod's "logs" action opens a right-side log drawer.
 */
export default function CronJobDetail() {
  const { t } = useTranslation();
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { currentCluster } = useCtxStore();
  const { can } = useCapabilities();

  const canTrigger = can('cronjobs', 'edit');
  const canWrite = can('cronjobs', 'edit');
  const canDelete = can('cronjobs', 'delete');

  const [yamlMode, setYamlMode] = useState<'view' | 'edit' | null>(null);
  const [podsJob, setPodsJob] = useState<K8sObject | null>(null);
  const [busy, setBusy] = useState(false);

  const cj = useApi<K8sObject | undefined>(
    () =>
      currentCluster ? resourceApi.get(namespace, 'cronjobs', name) : Promise.resolve(undefined),
    [currentCluster, namespace, name],
    { skip: !currentCluster },
  );
  const jobs = useApi<K8sObject[]>(
    () => (currentCluster ? resourceApi.list('jobs', namespace) : Promise.resolve([])),
    [currentCluster, namespace],
    { initial: [], skip: !currentCluster },
  );
  const pods = useApi<K8sObject[]>(
    () => (currentCluster ? resourceApi.list('pods', namespace) : Promise.resolve([])),
    [currentCluster, namespace],
    { initial: [], skip: !currentCluster },
  );

  const uid = cj.data?.metadata?.uid || '';
  const owned = useMemo(
    () => jobsOwnedByCronJob(jobs.data ?? [], name, uid),
    [jobs.data, name, uid],
  );

  // keep it live while any owned Job is still running.
  const anyActive = owned.some((j) => (j.status?.active ?? 0) > 0);
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => {
    cj.reloadSilent();
    jobs.reloadSilent();
    pods.reloadSilent();
  };
  useEffect(() => {
    if (!currentCluster) return;
    const id = window.setInterval(() => reloadRef.current(), anyActive ? 3000 : 12000);
    return () => window.clearInterval(id);
  }, [currentCluster, namespace, name, anyActive]);

  const reloadAll = () => {
    cj.reload();
    jobs.reload();
    pods.reload();
  };

  const doTrigger = async () => {
    setBusy(true);
    try {
      const jobName = await resourceApi.triggerCronJob(namespace, name);
      message.success(t('cronjob.triggered', { job: jobName }));
      jobs.reload();
      pods.reload();
    } catch {
      /* interceptor toast */
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    try {
      await resourceApi.remove(namespace, 'cronjobs', name);
      message.success(t('resource.deleted', { name }));
      navigate(LIST_PATH);
    } catch {
      /* interceptor toast */
    }
  };

  const breadcrumb = (
    <Breadcrumb
      items={[
        { title: t('nav.workloads') },
        { title: <Link to={LIST_PATH}>{t('nav.cronjobs')}</Link> },
        { title: name },
      ]}
    />
  );

  if (!currentCluster) {
    return (
      <Card>
        <Result status="info" title={t('resource.noCluster')} subTitle={t('resource.noClusterDesc')} />
      </Card>
    );
  }

  if (cj.loading && !cj.data) {
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

  if (cj.error || !cj.data) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {breadcrumb}
        <Card>
          <Result
            status="404"
            title={t('workloadDetail.notFound', { kind: t('nav.cronjobs') })}
            subTitle={t('workloadDetail.notFoundDesc', { name })}
            extra={
              <Button type="primary" onClick={() => navigate(LIST_PATH)}>
                {t('workloadDetail.back')}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const d = cj.data;
  const spec = d.spec || {};
  const suspended = !!spec.suspend;
  const tplContainers = (spec.jobTemplate?.spec?.template?.spec?.containers as any[]) || [];
  const images: string[] = tplContainers.map((c) => c.image).filter(Boolean);
  const activeCount = (d.status?.active?.length ?? 0) as number;

  const jobColumns: ColumnsType<K8sObject> = [
    {
      title: t('resource.name'),
      key: 'name',
      ellipsis: true,
      render: (_, r) => <Text strong>{r.metadata?.name}</Text>,
    },
    {
      title: t('cronjob.type'),
      key: 'type',
      width: 110,
      align: 'center',
      render: (_, r) =>
        isManualJob(r) ? (
          <Tag color="geekblue">{t('cronjob.manual')}</Tag>
        ) : (
          <Tag>{t('cronjob.scheduled')}</Tag>
        ),
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: 130,
      align: 'center',
      render: (_, r) => <StatusTag phase={jobPhase(r)} />,
    },
    {
      title: t('cronjob.completions'),
      key: 'completions',
      width: 110,
      align: 'center',
      render: (_, r) => {
        const done = (r.status?.succeeded ?? 0) as number;
        const want = (r.spec?.completions ?? 1) as number;
        return <Tag>{`${done}/${want}`}</Tag>;
      },
    },
    {
      title: t('resource.age'),
      key: 'age',
      width: 120,
      render: (_, r) => formatAge(r.metadata?.creationTimestamp),
    },
    {
      title: t('cronjob.viewPods'),
      key: 'pods',
      width: 130,
      align: 'right',
      render: (_, r) => {
        const n = podsForJob(pods.data ?? [], r.metadata?.name || '').length;
        return (
          <Space size={4} style={{ color: 'var(--ant-color-primary, #0EA5E9)' }}>
            <span>{t('cronjob.viewPods')}</span>
            <Tag style={{ margin: 0 }}>{n}</Tag>
            <RightOutlined style={{ fontSize: 11 }} />
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {breadcrumb}

      {/* Header */}
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
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(LIST_PATH)}>
              {t('workloadDetail.back')}
            </Button>
            <Space size={12} align="center" wrap style={{ marginTop: 6 }}>
              <Title level={3} style={{ margin: 0 }} ellipsis={{ tooltip: name }}>
                {name}
              </Title>
              <Tag color="geekblue">{namespace}</Tag>
              <Text code>{spec.schedule || '—'}</Text>
              {suspended ? (
                <Badge status="warning" text={t('resource.suspend')} />
              ) : (
                <Badge status="success" text={t('cronjob.active')} />
              )}
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

          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={reloadAll} loading={cj.loading}>
              {t('resource.refresh')}
            </Button>
            {canTrigger && (
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={busy}
                onClick={doTrigger}
              >
                {t('cronjob.trigger')}
              </Button>
            )}
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

      {/* Overview — one bordered grid so rows/labels align and spacing is uniform. */}
      <Card title={t('workloadDetail.overview')} styles={{ body: { paddingTop: 16 } }}>
        <Descriptions
          bordered
          column={2}
          size="middle"
          labelStyle={{ width: 160, whiteSpace: 'nowrap' }}
        >
          <Descriptions.Item label={t('resource.schedule')}>
            <Text code>{spec.schedule || '—'}</Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('resource.suspend')}>
            {suspended ? (
              <Tag color="orange">{t('common.yes')}</Tag>
            ) : (
              <Tag color="green">{t('common.no')}</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label={t('cronjob.concurrency')}>
            <Tag color="cyan">{spec.concurrencyPolicy || 'Allow'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t('resource.lastSchedule')}>
            {formatAge(d.status?.lastScheduleTime)}
          </Descriptions.Item>
          <Descriptions.Item label={t('resource.activeJobs')} span={2}>
            <Tag color={activeCount > 0 ? 'processing' : undefined}>{activeCount}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t('workloadDetail.images')} span={2}>
            {images.length ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {images.map((img) => (
                  <Text key={img} code copyable={{ text: img }} style={{ wordBreak: 'break-all' }}>
                    {img}
                  </Text>
                ))}
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* Trigger history */}
      <Card
        title={
          <Space>
            {t('cronjob.history')}
            <Tag>{owned.length}</Tag>
            <Tooltip title={t('workloadDetail.autoRefresh')}>
              <Badge status="processing" />
            </Tooltip>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table<K8sObject>
          rowKey={(r) => r.metadata?.name || ''}
          size="middle"
          columns={jobColumns}
          dataSource={owned}
          loading={jobs.loading && owned.length === 0}
          pagination={defaultPagination}
          onRow={(r) => ({
            onClick: () => setPodsJob(r),
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <Empty description={t('cronjob.noJobs')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ),
          }}
        />
      </Card>

      {/* Edit / view YAML drawer */}
      {yamlMode && (
        <EditResourceDrawer
          open
          resource="cronjobs"
          kind="CronJob"
          namespace={namespace}
          name={name}
          readOnly={yamlMode === 'view'}
          onClose={() => setYamlMode(null)}
          onSaved={reloadAll}
        />
      )}

      {/* Pods of the selected run — same drawer/table style as the Jobs page */}
      {podsJob && (
        <JobPodsDrawer
          ns={namespace}
          job={podsJob.metadata?.name || ''}
          onClose={() => setPodsJob(null)}
          title={
            <Space size={8} wrap>
              <FileSearchOutlined style={{ color: '#0EA5E9' }} />
              <Text strong>{podsJob.metadata?.name}</Text>
              {isManualJob(podsJob) ? (
                <Tag color="geekblue">{t('cronjob.manual')}</Tag>
              ) : (
                <Tag>{t('cronjob.scheduled')}</Tag>
              )}
              <StatusTag phase={jobPhase(podsJob)} />
            </Space>
          }
        />
      )}
    </div>
  );
}
