import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Empty,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Button,
  Input,
  Select,
  DatePicker,
  theme as antdTheme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AuditOutlined, ReloadOutlined, DownloadOutlined, SearchOutlined, UserOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import dayjs, { type Dayjs } from 'dayjs';
import { auditApi, AUDIT_ACTIONS, AUDIT_RESULTS, type AuditLog, type AuditParams } from '../../api/audit';
import { clusterApi } from '../../api/cluster';
import { ALL_RESOURCES } from '../../api/role';
import { useApi } from '../../hooks/useApi';
import { defaultTableProps, defaultPagination, tableScrollX } from '../../components/tableConfig';
import { formatAge, formatTime } from '../../utils';

const { Title, Text } = Typography;

/** Resource types the audit filter offers (k8s plurals + platform areas). */
const RESOURCE_OPTIONS = [...ALL_RESOURCES, 'clusters', 'users', 'roles', 'audit', 'releases'];

/** Result → tag color. */
const RESULT_COLOR: Record<string, string> = {
  success: 'green',
  denied: 'orange',
  failed: 'red',
};

/** Draft filter shape held in the form bar (before "search" applies it). */
interface Draft {
  user_id: string;
  action?: string;
  resource: string;
  cluster_id: string;
  namespace: string;
  result?: string;
  range?: [Dayjs, Dayjs] | null;
}

const EMPTY_DRAFT: Draft = { user_id: '', resource: '', cluster_id: '', namespace: '' };

export default function AuditLogs() {
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<AuditParams>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [exporting, setExporting] = useState(false);

  const query = useMemo<AuditParams>(
    () => ({ ...applied, limit: pageSize, offset: (page - 1) * pageSize }),
    [applied, page, pageSize],
  );

  const logs = useApi(() => auditApi.list(query), [query], {
    initial: { logs: [], total: 0 },
  });

  // Clusters come from /my/clusters (available to any authenticated user).
  const clusters = useApi(() => clusterApi.list(), [], { initial: [] });

  // Operator options accumulate from loaded rows (permission-free, shows names).
  const userMap = useRef(new Map<string, string>());
  const [, forceUsers] = useState(0);
  useEffect(() => {
    let added = false;
    for (const l of logs.data?.logs ?? []) {
      if (l.user_id && !userMap.current.has(l.user_id)) {
        userMap.current.set(l.user_id, l.username || `#${l.user_id}`);
        added = true;
      }
    }
    if (added) forceUsers((n) => n + 1);
  }, [logs.data]);
  const userOptions = useMemo(
    () => Array.from(userMap.current, ([value, label]) => ({ value, label })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userMap.current.size],
  );

  const applyFilters = () => {
    const next: AuditParams = {
      user_id: draft.user_id.trim() || undefined,
      action: draft.action,
      resource: draft.resource.trim() || undefined,
      cluster_id: draft.cluster_id.trim() || undefined,
      namespace: draft.namespace.trim() || undefined,
      result: draft.result,
      from: draft.range?.[0]?.toISOString(),
      to: draft.range?.[1]?.toISOString(),
    };
    setApplied(next);
    setPage(1);
  };

  const resetFilters = () => {
    setDraft(EMPTY_DRAFT);
    setApplied({});
    setPage(1);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      await auditApi.exportCsv(applied);
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<AuditLog> = [
    {
      title: t('audit.time'),
      dataIndex: 'created_at',
      key: 'time',
      width: 160,
      fixed: 'left',
      render: (ts: string) => (
        <Tooltip title={formatTime(ts)}>
          <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatAge(ts)}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('audit.user'),
      key: 'user',
      width: 140,
      render: (_, r) =>
        r.user_id || r.username ? (
          <Tooltip title={r.user_id ? `ID #${r.user_id}` : undefined}>
            <Tag icon={<UserOutlined />} color="cyan">
              {r.username || `#${r.user_id}`}
            </Tag>
          </Tooltip>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('audit.action'),
      dataIndex: 'action',
      key: 'action',
      width: 130,
      render: (v: string) => <Tag color="geekblue">{v}</Tag>,
    },
    {
      title: t('audit.result'),
      dataIndex: 'result',
      key: 'result',
      width: 100,
      render: (v: string) => <Tag color={RESULT_COLOR[v] ?? 'default'}>{t(`audit.results.${v}`, v)}</Tag>,
    },
    {
      title: t('audit.location'),
      key: 'location',
      width: 200,
      render: (_, r) => (
        <Space size={4} wrap>
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {r.cluster_id || '—'}
          </Tag>
          <span style={{ opacity: 0.4 }}>/</span>
          <Tag style={{ marginInlineEnd: 0 }}>{r.namespace || '—'}</Tag>
        </Space>
      ),
    },
    {
      title: t('audit.resource'),
      dataIndex: 'resource',
      key: 'resource',
      width: 140,
      render: (v: string) => (v ? <Text>{v}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: t('audit.target'),
      dataIndex: 'target',
      key: 'target',
      width: 200,
      render: (v: string) =>
        v ? (
          <Text strong style={{ fontFamily: token.fontFamilyCode }}>
            {v}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('audit.sourceIp'),
      dataIndex: 'source_ip',
      key: 'source_ip',
      width: 140,
      render: (v: string) => (v ? <Text type="secondary">{v}</Text> : <Text type="secondary">—</Text>),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 18,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <Space size={8}>
              <AuditOutlined style={{ color: token.colorPrimary }} />
              {t('audit.title')}
            </Space>
          </Title>
          <Text type="secondary">{t('audit.subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={logs.reload} loading={logs.loading}>
            {t('resource.refresh')}
          </Button>
          <Button icon={<DownloadOutlined />} onClick={doExport} loading={exporting}>
            {t('audit.export')}
          </Button>
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 170 }}
            placeholder={t('audit.user')}
            value={draft.user_id || undefined}
            onChange={(v) => setDraft({ ...draft, user_id: v ?? '' })}
            options={userOptions}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 160 }}
            placeholder={t('audit.action')}
            value={draft.action}
            onChange={(v) => setDraft({ ...draft, action: v })}
            options={AUDIT_ACTIONS.map((a) => ({ value: a, label: a }))}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder={t('audit.result')}
            value={draft.result}
            onChange={(v) => setDraft({ ...draft, result: v })}
            options={AUDIT_RESULTS.map((r) => ({ value: r, label: t(`audit.results.${r}`, r) }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 180 }}
            placeholder={t('audit.resource')}
            value={draft.resource || undefined}
            onChange={(v) => setDraft({ ...draft, resource: v ?? '' })}
            options={RESOURCE_OPTIONS.map((r) => ({ value: r, label: r }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 170 }}
            placeholder={t('audit.cluster')}
            value={draft.cluster_id || undefined}
            onChange={(v) => setDraft({ ...draft, cluster_id: v ?? '' })}
            options={(clusters.data ?? []).map((c) => ({ value: c.id, label: c.name || c.id }))}
          />
          <Input
            allowClear
            style={{ width: 150 }}
            placeholder={t('audit.namespace')}
            value={draft.namespace}
            onChange={(e) => setDraft({ ...draft, namespace: e.target.value })}
          />
          <DatePicker.RangePicker
            showTime
            style={{ width: 360 }}
            value={draft.range ?? null}
            onChange={(v) => setDraft({ ...draft, range: v as [Dayjs, Dayjs] | null })}
            presets={[
              { label: t('audit.last24h'), value: [dayjs().add(-1, 'd'), dayjs()] },
              { label: t('audit.last7d'), value: [dayjs().add(-7, 'd'), dayjs()] },
            ]}
          />
          <div style={{ flex: '1 1 auto' }} />
          <Button type="primary" icon={<SearchOutlined />} onClick={applyFilters}>
            {t('audit.search')}
          </Button>
          <Button onClick={resetFilters}>{t('audit.reset')}</Button>
        </div>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<AuditLog>
          rowKey="id"
          columns={columns}
          dataSource={logs.data?.logs}
          loading={logs.loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          locale={{
            emptyText: <Empty description={t('audit.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />,
          }}
          pagination={{
            ...defaultPagination,
            current: page,
            pageSize,
            total: logs.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => t('audit.total', { total }),
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>
    </div>
  );
}
