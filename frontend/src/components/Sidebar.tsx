import { useMemo, type ReactNode } from 'react';
import { Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DashboardOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ClusterOutlined,
  TeamOutlined,
  SafetyOutlined,
  ApartmentOutlined,
  DeploymentUnitOutlined,
  ContainerOutlined,
  ScheduleOutlined,
  ClockCircleOutlined,
  GlobalOutlined,
  ShareAltOutlined,
  FileTextOutlined,
  LockOutlined,
  HddOutlined,
  NodeIndexOutlined,
  RocketOutlined,
  SettingOutlined,
  AuditOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../store/auth';
import { canSeeResource, canSeeModule, canGlobal, canSeeSystem } from '../nav';
import BrandMark from './BrandMark';

const { Sider } = Layout;

interface Props {
  collapsed: boolean;
}

export default function Sidebar({ collapsed }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const items: MenuProps['items'] = useMemo(() => {
    const base: NonNullable<MenuProps['items']> = [];

    // Dashboard is fixed — always visible, not gated by nav/global.
    base.push({ key: '/dashboard', icon: <DashboardOutlined />, label: t('nav.dashboard') });

    // A resource module: shown when any of its resource submenus is visible;
    // only the visible submenus are rendered as children.
    const moduleItem = (
      module: 'workloads' | 'networking' | 'storage',
      icon: ReactNode,
      label: string,
      children: { resource: string; key: string; icon: ReactNode; label: string }[],
    ): void => {
      if (!canSeeModule(module, user)) return;
      base.push({
        key: module,
        icon,
        label,
        children: children
          .filter((c) => canSeeResource(c.resource, user))
          .map((c) => ({ key: c.key, icon: c.icon, label: c.label })),
      });
    };

    moduleItem('workloads', <AppstoreOutlined />, t('nav.workloads'), [
      { resource: 'deployments', key: '/workloads/deployments', icon: <DeploymentUnitOutlined />, label: t('nav.deployments') },
      { resource: 'statefulsets', key: '/workloads/statefulsets', icon: <ApartmentOutlined />, label: t('nav.statefulsets') },
      { resource: 'daemonsets', key: '/workloads/daemonsets', icon: <CloudServerOutlined />, label: t('nav.daemonsets') },
      { resource: 'pods', key: '/workloads/pods', icon: <ContainerOutlined />, label: t('nav.pods') },
      { resource: 'jobs', key: '/workloads/jobs', icon: <ScheduleOutlined />, label: t('nav.jobs') },
      { resource: 'cronjobs', key: '/workloads/cronjobs', icon: <ClockCircleOutlined />, label: t('nav.cronjobs') },
    ]);

    moduleItem('networking', <GlobalOutlined />, t('nav.networking'), [
      { resource: 'services', key: '/networking/services', icon: <ShareAltOutlined />, label: t('nav.services') },
      { resource: 'ingresses', key: '/networking/ingresses', icon: <GlobalOutlined />, label: t('nav.ingresses') },
    ]);

    moduleItem('storage', <DatabaseOutlined />, t('nav.storage'), [
      { resource: 'configmaps', key: '/storage/configmaps', icon: <FileTextOutlined />, label: t('nav.configmaps') },
      { resource: 'secrets', key: '/storage/secrets', icon: <LockOutlined />, label: t('nav.secrets') },
      { resource: 'persistentvolumeclaims', key: '/storage/pvcs', icon: <HddOutlined />, label: t('nav.pvcs') },
      { resource: 'persistentvolumes', key: '/storage/persistentvolumes', icon: <DatabaseOutlined />, label: t('nav.persistentvolumes') },
    ]);

    // Nodes is a standalone top-level item (its own "nodes" module).
    if (canSeeResource('nodes', user)) {
      base.push({ key: '/cluster/nodes', icon: <NodeIndexOutlined />, label: t('nav.nodes') });
    }

    // 集成部署: gated by integrated_deploy:view。
    if (canGlobal('integrated_deploy', 'view', user)) {
      base.push({ key: '/integrated-deploy', icon: <DeploymentUnitOutlined />, label: t('nav.integrated_deploy') });
    }

    // 发布记录: gated by the releases global perm (view).
    if (canGlobal('releases', 'view', user)) {
      base.push({ key: '/releases', icon: <RocketOutlined />, label: t('nav.releases') });
    }

    // 系统管理: parent shown when any of clusters/users/roles is viewable;
    // each child gated by its own global view perm.
    if (canSeeSystem(user)) {
      const sysChildren: MenuProps['items'] = [];
      if (canGlobal('clusters', 'view', user)) {
        sysChildren.push({ key: '/clusters', icon: <ClusterOutlined />, label: t('nav.clusters') });
      }
      if (canGlobal('users', 'view', user)) {
        sysChildren.push({ key: '/users', icon: <TeamOutlined />, label: t('nav.users') });
      }
      if (canGlobal('roles', 'view', user)) {
        sysChildren.push({ key: '/roles', icon: <SafetyOutlined />, label: t('nav.roles') });
      }
      if (canGlobal('ai', 'view', user)) {
        sysChildren.push({ key: '/ai/config', icon: <RobotOutlined />, label: t('nav.aiConfig') });
      }
      if (canGlobal('audit', 'view', user)) {
        sysChildren.push({ key: '/audit', icon: <AuditOutlined />, label: t('nav.audit') });
      }
      base.push({
        key: 'system',
        icon: <SettingOutlined />,
        label: t('nav.systemSettings'),
        children: sysChildren,
      });
    }
    return base;
  }, [user, t]);

  const openKeys = useMemo(() => {
    const seg = location.pathname.split('/')[1];
    if (['workloads', 'networking', 'storage'].includes(seg)) return [seg];
    if (['clusters', 'users', 'roles', 'ai', 'audit'].includes(seg)) return ['system'];
    return [];
  }, [location.pathname]);

  return (
    <Sider
      theme="dark"
      collapsible
      collapsed={collapsed}
      trigger={null}
      width={236}
      collapsedWidth={72}
      style={{ borderRight: '1px solid rgba(38,48,74,0.55)' }}
    >
      <div
        style={{
          height: 60,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: collapsed ? '0 20px' : '0 22px',
          color: '#fff',
          fontWeight: 700,
          fontSize: 17,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        <span className="ok-brand-mark" style={{ width: 30, height: 30 }}>
          <BrandMark />
        </span>
        {!collapsed && <span>OmniKube</span>}
      </div>
      <div style={{ height: 'calc(100vh - 60px)', overflowY: 'auto', overflowX: 'hidden' }}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          defaultOpenKeys={openKeys}
          items={items}
          onClick={({ key }) => key.startsWith('/') && navigate(key)}
          style={{ background: 'transparent', borderInlineEnd: 'none', padding: '8px 10px' }}
        />
      </div>
    </Sider>
  );
}
