import {
  Card,
  Empty,
  Result,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Button,
  theme as antdTheme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  RocketOutlined,
  ArrowRightOutlined,
  ReloadOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { releaseApi, parseImageList, type ReleaseRecord } from '../../api/release';
import { useApi } from '../../hooks/useApi';
import { useCtxStore } from '../../store/ctx';
import { defaultTableProps, defaultPagination, tableScrollX } from '../../components/tableConfig';
import { formatAge, formatTime } from '../../utils';

const { Title, Text } = Typography;

/** Render a "name=image;..." string as a stack of image tags (container name muted). */
function ImageTags({ value, color }: { value: string; color: string }) {
  const items = parseImageList(value);
  if (items.length === 0) return <Text type="secondary">—</Text>;
  return (
    <Space direction="vertical" size={2} style={{ display: 'flex' }}>
      {items.map((it, i) => (
        <Tag
          key={i}
          color={color}
          style={{ marginInlineEnd: 0, fontFamily: 'var(--ok-code-font, monospace)', maxWidth: 260 }}
        >
          {it.name && <span style={{ opacity: 0.6 }}>{it.name}: </span>}
          {it.image}
        </Tag>
      ))}
    </Space>
  );
}

export default function Releases() {
  const { t } = useTranslation();
  const { token } = antdTheme.useToken();
  const { currentCluster, currentNamespace } = useCtxStore();

  const releases = useApi<ReleaseRecord[]>(
    () =>
      releaseApi.list({
        cluster_id: currentCluster ?? undefined,
        namespace: currentNamespace ?? undefined,
      }),
    [currentCluster, currentNamespace],
    { initial: [], skip: !currentCluster },
  );

  if (!currentCluster) {
    return (
      <Card>
        <Result
          icon={<ApiOutlined style={{ color: token.colorTextQuaternary }} />}
          title={t('release.noCluster')}
          subTitle={t('release.noClusterDesc')}
        />
      </Card>
    );
  }

  const columns: ColumnsType<ReleaseRecord> = [
    {
      title: t('release.time'),
      dataIndex: 'created_at',
      key: 'time',
      width: 170,
      fixed: 'left',
      render: (ts: string) => (
        <Tooltip title={formatTime(ts)}>
          <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatAge(ts)}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('release.releaser'),
      dataIndex: 'username',
      key: 'releaser',
      width: 150,
      render: (v: string) => (v ? <Tag color="cyan">{v}</Tag> : <Text type="secondary">—</Text>),
    },
    {
      title: t('release.location'),
      key: 'location',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {r.cluster_id}
          </Tag>
          <span style={{ opacity: 0.4 }}>/</span>
          <Tag style={{ marginInlineEnd: 0 }}>{r.namespace || '—'}</Tag>
        </Space>
      ),
    },
    {
      title: t('release.target'),
      key: 'target',
      width: 240,
      render: (_, r) => (
        <Space size={6} wrap={false} style={{ whiteSpace: 'nowrap' }}>
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            {r.kind}
          </Tag>
          <Text strong style={{ fontFamily: token.fontFamilyCode }}>
            {r.name}
          </Text>
        </Space>
      ),
    },
    {
      title: t('release.imageDiff'),
      key: 'images',
      width: 560,
      render: (_, r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ImageTags value={r.image_before} color="default" />
          <ArrowRightOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
          <ImageTags value={r.image_after} color="green" />
        </div>
      ),
    },
    {
      title: t('release.comment'),
      dataIndex: 'comment',
      key: 'comment',
      width: 280,
      render: (v: string) =>
        v ? (
          <Tooltip title={v}>
            <Text style={{ whiteSpace: 'normal' }}>{v}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">—</Text>
        ),
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
              <RocketOutlined style={{ color: token.colorPrimary }} />
              {t('release.title')}
            </Space>
          </Title>
          <Text type="secondary">
            {t('release.subtitle')}
            {'  ·  '}
            <Tag color="geekblue">{currentCluster}</Tag>
            <Tag color={currentNamespace ? 'cyan' : 'default'}>
              {currentNamespace || t('release.allNamespaces')}
            </Tag>
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={releases.reload} loading={releases.loading}>
          {t('resource.refresh')}
        </Button>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<ReleaseRecord>
          rowKey="id"
          columns={columns}
          dataSource={releases.data}
          loading={releases.loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          locale={{
            emptyText: <Empty description={t('release.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />,
          }}
          pagination={defaultPagination}
        />
      </Card>
    </div>
  );
}
