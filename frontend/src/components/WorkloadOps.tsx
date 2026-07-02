import { useMemo, useState } from 'react';
import {
  Button,
  Drawer,
  Empty,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ColumnHeightOutlined,
  RedoOutlined,
  HistoryOutlined,
  RollbackOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  resourceApi,
  type K8sObject,
  type Revision,
  type K8sEvent,
} from '../api/resource';
import { useCapabilities } from '../store/caps';
import { useApi } from '../hooks/useApi';
import { formatAge, formatTime } from '../utils';
import { defaultPagination } from './tableConfig';

const { Text } = Typography;

const SCALABLE = new Set(['deployments', 'statefulsets']);
const RESTARTABLE = new Set(['deployments', 'statefulsets', 'daemonsets']);
const VERSIONED = new Set(['deployments', 'statefulsets', 'daemonsets']);

interface Props {
  resource: string;
  rec: K8sObject;
  /** Refresh the parent list after a mutating op. */
  onChanged: () => void;
}

/**
 * Per-row workload operations: scale, rolling restart, and a history drawer
 * (revision list with rollback + a k8s events tab). Write ops gated by `edit`.
 */
export default function WorkloadOps({ resource, rec, onChanged }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { can } = useCapabilities();
  const canEdit = can(resource, 'edit');

  const ns = rec.metadata?.namespace || 'default';
  const name = rec.metadata?.name || '';

  const [scaleOpen, setScaleOpen] = useState(false);
  const [replicas, setReplicas] = useState<number>(rec.spec?.replicas ?? 1);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const doScale = async () => {
    setBusy(true);
    try {
      await resourceApi.scale(ns, resource, name, replicas);
      message.success(t('ops.scaled', { name, n: replicas }));
      setScaleOpen(false);
      onChanged();
    } catch {
      /* interceptor toast */
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async () => {
    try {
      await resourceApi.restart(ns, resource, name);
      message.success(t('ops.restarted', { name }));
      onChanged();
    } catch {
      /* interceptor toast */
    }
  };

  return (
    <>
      {canEdit && SCALABLE.has(resource) && (
        <Tooltip title={t('ops.scale')}>
          <Button
            type="text"
            size="small"
            icon={<ColumnHeightOutlined />}
            onClick={() => {
              setReplicas(rec.spec?.replicas ?? 1);
              setScaleOpen(true);
            }}
          />
        </Tooltip>
      )}
      {canEdit && RESTARTABLE.has(resource) && (
        <Popconfirm
          title={t('ops.restart')}
          description={t('ops.restartConfirm', { name })}
          okText={t('ops.restart')}
          onConfirm={doRestart}
        >
          <Tooltip title={t('ops.restart')}>
            <Button type="text" size="small" icon={<RedoOutlined />} />
          </Tooltip>
        </Popconfirm>
      )}
      {VERSIONED.has(resource) && (
        <Tooltip title={t('ops.history')}>
          <Button
            type="text"
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => setHistoryOpen(true)}
          />
        </Tooltip>
      )}

      <Modal
        open={scaleOpen}
        title={t('ops.scaleTitle', { name })}
        onCancel={() => setScaleOpen(false)}
        onOk={doScale}
        confirmLoading={busy}
        okText={t('ops.scale')}
        destroyOnClose
      >
        <Space>
          <Text>{t('ops.replicas')}</Text>
          <InputNumber min={0} max={1000} value={replicas} onChange={(v) => setReplicas(v ?? 0)} />
        </Space>
      </Modal>

      {historyOpen && (
        <HistoryDrawer
          resource={resource}
          ns={ns}
          name={name}
          canEdit={canEdit}
          onClose={() => setHistoryOpen(false)}
          onRolledBack={onChanged}
        />
      )}
    </>
  );
}

function HistoryDrawer({
  resource,
  ns,
  name,
  canEdit,
  onClose,
  onRolledBack,
}: {
  resource: string;
  ns: string;
  name: string;
  canEdit: boolean;
  onClose: () => void;
  onRolledBack: () => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();

  const revs = useApi<Revision[]>(() => resourceApi.revisions(ns, resource, name), [ns, resource, name], {
    initial: [],
  });
  const events = useApi<K8sEvent[]>(() => resourceApi.events(ns, resource, name), [ns, resource, name], {
    initial: [],
  });

  // Only the version immediately before the current one is rollback-able
  // (roll back one step); older entries are shown for history only.
  const previousRev = useMemo(() => {
    const list = revs.data ?? [];
    const cur = list.find((r) => r.current);
    if (!cur) return undefined;
    const below = list.filter((r) => r.revision < cur.revision).map((r) => r.revision);
    return below.length ? Math.max(...below) : undefined;
  }, [revs.data]);

  const doRollback = async (revision: number) => {
    try {
      await resourceApi.rollback(ns, resource, name, revision);
      message.success(t('ops.rolledBack', { revision }));
      revs.reload();
      onRolledBack();
    } catch {
      /* interceptor toast */
    }
  };

  const revColumns: ColumnsType<Revision> = [
    {
      title: t('ops.revision'),
      dataIndex: 'revision',
      key: 'revision',
      width: 100,
      render: (v: number, r) => (
        <Space size={6}>
          <Text strong>#{v}</Text>
          {r.current && <Tag color="green">{t('ops.current')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('ops.image'),
      dataIndex: 'images',
      key: 'images',
      render: (v: string) => <Text style={{ fontFamily: 'monospace' }}>{v || '—'}</Text>,
    },
    {
      title: t('ops.changer'),
      dataIndex: 'changer',
      key: 'changer',
      width: 120,
      render: (v: string) =>
        v ? (
          <Tag icon={<UserOutlined />} color="cyan">
            {v}
          </Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('ops.created'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 120,
      render: (v: string) => <Tooltip title={formatTime(v)}>{formatAge(v)}</Tooltip>,
    },
    {
      title: '',
      key: 'action',
      width: 120,
      align: 'right',
      render: (_, r) =>
        canEdit && r.revision === previousRev ? (
          <Popconfirm
            title={t('ops.rollback')}
            description={t('ops.rollbackConfirm', { revision: r.revision })}
            okText={t('ops.rollback')}
            onConfirm={() => doRollback(r.revision)}
          >
            <Button type="link" size="small" icon={<RollbackOutlined />}>
              {t('ops.rollback')}
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const evColumns: ColumnsType<K8sEvent> = [
    {
      title: t('ops.evType'),
      dataIndex: 'type',
      key: 'type',
      width: 90,
      render: (v: string) => <Tag color={v === 'Warning' ? 'orange' : 'blue'}>{v}</Tag>,
    },
    { title: t('ops.evReason'), dataIndex: 'reason', key: 'reason', width: 150 },
    { title: t('ops.evMessage'), dataIndex: 'message', key: 'message' },
    {
      title: t('ops.evCount'),
      dataIndex: 'count',
      key: 'count',
      width: 70,
      align: 'center',
    },
  ];

  return (
    <Drawer open width={780} title={`${name} · ${t('ops.history')}`} onClose={onClose}>
      <Tabs
        items={[
          {
            key: 'revisions',
            label: t('ops.revisions'),
            children: (
              <Table<Revision>
                rowKey="revision"
                size="small"
                columns={revColumns}
                dataSource={revs.data}
                loading={revs.loading}
                pagination={{ ...defaultPagination, size: 'small' }}
                locale={{ emptyText: <Empty description={t('ops.noRevisions')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            ),
          },
          {
            key: 'events',
            label: t('ops.events'),
            children: (
              <Table<K8sEvent>
                rowKey={(e, i) => `${e.reason}-${i}`}
                size="small"
                columns={evColumns}
                dataSource={events.data}
                loading={events.loading}
                pagination={{ ...defaultPagination, size: 'small' }}
                locale={{ emptyText: <Empty description={t('ops.noEvents')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
}
