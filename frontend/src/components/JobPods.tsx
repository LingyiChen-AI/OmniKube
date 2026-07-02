import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Drawer, Empty, Space, Table, Tag, Tooltip, Typography, Badge } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FileSearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../api/resource';
import { useCtxStore } from '../store/ctx';
import { useApi } from '../hooks/useApi';
import { logsUrl } from '../api/ws';
import { StatusTag, formatAge } from '../utils';
import { defaultPagination } from './tableConfig';
import TerminalPanel from './TerminalPanel';

const { Text } = Typography;

type Tr = (key: string) => string;

/** Job phase mapped onto pod-style phrases so StatusTag colours it consistently. */
export function jobPhase(job: K8sObject): string {
  const conds = (job.status?.conditions || []) as { type?: string; status?: string }[];
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'Succeeded';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'Failed';
  if ((job.status?.active ?? 0) > 0) return 'Running';
  return 'Pending';
}

/** Whether a Job was created by a manual CronJob trigger (vs. the scheduler). */
export function isManualJob(job: K8sObject): boolean {
  return (job.metadata?.annotations || {})['cronjob.kubernetes.io/instantiate'] === 'manual';
}

/** Jobs owned by a given CronJob (by uid, falling back to name), newest first. */
export function jobsOwnedByCronJob(
  jobs: K8sObject[],
  cronjob: string,
  uid: string,
): K8sObject[] {
  return jobs
    .filter((j) =>
      (j.metadata?.ownerReferences || []).some(
        (o: { uid?: string; kind?: string; name?: string }) =>
          o.kind === 'CronJob' && (uid ? o.uid === uid : o.name === cronjob),
      ),
    )
    .sort((a, b) =>
      (b.metadata?.creationTimestamp || '').localeCompare(a.metadata?.creationTimestamp || ''),
    );
}

export function containerNames(pod: K8sObject): string[] {
  const cs = (pod.spec?.containers || []) as { name?: string }[];
  return cs.map((c) => c.name).filter(Boolean) as string[];
}

/** Pods carrying this Job's `job-name` label. */
export function podsForJob(pods: K8sObject[], job: string): K8sObject[] {
  return pods.filter((p) => (p.metadata?.labels || {})['job-name'] === job);
}

/** Shared Pod columns with a "view logs" action. */
export function podColumns(t: Tr, onLog: (pod: K8sObject) => void): ColumnsType<K8sObject> {
  return [
    {
      title: t('resource.name'),
      key: 'name',
      ellipsis: true,
      render: (_, r) => <Text strong>{r.metadata?.name}</Text>,
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: 130,
      align: 'center',
      render: (_, r) => <StatusTag phase={r.status?.phase} />,
    },
    {
      title: t('resource.ready'),
      key: 'ready',
      width: 90,
      align: 'center',
      render: (_, r) => {
        const cs = (r.status?.containerStatuses || []) as { ready?: boolean }[];
        return <Tag>{`${cs.filter((s) => s.ready).length}/${cs.length || 1}`}</Tag>;
      },
    },
    {
      title: t('resource.node'),
      key: 'node',
      width: 200,
      ellipsis: true,
      render: (_, r) => <Text type="secondary">{r.spec?.nodeName || '—'}</Text>,
    },
    {
      title: t('resource.age'),
      key: 'age',
      width: 110,
      render: (_, r) => formatAge(r.metadata?.creationTimestamp),
    },
    {
      title: t('resource.actions'),
      key: 'actions',
      width: 80,
      align: 'center',
      render: (_, r) => (
        <Tooltip title={t('pod.logs')}>
          <Button type="text" size="small" icon={<FileSearchOutlined />} onClick={() => onLog(r)} />
        </Tooltip>
      ),
    },
  ];
}

/** Read-only, follow-mode log stream for a single Pod. */
export function PodLogDrawer({ pod, onClose }: { pod: K8sObject; onClose: () => void }) {
  const { t } = useTranslation();
  const { currentCluster } = useCtxStore();
  const url = currentCluster
    ? logsUrl({
        cluster_id: currentCluster,
        namespace: pod.metadata?.namespace || 'default',
        pod: pod.metadata?.name || '',
        container: containerNames(pod)[0] || undefined,
        follow: true,
        tail: 500,
      })
    : '';
  return (
    <Drawer
      open
      width="min(920px, 88vw)"
      destroyOnClose
      onClose={onClose}
      styles={{ body: { display: 'flex', flexDirection: 'column', padding: 16, height: '100%' } }}
      title={
        <Space>
          <FileSearchOutlined style={{ color: '#0EA5E9' }} />
          <Text strong>
            {t('pod.logsTitle')} · {pod.metadata?.name}
          </Text>
        </Space>
      }
    >
      {url && <TerminalPanel key={url} url={url} interactive={false} />}
    </Drawer>
  );
}

/** Live Pods for a single Job, each with a log viewer. Reused by CronJob trigger + Jobs page. */
export function JobPodsDrawer({
  ns,
  job,
  title,
  onClose,
}: {
  ns: string;
  job: string;
  title: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [logPod, setLogPod] = useState<K8sObject | null>(null);

  const pods = useApi<K8sObject[]>(() => resourceApi.list('pods', ns), [ns, job], { initial: [] });
  const jobPods = useMemo(() => podsForJob(pods.data ?? [], job), [pods.data, job]);

  // live-poll until pods settle (Succeeded/Failed), then slow down.
  const settled =
    jobPods.length > 0 && jobPods.every((p) => ['Succeeded', 'Failed'].includes(p.status?.phase));
  const { reloadSilent } = pods;
  useEffect(() => {
    const id = window.setInterval(() => reloadSilent(), settled ? 8000 : 2500);
    return () => window.clearInterval(id);
  }, [ns, job, settled, reloadSilent]);

  return (
    <Drawer open width="min(1080px, 92vw)" onClose={onClose} title={title}>
      <Table<K8sObject>
        rowKey={(r) => r.metadata?.name || ''}
        size="small"
        columns={podColumns(t, setLogPod)}
        dataSource={jobPods}
        loading={pods.loading && jobPods.length === 0}
        pagination={defaultPagination}
        locale={{
          emptyText: <Empty description={t('cronjob.noPodsYet')} image={Empty.PRESENTED_IMAGE_SIMPLE} />,
        }}
      />
      {logPod && <PodLogDrawer pod={logPod} onClose={() => setLogPod(null)} />}
    </Drawer>
  );
}

/** Row action for a Job: open its Pods (with per-Pod log viewer). */
export function JobPodsAction({ rec }: { rec: K8sObject }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ns = rec.metadata?.namespace || 'default';
  const job = rec.metadata?.name || '';
  return (
    <>
      <Tooltip title={t('cronjob.viewPods')}>
        <Button
          type="text"
          size="small"
          icon={<FileSearchOutlined />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      {open && (
        <JobPodsDrawer
          ns={ns}
          job={job}
          onClose={() => setOpen(false)}
          title={
            <Space>
              <FileSearchOutlined style={{ color: '#0EA5E9' }} />
              <Text strong>{job}</Text>
              <Tag color="geekblue">{t('cronjob.viewPods')}</Tag>
              <Tooltip title={t('workloadDetail.autoRefresh')}>
                <Badge status="processing" />
              </Tooltip>
            </Space>
          }
        />
      )}
    </>
  );
}
