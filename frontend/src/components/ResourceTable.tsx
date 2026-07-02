import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Result,
  Space,
  Table,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  EyeOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  ApiOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useCtxStore } from '../store/ctx';
import { resourceApi, type K8sObject } from '../api/resource';
import { useCapabilities } from '../store/caps';
import { useTranslation } from 'react-i18next';
import { useApi } from '../hooks/useApi';
import { formatAge } from '../utils';
import EditResourceDrawer from './EditResourceDrawer';
import { kindFromResource } from './editor/forms';
import { defaultTableProps, defaultPagination, colW, tableScrollX } from './tableConfig';

const { Title, Text } = Typography;

/** Workload resources whose replica counts settle asynchronously after an op. */
const WORKLOAD_RESOURCES = new Set(['deployments', 'statefulsets', 'daemonsets']);

/** True while a workload row hasn't reached its desired ready count (rollout in flight). */
function workloadNotReady(resource: string, r: K8sObject): boolean {
  const st = r.status || {};
  const sp = r.spec || {};
  if (resource === 'daemonsets') {
    return (st.numberReady ?? 0) !== (st.desiredNumberScheduled ?? 0);
  }
  const desired = sp.replicas ?? st.replicas ?? 0;
  return (st.readyReplicas ?? 0) !== desired;
}

export interface ResourceTableProps {
  title: string;
  /** k8s plural, e.g. "deployments" — also drives per-resource capability gating. */
  resource: string;
  /** Whether this resource is namespaced (shows NS column + needs ns for ops). */
  namespaced?: boolean;
  /** Columns inserted between Name and Age. */
  extraColumns?: ColumnsType<K8sObject>;
  /** Extra per-row actions (rendered before view/edit/delete). `reload` refreshes the list. */
  rowActions?: (rec: K8sObject, reload: () => void) => ReactNode;
  /**
   * When provided, the name cell renders as a router link to the returned
   * path (e.g. a resource detail page). When omitted the name stays plain
   * strong text. Kept generic so any detail page can opt in.
   */
  nameLink?: (rec: K8sObject) => string;
  /** Allow YAML editing (PUT). Defaults to true. */
  editable?: boolean;
  description?: string;
}

export default function ResourceTable({
  title,
  resource,
  namespaced = true,
  extraColumns = [],
  rowActions,
  editable = true,
  description,
  nameLink,
}: ResourceTableProps) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { currentCluster, currentNamespace } = useCtxStore();
  const { can } = useCapabilities();
  // Gated by the user's per-resource capabilities (view is always allowed).
  const canWrite = can(resource, 'edit');
  const canDelete = can(resource, 'delete');
  const canCreate = can(resource, 'create');
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<{ rec: K8sObject; mode: 'view' | 'edit' } | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useApi<K8sObject[]>(
    () =>
      currentCluster
        ? resourceApi.list(resource, currentNamespace ?? undefined)
        : Promise.resolve([]),
    [currentCluster, currentNamespace, resource],
    { initial: [], skip: !currentCluster },
  );

  // Auto-refresh workload lists so ready counts update on their own after a
  // scale/restart/rollback/release. Fast while any row is still rolling out,
  // slow keepalive once everything is settled. Other resources don't poll.
  const isWorkload = WORKLOAD_RESOURCES.has(resource);
  const settling = isWorkload && (list.data || []).some((r) => workloadNotReady(resource, r));
  const { reloadSilent } = list;
  useEffect(() => {
    if (!currentCluster || !isWorkload) return;
    const ms = settling ? 3500 : 15000;
    const id = window.setInterval(() => reloadSilent(), ms);
    return () => window.clearInterval(id);
  }, [currentCluster, isWorkload, settling, resource, currentNamespace, reloadSilent]);

  const data = useMemo(() => {
    const items = list.data || [];
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (it) =>
        it.metadata?.name?.toLowerCase().includes(q) ||
        it.metadata?.namespace?.toLowerCase().includes(q),
    );
  }, [list.data, query]);

  const onDelete = async (rec: K8sObject) => {
    const ns = rec.metadata?.namespace || currentNamespace || 'default';
    const name = rec.metadata?.name || '';
    try {
      await resourceApi.remove(ns, resource, name);
      message.success(t('resource.deleted', { name }));
      list.reload();
    } catch {
      /* interceptor toast */
    }
  };

  const columns: ColumnsType<K8sObject> = [
    {
      title: t('resource.name'),
      dataIndex: ['metadata', 'name'],
      key: 'name',
      width: colW.name,
      fixed: 'left',
      ellipsis: true,
      render: (v: string, rec) =>
        nameLink ? (
          <Link className="ok-name-link" to={nameLink(rec)} title={v}>
            <Text
              ellipsis={{ tooltip: v }}
              style={{ maxWidth: '100%', color: 'inherit' }}
            >
              {v}
            </Text>
          </Link>
        ) : (
          <Text strong ellipsis={{ tooltip: v }} style={{ maxWidth: '100%' }}>
            {v}
          </Text>
        ),
      sorter: (a, b) =>
        (a.metadata?.name || '').localeCompare(b.metadata?.name || ''),
    },
    ...(namespaced
      ? ([
          {
            title: t('resource.namespace'),
            dataIndex: ['metadata', 'namespace'],
            key: 'namespace',
            width: colW.namespace,
            ellipsis: true,
            render: (v: string) => <Text type="secondary">{v || '—'}</Text>,
          },
        ] as ColumnsType<K8sObject>)
      : []),
    ...extraColumns,
    {
      title: t('resource.age'),
      key: 'age',
      width: colW.age,
      render: (_, rec) => formatAge(rec.metadata?.creationTimestamp),
      sorter: (a, b) =>
        new Date(a.metadata?.creationTimestamp || 0).getTime() -
        new Date(b.metadata?.creationTimestamp || 0).getTime(),
    },
    {
      title: t('resource.actions'),
      key: 'actions',
      align: 'right',
      width: colW.actions,
      fixed: 'right',
      render: (_, rec) => (
        <Space size={2}>
          {rowActions?.(rec, list.reload)}
          <Tooltip title={t('resource.view')}>
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => setDrawer({ rec, mode: 'view' })}
            />
          </Tooltip>
          {editable && canWrite && (
            <Tooltip title={t('resource.edit')}>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => setDrawer({ rec, mode: 'edit' })}
              />
            </Tooltip>
          )}
          {canDelete && (
            <Popconfirm
              title={t('resource.deleteResource')}
              description={t('resource.deleteConfirm', { name: rec.metadata?.name })}
              okText={t('resource.delete')}
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(rec)}
            >
              <Tooltip title={t('resource.delete')}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  if (!currentCluster) {
    return (
      <Card>
        <Result
          icon={<ApiOutlined style={{ color: '#6B7793' }} />}
          title={t('resource.noCluster')}
          subTitle={t('resource.noClusterDesc')}
        />
      </Card>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 18,
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            {title}
          </Title>
          {description && <Text type="secondary">{description}</Text>}
        </div>
        <Space>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('resource.filterByName')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={list.reload} loading={list.loading}>
            {t('resource.refresh')}
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              {t('resource.create')}
            </Button>
          )}
        </Space>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<K8sObject>
          rowKey={(r) => `${r.metadata?.namespace || ''}/${r.metadata?.name}`}
          columns={columns}
          dataSource={data}
          loading={list.loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          pagination={defaultPagination}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  currentNamespace
                    ? // `ns` is a reserved i18next option (namespace); use `namespace`.
                      t('resource.emptyInNs', { resource, namespace: currentNamespace })
                    : t('resource.emptyAll', { resource })
                }
              />
            ),
          }}
        />
      </Card>

      {drawer && (
        <EditResourceDrawer
          open
          resource={resource}
          kind={kindFromResource(resource)}
          namespace={drawer.rec.metadata?.namespace || currentNamespace || 'default'}
          name={drawer.rec.metadata?.name || ''}
          readOnly={drawer.mode === 'view'}
          onClose={() => setDrawer(null)}
          onSaved={list.reload}
        />
      )}

      {creating && (
        <EditResourceDrawer
          open
          creating
          resource={resource}
          kind={kindFromResource(resource)}
          namespace={currentNamespace || 'default'}
          name=""
          onClose={() => setCreating(false)}
          onSaved={list.reload}
        />
      )}
    </div>
  );
}
