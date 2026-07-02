import { useMemo } from 'react';
import type { ColumnsType } from 'antd/es/table';
import { Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';
import { metricsApi, formatCpu, formatBytes, type NodeMetric } from '../../api/metrics';
import { useApi } from '../../hooks/useApi';
import { useCtxStore } from '../../store/ctx';

const { Text } = Typography;

/** A compact usage/allocatable water-level bar. */
function UsageBar({ pct, label }: { pct: number; label: string }) {
  return (
    <Tooltip title={label}>
      <div style={{ minWidth: 120 }}>
        <Progress
          percent={Math.min(pct, 100)}
          size="small"
          status={pct >= 90 ? 'exception' : 'normal'}
          format={() => `${pct}%`}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </div>
    </Tooltip>
  );
}

/** A node is Ready when its "Ready" condition has status "True". */
function readyStatus(node: K8sObject): boolean | null {
  const conds = (node.status?.conditions ?? []) as Array<{ type?: string; status?: string }>;
  const ready = conds.find((c) => c.type === 'Ready');
  if (!ready) return null;
  return ready.status === 'True';
}

/** Derive node roles from the `node-role.kubernetes.io/<role>` labels. */
function nodeRoles(node: K8sObject): string[] {
  const labels = (node.metadata?.labels ?? {}) as Record<string, string>;
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  return roles;
}

export default function Nodes() {
  const { t } = useTranslation();
  const { currentCluster } = useCtxStore();

  const metrics = useApi(() => metricsApi.nodes(), [currentCluster], {
    initial: { available: false, nodes: [] as NodeMetric[] },
    skip: !currentCluster,
  });
  const byName = useMemo(() => {
    const m = new Map<string, NodeMetric>();
    (metrics.data?.nodes ?? []).forEach((n) => m.set(n.name, n));
    return m;
  }, [metrics.data]);
  const metricsOn = metrics.data?.available ?? false;

  const usageCols: ColumnsType<K8sObject> = metricsOn
    ? [
        {
          title: t('metrics.cpu'),
          key: 'cpu',
          width: 160,
          render: (_, r) => {
            const m = byName.get(r.metadata?.name || '');
            return m ? (
              <UsageBar pct={m.cpu_pct} label={`${formatCpu(m.cpu)} / ${formatCpu(m.cpu_capacity)}`} />
            ) : (
              <Text type="secondary">—</Text>
            );
          },
        },
        {
          title: t('metrics.memory'),
          key: 'memory',
          width: 160,
          render: (_, r) => {
            const m = byName.get(r.metadata?.name || '');
            return m ? (
              <UsageBar pct={m.mem_pct} label={`${formatBytes(m.memory)} / ${formatBytes(m.mem_capacity)}`} />
            ) : (
              <Text type="secondary">—</Text>
            );
          },
        },
      ]
    : [];

  const extra: ColumnsType<K8sObject> = [
    ...usageCols,
    {
      title: t('resource.status'),
      key: 'status',
      width: 130,
      align: 'center',
      render: (_, r) => {
        const ready = readyStatus(r);
        if (ready === null) return <Tag>—</Tag>;
        return ready ? (
          <Tag color="green">{t('resource.ready')}</Tag>
        ) : (
          <Tag color="red">{t('node.notReady')}</Tag>
        );
      },
    },
    {
      title: t('node.roles'),
      key: 'roles',
      width: 200,
      render: (_, r) => {
        const roles = nodeRoles(r);
        return roles.length ? (
          <Space size={[4, 4]} wrap>
            {roles.map((role) => (
              <Tag key={role} color="geekblue">
                {role}
              </Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        );
      },
    },
    {
      title: t('node.version'),
      key: 'version',
      width: 160,
      ellipsis: true,
      render: (_, r) => (
        <Text type="secondary">{r.status?.nodeInfo?.kubeletVersion || '—'}</Text>
      ),
    },
  ];

  return (
    <ResourceTable
      title={t('nav.nodes')}
      resource="nodes"
      namespaced={false}
      description={t('pages.nodes.desc')}
      extraColumns={extra}
    />
  );
}
