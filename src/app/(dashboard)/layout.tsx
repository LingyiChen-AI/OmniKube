'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ConfigProvider, Dropdown, Avatar, App } from 'antd';

const ProLayout = dynamic(() => import('@ant-design/pro-layout').then(m => m.ProLayout), { ssr: false });
import {
  DashboardOutlined, ClusterOutlined, CloudServerOutlined,
  SettingOutlined, FileTextOutlined,
  UserOutlined, SafetyOutlined, AuditOutlined,
  AppstoreOutlined, RocketOutlined, DatabaseOutlined,
  GlobalOutlined, LogoutOutlined,
} from '@ant-design/icons';
import { useRouter, usePathname } from 'next/navigation';
import zhCN from 'antd/locale/zh_CN';
import ClusterSelector from '@/components/cluster-selector';
import Logo from '@/components/logo';
import { useRequest } from 'ahooks';

const menuData = [
  { path: '/', name: 'Dashboard', icon: <DashboardOutlined /> },
  {
    name: '集群资源',
    icon: <CloudServerOutlined />,
    children: [
      { path: '/resources/namespaces', name: 'Namespaces', icon: <AppstoreOutlined /> },
      {
        name: 'Workloads',
        icon: <RocketOutlined />,
        children: [
          { path: '/resources/workloads/deployments', name: 'Deployments' },
          { path: '/resources/workloads/statefulsets', name: 'StatefulSets' },
          { path: '/resources/workloads/daemonsets', name: 'DaemonSets' },
          { path: '/resources/workloads/jobs', name: 'Jobs / CronJobs' },
          { path: '/resources/workloads/pods', name: 'Pods' },
        ],
      },
      {
        name: 'Networking',
        icon: <GlobalOutlined />,
        children: [
          { path: '/resources/networking/services', name: 'Services' },
          { path: '/resources/networking/ingresses', name: 'Ingresses' },
        ],
      },
      {
        name: 'Config',
        icon: <SettingOutlined />,
        children: [
          { path: '/resources/config/configmaps', name: 'ConfigMaps' },
          { path: '/resources/config/secrets', name: 'Secrets' },
        ],
      },
      {
        name: 'Storage',
        icon: <DatabaseOutlined />,
        children: [
          { path: '/resources/storage/pvcs', name: 'PV / PVC' },
          { path: '/resources/storage/storageclasses', name: 'StorageClasses' },
        ],
      },
    ],
  },
  { path: '/apps/releases', name: '发布记录', icon: <FileTextOutlined /> },
  {
    name: '系统管理',
    icon: <SettingOutlined />,
    children: [
      { path: '/admin/users', name: '用户管理', icon: <UserOutlined /> },
      { path: '/admin/roles', name: '角色管理', icon: <SafetyOutlined /> },
      { path: '/clusters', name: '集群管理', icon: <ClusterOutlined /> },
      { path: '/admin/audit', name: '审计日志', icon: <AuditOutlined /> },
    ],
  },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const { data: user } = useRequest(async () => {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    return res.json();
  });

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#326CE5',
          borderRadius: 6,
        },
      }}
    >
      <App>
      <ProLayout
        title="K8s Admin"
        logo={<Logo size={28} showText={false} />}
        layout="mix"
        navTheme="light"
        fixSiderbar
        fixedHeader
        collapsed={collapsed}
        onCollapse={setCollapsed}
        location={{ pathname }}
        route={{ routes: menuData }}
        token={{
          header: {
            colorBgHeader: '#fff',
            colorHeaderTitle: '#1a1a1a',
            colorTextMenu: '#595959',
            colorTextMenuActive: '#326CE5',
            colorTextMenuSelected: '#326CE5',
            colorBgMenuItemSelected: 'rgba(50,108,229,0.06)',
          },
          sider: {
            colorMenuBackground: '#fff',
            colorTextMenu: '#595959',
            colorTextMenuActive: '#326CE5',
            colorTextMenuSelected: '#326CE5',
            colorBgMenuItemSelected: 'rgba(50,108,229,0.08)',
            colorTextMenuTitle: '#1a1a1a',
            colorBgMenuItemHover: 'rgba(0,0,0,0.03)',
          },
          pageContainer: {
            colorBgPageContainer: '#f5f7fa',
          },
        }}
        menuItemRender={(item, dom) => (
          <a onClick={() => item.path && router.push(item.path)}>{dom}</a>
        )}
        actionsRender={() => [
          <ClusterSelector key="cluster" />,
          <Dropdown
            key="user"
            menu={{
              items: [
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: handleLogout },
              ],
            }}
          >
            <span style={{ cursor: 'pointer', color: '#595959' }}>
              <Avatar size="small" icon={<UserOutlined />} style={{ marginRight: 8, backgroundColor: '#326CE5' }} />
              {user?.username || '...'}
            </span>
          </Dropdown>,
        ]}
      >
        <div style={{ padding: 24, minHeight: 'calc(100vh - 56px)' }}>
          {children}
        </div>
      </ProLayout>
      </App>
    </ConfigProvider>
  );
}
