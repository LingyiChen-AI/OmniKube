'use client';

import { useState } from 'react';
import { ProLayout } from '@ant-design/pro-layout';
import { ConfigProvider, Dropdown, Avatar } from 'antd';
import {
  DashboardOutlined, ClusterOutlined, CloudServerOutlined,
  ApiOutlined, SettingOutlined, FileTextOutlined,
  UserOutlined, SafetyOutlined, AuditOutlined,
  AppstoreOutlined, RocketOutlined, DatabaseOutlined,
  GlobalOutlined, LogoutOutlined,
} from '@ant-design/icons';
import { useRouter, usePathname } from 'next/navigation';
import zhCN from 'antd/locale/zh_CN';
import ClusterSelector from '@/components/cluster-selector';
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
  {
    name: '应用发布',
    icon: <ApiOutlined />,
    children: [
      { path: '/apps/templates', name: '应用模板', icon: <FileTextOutlined /> },
      { path: '/apps/releases', name: '发布记录', icon: <RocketOutlined /> },
    ],
  },
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
    <ConfigProvider locale={zhCN}>
      <ProLayout
        title="K8s Admin"
        layout="mix"
        navTheme="dark"
        fixSiderbar
        collapsed={collapsed}
        onCollapse={setCollapsed}
        location={{ pathname }}
        route={{ routes: menuData }}
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
            <span style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.65)' }}>
              <Avatar size="small" icon={<UserOutlined />} style={{ marginRight: 8 }} />
              {user?.username || '...'}
            </span>
          </Dropdown>,
        ]}
      >
        <div style={{ padding: 24, minHeight: '100vh' }}>
          {children}
        </div>
      </ProLayout>
    </ConfigProvider>
  );
}
