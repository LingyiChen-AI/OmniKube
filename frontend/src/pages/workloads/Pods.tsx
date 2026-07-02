import { useMemo, useState } from 'react';
import { Button, Drawer, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { FileSearchOutlined, CodeOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import TerminalPanel from '../../components/TerminalPanel';
import type { K8sObject } from '../../api/resource';
import { useCtxStore } from '../../store/ctx';
import { useCapabilities } from '../../store/caps';
import { execUrl, logsUrl } from '../../api/ws';
import { StatusTag } from '../../utils';
import { metricsApi, formatCpu, formatBytes, type PodMetric } from '../../api/metrics';
import { useApi } from '../../hooks/useApi';

const { Text } = Typography;

function containerNames(pod: K8sObject): string[] {
  const cs = (pod.spec?.containers || []) as any[];
  return cs.map((c) => c.name).filter(Boolean);
}

function readyCount(pod: K8sObject): string {
  const statuses = (pod.status?.containerStatuses || []) as any[];
  const ready = statuses.filter((s) => s.ready).length;
  return `${ready}/${statuses.length || (pod.spec?.containers || []).length || 0}`;
}

function restarts(pod: K8sObject): number {
  const statuses = (pod.status?.containerStatuses || []) as any[];
  return statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
}

type PanelKind = 'logs' | 'exec';

export default function Pods() {
  const { t } = useTranslation();
  const { currentCluster, currentNamespace } = useCtxStore();
  const { can } = useCapabilities();
  const [panel, setPanel] = useState<{ pod: K8sObject; kind: PanelKind } | null>(null);
  const [container, setContainer] = useState<string>('');

  const metrics = useApi(() => metricsApi.pods(currentNamespace ?? undefined), [currentCluster, currentNamespace], {
    initial: { available: false, pods: [] as PodMetric[] },
    skip: !currentCluster,
  });
  const byKey = useMemo(() => {
    const m = new Map<string, PodMetric>();
    (metrics.data?.pods ?? []).forEach((p) => m.set(`${p.namespace}/${p.name}`, p));
    return m;
  }, [metrics.data]);
  const metricsOn = metrics.data?.available ?? false;

  const usageCols: ColumnsType<K8sObject> = metricsOn
    ? [
        {
          title: t('metrics.cpu'),
          key: 'cpu',
          width: 100,
          align: 'right',
          render: (_, r) => {
            const m = byKey.get(`${r.metadata?.namespace}/${r.metadata?.name}`);
            return m ? <Text>{formatCpu(m.cpu)}</Text> : <Text type="secondary">—</Text>;
          },
        },
        {
          title: t('metrics.memory'),
          key: 'memory',
          width: 100,
          align: 'right',
          render: (_, r) => {
            const m = byKey.get(`${r.metadata?.namespace}/${r.metadata?.name}`);
            return m ? <Text>{formatBytes(m.memory)}</Text> : <Text type="secondary">—</Text>;
          },
        },
      ]
    : [];

  const extra: ColumnsType<K8sObject> = [
    ...usageCols,
    {
      title: t('resource.ready'),
      key: 'ready',
      width: 100,
      align: 'center',
      render: (_, r) => <Tag>{readyCount(r)}</Tag>,
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: 150,
      align: 'center',
      render: (_, r) => <StatusTag phase={r.status?.phase} />,
    },
    {
      title: t('resource.restarts'),
      key: 'restarts',
      width: 110,
      align: 'center',
      render: (_, r) => {
        const n = restarts(r);
        return <Text type={n > 0 ? 'warning' : undefined}>{n}</Text>;
      },
    },
    {
      title: t('resource.node'),
      key: 'node',
      width: 200,
      ellipsis: true,
      render: (_, r) => <Text type="secondary">{r.spec?.nodeName || '—'}</Text>,
    },
  ];

  const containers = useMemo(
    () => (panel ? containerNames(panel.pod) : []),
    [panel],
  );

  const openPanel = (pod: K8sObject, kind: PanelKind) => {
    const names = containerNames(pod);
    setContainer(names[0] || '');
    setPanel({ pod, kind });
  };

  const wsUrl = useMemo(() => {
    if (!panel || !currentCluster) return '';
    const base = {
      cluster_id: currentCluster,
      namespace: panel.pod.metadata?.namespace || 'default',
      pod: panel.pod.metadata?.name || '',
      container: container || undefined,
    };
    return panel.kind === 'logs'
      ? logsUrl({ ...base, follow: true, tail: 500 })
      : execUrl(base);
  }, [panel, container, currentCluster]);

  const canExec = can('pods', 'exec');

  const rowActions = (rec: K8sObject) => (
    <>
      <Tooltip title={t('pod.logs')}>
        <Button
          type="text"
          size="small"
          icon={<FileSearchOutlined />}
          onClick={() => openPanel(rec, 'logs')}
        />
      </Tooltip>
      {canExec && (
        <Tooltip title={t('pod.terminal')}>
          <Button
            type="text"
            size="small"
            icon={<CodeOutlined />}
            onClick={() => openPanel(rec, 'exec')}
          />
        </Tooltip>
      )}
    </>
  );

  return (
    <>
      <ResourceTable
        title={t('nav.pods')}
        resource="pods"
        description={t('pages.pods.desc')}
        extraColumns={extra}
        rowActions={rowActions}
      />

      <Drawer
        open={!!panel}
        onClose={() => setPanel(null)}
        width={920}
        destroyOnClose
        styles={{ body: { display: 'flex', flexDirection: 'column', padding: 16, height: '100%' } }}
        title={
          <Space>
            <Text strong>
              {panel?.kind === 'logs' ? t('pod.logsTitle') : t('pod.terminalTitle')} · {panel?.pod.metadata?.name}
            </Text>
          </Space>
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
            // Re-mount when container or kind changes to reset the socket.
            key={`${panel.kind}-${container}`}
            url={wsUrl}
            interactive={panel.kind === 'exec'}
          />
        )}
      </Drawer>
    </>
  );
}
