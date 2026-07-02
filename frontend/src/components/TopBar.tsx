import { useEffect } from 'react';
import {
  Avatar,
  Button,
  Dropdown,
  Select,
  Space,
  Tooltip,
  Typography,
  theme as antdTheme,
} from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  LogoutOutlined,
  KeyOutlined,
  BulbOutlined,
  ClusterOutlined,
  PartitionOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';
import { useCtxStore } from '../store/ctx';
import { useUiStore } from '../store/ui';
import { useClusterStore } from '../store/clusters';
import { resourceApi } from '../api/resource';
import { useApi } from '../hooks/useApi';
import { LANG_OPTIONS, setLanguage, type Lang } from '../i18n';

const { Text } = Typography;

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export default function TopBar({ collapsed, onToggle }: Props) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { token: themeToken } = antdTheme.useToken();
  const { user, logout } = useAuthStore();
  const { currentCluster, currentNamespace, setCluster, setNamespace } = useCtxStore();
  const toggleMode = useUiStore((s) => s.toggleMode);
  const mode = useUiStore((s) => s.mode);

  const { clusters, loading: clustersLoading, load: loadClusters } = useClusterStore();
  const namespaces = useApi<string[]>(
    () => (currentCluster ? resourceApi.namespaces() : Promise.resolve([])),
    [currentCluster],
    { initial: [], skip: !currentCluster },
  );

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);

  // Auto-select the first cluster when none is chosen.
  useEffect(() => {
    if (!currentCluster && clusters.length > 0) {
      setCluster(clusters[0].id);
    }
  }, [clusters, currentCluster, setCluster]);

  const onLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div
      style={{
        height: 60,
        minHeight: 60,
        flex: '0 0 60px', // 锁死高度，flex 列里不被压缩(避免顶栏变矮)
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 18px',
        borderBottom: `1px solid ${themeToken.colorBorderSecondary}`,
        // 实色 elevated 背景, 去掉 backdrop-filter: 半透明+模糊会建合成层,
        // 底下内容剧烈变化(仪表盘骨架屏切换)时整条重绘 => 闪烁。
        background: themeToken.colorBgElevated,
        zIndex: 20,
      }}
    >
      <Space size={14}>
        <Button
          type="text"
          aria-label={t('topbar.toggleSidebar')}
          icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={onToggle}
        />
        <Space size={8}>
          <ClusterOutlined style={{ color: themeToken.colorTextTertiary }} />
          <Select
            aria-label={t('topbar.cluster')}
            value={currentCluster ?? undefined}
            placeholder={t('topbar.selectCluster')}
            style={{ width: 200 }}
            loading={clustersLoading}
            onChange={(v) => setCluster(v)}
            options={clusters.map((c) => ({
              value: c.id,
              label: c.name || c.id,
            }))}
          />
        </Space>
        <Space size={8}>
          <PartitionOutlined style={{ color: themeToken.colorTextTertiary }} />
          <Select
            aria-label={t('topbar.namespace')}
            value={currentNamespace ?? undefined}
            placeholder={t('topbar.allNamespaces')}
            style={{ width: 200 }}
            allowClear
            showSearch
            loading={namespaces.loading}
            disabled={!currentCluster}
            onChange={(v) => setNamespace(v ?? null)}
            options={(namespaces.data || []).map((n) => ({ value: n, label: n }))}
          />
        </Space>
      </Space>

      <Space size={6}>
        <Dropdown
          trigger={['click']}
          menu={{
            selectable: true,
            selectedKeys: [i18n.language],
            items: LANG_OPTIONS.map((o) => ({ key: o.value, label: o.label })),
            onClick: ({ key }) => setLanguage(key as Lang),
          }}
        >
          <Button type="text" aria-label={t('topbar.language')} style={{ paddingInline: 8 }}>
            <Space size={6}>
              <TranslationOutlined />
              {LANG_OPTIONS.find((o) => o.value === i18n.language)?.label}
            </Space>
          </Button>
        </Dropdown>
        <Tooltip title={mode === 'dark' ? t('topbar.lightMode') : t('topbar.darkMode')}>
          <Button
            type="text"
            aria-label={t('topbar.toggleTheme')}
            icon={<BulbOutlined />}
            onClick={toggleMode}
          />
        </Tooltip>
        <Dropdown
          menu={{
            items: [
              {
                key: 'who',
                label: (
                  <div style={{ padding: '2px 0' }}>
                    <Text strong>{user?.username}</Text>
                    <div style={{ fontSize: 12, color: themeToken.colorTextTertiary }}>
                      {user?.is_admin ? t('topbar.administrator') : t('topbar.member')}
                    </div>
                  </div>
                ),
                disabled: true,
              },
              { type: 'divider' },
              {
                key: 'change-password',
                icon: <KeyOutlined />,
                label: t('topbar.changePassword'),
                onClick: () => navigate('/change-password'),
              },
              {
                key: 'logout',
                icon: <LogoutOutlined />,
                label: t('topbar.signOut'),
                danger: true,
                onClick: onLogout,
              },
            ],
          }}
          trigger={['click']}
        >
          <Button type="text" style={{ height: 40, paddingInline: 8 }}>
            <Space size={8}>
              <Avatar size={28} style={{ background: '#0EA5E9' }} icon={<UserOutlined />} />
              <Text style={{ maxWidth: 120 }} ellipsis>
                {user?.username}
              </Text>
            </Space>
          </Button>
        </Dropdown>
      </Space>
    </div>
  );
}
