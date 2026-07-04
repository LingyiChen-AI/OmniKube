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
  ThunderboltFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { releaseApi, parseImageList, splitImageTag, type ReleaseRecord } from '../../api/release';
import { useApi } from '../../hooks/useApi';
import { useCtxStore } from '../../store/ctx';
import { defaultTableProps, defaultPagination, tableScrollX } from '../../components/tableConfig';
import { formatAge, formatTime } from '../../utils';

const { Title, Text } = Typography;

/**
 * Per-container image change. Since the repo almost never changes across a
 * release (only the tag does), show the repo once (muted, in a tooltip) and
 * put the emphasis on `oldTag → newTag`. When the repo *does* change, fall back
 * to the two full refs so nothing is hidden.
 */
function ImageDiff({ before, after }: { before: string; after: string }) {
  const { token } = antdTheme.useToken();
  const mono = { fontFamily: token.fontFamilyCode } as const;

  const beforeItems = parseImageList(before);
  const afterItems = parseImageList(after);
  const names = Array.from(
    new Set([...beforeItems, ...afterItems].map((i) => i.name)),
  );
  const byName = (list: { name: string; image: string }[], n: string) =>
    list.find((i) => i.name === n)?.image ?? '';

  if (names.length === 0) return <Text type="secondary">—</Text>;

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      {names.map((n) => {
        const b = splitImageTag(byName(beforeItems, n));
        const a = splitImageTag(byName(afterItems, n));
        const sameRepo = b.repo === a.repo && !!a.repo;

        return (
          <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            {n && (
              <Text style={{ ...mono, fontSize: 12, color: token.colorTextSecondary }}>{n}</Text>
            )}
            {sameRepo ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tooltip title={a.repo}>
                  <Text
                    type="secondary"
                    ellipsis
                    style={{ ...mono, fontSize: 11.5, maxWidth: 150 }}
                  >
                    {a.repo.split('/').pop()}
                  </Text>
                </Tooltip>
                <Tag style={{ margin: 0, ...mono }}>{b.tag || '—'}</Tag>
                <ArrowRightOutlined style={{ color: token.colorPrimary, fontSize: 11 }} />
                <Tag color="green" style={{ margin: 0, ...mono }}>
                  {a.tag || '—'}
                </Tag>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tooltip title={byName(beforeItems, n)}>
                  <Tag style={{ margin: 0, ...mono, maxWidth: 220 }}>
                    {byName(beforeItems, n) || '—'}
                  </Tag>
                </Tooltip>
                <ArrowRightOutlined style={{ color: token.colorPrimary, fontSize: 11 }} />
                <Tooltip title={byName(afterItems, n)}>
                  <Tag color="green" style={{ margin: 0, ...mono, maxWidth: 220 }}>
                    {byName(afterItems, n) || '—'}
                  </Tag>
                </Tooltip>
              </div>
            )}
          </div>
        );
      })}
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
      width: 170,
      render: (v: string, r) => {
        // Tag AI-initiated releases (dedicated via_ai column) so the manual vs.
        // assistant distinction is obvious. Also tag integrated-deploy releases
        // (dedicated source column) so they're visually distinct from single-
        // resource releases.
        const viaAI = r.via_ai;
        const viaIntegratedDeploy = r.source === 'integrated_deploy';
        return (
          <Space size={4} wrap>
            {v ? <Tag color="cyan">{v}</Tag> : <Text type="secondary">—</Text>}
            {viaAI && (
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                <ThunderboltFilled style={{ marginInlineEnd: 3 }} />
                AI
              </Tag>
            )}
            {viaIntegratedDeploy && (
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                {t('nav.integrated_deploy')}
              </Tag>
            )}
          </Space>
        );
      },
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
      width: 420,
      render: (_, r) => <ImageDiff before={r.image_before} after={r.image_after} />,
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
