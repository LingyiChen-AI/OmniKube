import { useState } from 'react';
import { Layout } from 'antd';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

const { Content } = Layout;

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sidebar collapsed={collapsed} />
      <Layout style={{ minWidth: 0 }}>
        <TopBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        {/* scrollbarGutter:stable 始终预留滚动条宽度，避免内容高度变化(如仪表盘
            切集群时变骨架屏)导致滚动条出现/消失引发的横向布局抖动(顶栏闪烁)。 */}
        <Content
          style={{ padding: 24, overflow: 'auto', minWidth: 0, scrollbarGutter: 'stable' }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
