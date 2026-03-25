# UI 全站重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全站 UI 翻新为精致企业风，统一视觉一致性和品牌感

**Architecture:** 创建 `PageContainer` 和 `StatCard` 共享组件，重写 `ClusterSelector`，改造登录页为左右分栏，所有列表页统一 Card 包裹结构，全局 ConfigProvider token 调整

**Tech Stack:** Next.js, React 19, Ant Design 5, @ant-design/pro-layout

**Spec:** `docs/superpowers/specs/2026-03-25-ui-redesign-design.md`

---

## File Structure

### 新建文件
- `src/components/page-container.tsx` — 统一列表页 Card 包裹组件
- `src/components/stat-card.tsx` — Dashboard 渐变统计卡片组件
- `src/components/auth-brand.tsx` — 登录页左侧品牌区组件（登录和改密共用）
- `src/lib/styles.ts` — 共享样式常量（渐变按钮样式等）

### 修改文件
- `src/components/cluster-selector.tsx` — 重写为品牌色胶囊按钮
- `src/components/resource-table.tsx` — table size 改为 middle
- `src/components/namespace-selector.tsx` — 去掉 marginBottom（由 PageContainer filters 控制间距）
- `src/app/(auth)/layout.tsx` — 改为全屏容器
- `src/app/(auth)/login/page.tsx` — 左右分栏布局
- `src/app/(auth)/change-password/page.tsx` — 左右分栏布局
- `src/app/(dashboard)/layout.tsx` — ConfigProvider token 更新（Card 圆角 12px）
- `src/app/(dashboard)/page.tsx` — Dashboard 使用 StatCard
- `src/app/(dashboard)/clusters/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/clusters/[id]/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/clusters/new/page.tsx` — 按钮渐变色
- `src/app/(dashboard)/admin/users/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/admin/roles/page.tsx` — PageContainer + 权限矩阵重写
- `src/app/(dashboard)/admin/audit/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/apps/releases/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/namespaces/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/deployments/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/statefulsets/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/daemonsets/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/jobs/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/pods/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/networking/services/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/networking/ingresses/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/config/configmaps/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/config/secrets/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/storage/pvcs/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/storage/storageclasses/page.tsx` — PageContainer 包裹
- `src/app/(dashboard)/resources/workloads/deployments/[name]/page.tsx` — Card 圆角统一
- `src/app/(dashboard)/resources/workloads/pods/[name]/page.tsx` — Card 圆角统一

---

## Task 1: 全局 ConfigProvider token 调整

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx:96-102`

- [ ] **Step 1: 更新 ConfigProvider theme token**

在 `src/app/(dashboard)/layout.tsx` 中，将现有 token 更新为：

```tsx
theme={{
  token: {
    colorPrimary: '#326CE5',
    borderRadius: 6,
  },
  components: {
    Card: {
      borderRadiusLG: 12,
    },
    Table: {
      // size="middle" 由各组件控制
    },
  },
}}
```

- [ ] **Step 2: 验证构建通过**

Run: `npx next build 2>&1 | tail -5` 或 在开发环境下确认页面正常渲染

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/layout.tsx
git commit -m "style: update global ConfigProvider token for card border-radius"
```

---

## Task 2: 创建 PageContainer 组件

**Files:**
- Create: `src/components/page-container.tsx`

- [ ] **Step 1: 创建 PageContainer 组件**

```tsx
'use client';

import type { ReactNode } from 'react';

interface PageContainerProps {
  title: string;
  description?: string;
  extra?: ReactNode;
  filters?: ReactNode;
  children: ReactNode;
}

export default function PageContainer({ title, description, extra, filters, children }: PageContainerProps) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    }}>
      {/* 页头 */}
      <div style={{
        padding: '20px 24px',
        borderBottom: '1px solid #f0f0f0',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: filters ? 12 : 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{title}</div>
            {description && (
              <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>{description}</div>
            )}
          </div>
          {extra && <div>{extra}</div>}
        </div>
        {filters && <div style={{ display: 'flex', gap: 8 }}>{filters}</div>}
      </div>
      {/* 内容区 */}
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: 验证构建通过**

Run: `npx next build 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add src/components/page-container.tsx
git commit -m "feat: add PageContainer component for unified list page layout"
```

---

## Task 3: 创建 StatCard 组件

**Files:**
- Create: `src/components/stat-card.tsx`

- [ ] **Step 1: 创建 StatCard 组件**

```tsx
'use client';

import type { ReactNode } from 'react';

interface StatCardProps {
  title: string;
  value: number | string;
  gradient: string;
  icon: ReactNode;
  footer?: string;
}

export default function StatCard({ title, value, gradient, icon, footer }: StatCardProps) {
  return (
    <div style={{
      background: gradient,
      borderRadius: 10,
      padding: '20px 24px',
      color: 'white',
      height: '100%',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>{title}</div>
          <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        </div>
        <div style={{ fontSize: 24, opacity: 0.6 }}>{icon}</div>
      </div>
      {footer && (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 12 }}>{footer}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/stat-card.tsx
git commit -m "feat: add StatCard component for dashboard gradient stat cards"
```

---

## Task 4: 创建 AuthBrand 组件

**Files:**
- Create: `src/components/auth-brand.tsx`

- [ ] **Step 1: 创建 AuthBrand 共享品牌区组件**

该组件被登录页和改密页的左侧共用。

```tsx
'use client';

import Logo from '@/components/logo';

export default function AuthBrand() {
  return (
    <div style={{
      flex: 1,
      background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 40%, #326CE5 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 48,
      minHeight: '100vh',
    }}>
      <Logo size={64} showText={false} />
      <h1 style={{
        color: 'white',
        fontSize: 28,
        fontWeight: 700,
        marginTop: 24,
        marginBottom: 8,
      }}>
        K8s Admin
      </h1>
      <p style={{
        color: 'rgba(255,255,255,0.6)',
        fontSize: 14,
        textAlign: 'center',
        marginBottom: 0,
      }}>
        Kubernetes 集群管理平台
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/auth-brand.tsx
git commit -m "feat: add AuthBrand component for login/change-password left panel"
```

---

## Task 4.5: 创建共享样式常量

**Files:**
- Create: `src/lib/styles.ts`

- [ ] **Step 1: 创建共享样式常量**

```ts
import type { CSSProperties } from 'react';

export const gradientBtnStyle: CSSProperties = {
  background: 'linear-gradient(135deg, #326CE5, #1a4bc7)',
  border: 'none',
};
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/styles.ts
git commit -m "feat: add shared gradient button style constant"
```

各页面的渐变按钮都导入 `gradientBtnStyle` 而不是重复内联：
```tsx
import { gradientBtnStyle } from '@/lib/styles';
// ...
<Button type="primary" style={gradientBtnStyle}>...</Button>
```

---

## Task 5: 重写 ClusterSelector 组件

**Files:**
- Modify: `src/components/cluster-selector.tsx`

- [ ] **Step 1: 重写为品牌色胶囊按钮**

将整个文件替换为使用 Ant Design `Dropdown` + 自定义胶囊触发器。需要从 API 获取 `status` 字段。

```tsx
'use client';

import { Dropdown } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useClusterStore } from '@/hooks/use-cluster';
import { useRequest } from 'ahooks';

const statusColors: Record<string, string> = {
  connected: '#4ade80',
  disconnected: '#94a3b8',
  error: '#f87171',
};

export default function ClusterSelector() {
  const { clusterId, clusterName, setCluster } = useClusterStore();

  const { data: clusters = [] } = useRequest(async () => {
    const res = await fetch('/api/clusters');
    if (!res.ok) return [];
    return res.json();
  });

  const currentCluster = clusters.find((c: any) => c.id === clusterId);
  const statusColor = statusColors[currentCluster?.status] || statusColors.disconnected;

  const items = clusters.map((c: any) => ({
    key: c.id,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColors[c.status] || statusColors.disconnected,
          flexShrink: 0,
        }} />
        <span>{c.displayName || c.name}</span>
      </div>
    ),
    onClick: () => setCluster(c.id, c.displayName || c.name),
  }));

  return (
    <Dropdown menu={{ items, selectedKeys: clusterId ? [clusterId] : [] }} trigger={['click']}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'linear-gradient(135deg, #326CE5, #1a4bc7)',
        borderRadius: 20,
        padding: '5px 14px',
        cursor: 'pointer',
        userSelect: 'none',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'white' }}>
          {clusterName || '选择集群'}
        </span>
        <DownOutlined style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }} />
      </div>
    </Dropdown>
  );
}
```

- [ ] **Step 2: 确认 `useClusterStore` 有 `clusterName` 字段**

读取 `src/hooks/use-cluster.ts`，确认 store 中有 `clusterName` 属性。如果没有，需要检查 `setCluster` 的第二个参数是否会保存名称。

- [ ] **Step 3: 验证开发环境中胶囊按钮正常显示**

- [ ] **Step 4: Commit**

```bash
git add src/components/cluster-selector.tsx
git commit -m "style: rewrite ClusterSelector as branded capsule button with status dot"
```

---

## Task 6: 改造 Auth Layout + 登录页

**Files:**
- Modify: `src/app/(auth)/layout.tsx`
- Modify: `src/app/(auth)/login/page.tsx`

- [ ] **Step 1: 改造 Auth Layout**

将 `src/app/(auth)/layout.tsx` 中的居中 flex 容器改为全屏容器：

```tsx
'use client';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
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
        {children}
      </App>
    </ConfigProvider>
  );
}
```

- [ ] **Step 2: 改造登录页为左右分栏**

将 `src/app/(auth)/login/page.tsx` 改为左右分栏布局。左侧使用 `AuthBrand` 组件，右侧放表单。保留所有现有业务逻辑（handlePasswordLogin, handleSendCode, handleCodeLogin）不变，只改 return 中的 JSX。

左右分栏外层结构：
```tsx
<div style={{ display: 'flex', minHeight: '100vh' }}>
  {/* 左侧品牌区 - 移动端隐藏 */}
  <div className="auth-brand-panel">
    <AuthBrand />
  </div>
  {/* 右侧表单区 */}
  <div style={{
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px 24px',
    background: '#fff',
  }}>
    <div style={{ width: '100%', maxWidth: 400 }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>欢迎回来</h2>
      <p style={{ color: '#94a3b8', marginBottom: 32, fontSize: 14 }}>登录以继续管理集群</p>
      <Tabs centered items={[/* 保留现有 tabs 内容 */]} />
    </div>
  </div>
</div>
```

移动端响应式通过内联 `<style>` 标签添加媒体查询：
```css
@media (max-width: 768px) {
  .auth-brand-panel { display: none !important; }
}
```

- [ ] **Step 3: 验证登录页左右分栏正常显示**

- [ ] **Step 4: Commit**

```bash
git add src/app/\(auth\)/layout.tsx src/app/\(auth\)/login/page.tsx
git commit -m "style: redesign login page with split layout and brand panel"
```

---

## Task 7: 改造改密页

**Files:**
- Modify: `src/app/(auth)/change-password/page.tsx`

- [ ] **Step 1: 改为左右分栏布局**

与登录页相同结构，左侧 `AuthBrand`，右侧表单。保留所有业务逻辑不变，右侧内容改为：

```tsx
<h2 style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>修改密码</h2>
<p style={{ color: '#94a3b8', marginBottom: 24, fontSize: 14 }}>首次登录需要修改密码</p>
<Alert message="请设置新的登录密码" type="warning" showIcon style={{ marginBottom: 24 }} />
{/* 保留现有 Form */}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(auth\)/change-password/page.tsx
git commit -m "style: redesign change-password page with split layout"
```

---

## Task 8: 改造 Dashboard

**Files:**
- Modify: `src/app/(dashboard)/page.tsx`

- [ ] **Step 1: 替换统计卡片为 StatCard**

导入 `StatCard`，替换现有 4 个 `<Card><Statistic>` 为：

```tsx
import StatCard from '@/components/stat-card';

// 在 return 中替换 Row:
<Row gutter={16} style={{ marginBottom: 24 }}>
  <Col span={6}>
    <StatCard
      title="集群"
      value={data?.clusterCount ?? '-'}
      gradient="linear-gradient(135deg, #326CE5, #1a4bc7)"
      icon={<ClusterOutlined />}
    />
  </Col>
  <Col span={6}>
    <StatCard
      title="运行 Pods"
      value={data?.podCount ?? '-'}
      gradient="linear-gradient(135deg, #10b981, #059669)"
      icon={<CloudOutlined />}
    />
  </Col>
  <Col span={6}>
    <StatCard
      title="Deployments"
      value={data?.deploymentCount ?? '-'}
      gradient="linear-gradient(135deg, #8b5cf6, #7c3aed)"
      icon={<RocketOutlined />}
    />
  </Col>
  <Col span={6}>
    <StatCard
      title="今日发布"
      value={data?.todayReleaseCount ?? '-'}
      gradient="linear-gradient(135deg, #f59e0b, #d97706)"
      icon={<CalendarOutlined />}
    />
  </Col>
</Row>
```

- [ ] **Step 2: 将事件列表和集群状态列表的 Card 添加圆角阴影**

给下方两个 Card 添加统一样式：

```tsx
<Card title="最近事件" style={{ borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
```

```tsx
<Card title="集群状态" style={{ borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
```

- [ ] **Step 3: 验证 Dashboard 渐变卡片显示正确**

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/page.tsx
git commit -m "style: redesign dashboard with gradient stat cards"
```

---

## Task 9: 更新 ResourceTable 和 NamespaceSelector

**Files:**
- Modify: `src/components/resource-table.tsx:21` — `size="small"` → `size="middle"`
- Modify: `src/components/namespace-selector.tsx:22` — 去掉 `marginBottom: 16`

- [ ] **Step 1: ResourceTable size 改为 middle**

在 `src/components/resource-table.tsx` 第 27 行，将 `size="small"` 改为 `size="middle"`。

- [ ] **Step 2: NamespaceSelector 去掉 marginBottom**

在 `src/components/namespace-selector.tsx` 第 22 行，将 `style={{ width: 200, marginBottom: 16 }}` 改为 `style={{ width: 200 }}`。间距将由 PageContainer 的 filters 区域控制。

- [ ] **Step 3: Commit**

```bash
git add src/components/resource-table.tsx src/components/namespace-selector.tsx
git commit -m "style: update ResourceTable size to middle, remove NamespaceSelector margin"
```

---

## Task 10: 改造集群管理页

**Files:**
- Modify: `src/app/(dashboard)/clusters/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹**

导入 PageContainer，替换现有裸 div 结构。将 Title + Button 头部替换为 PageContainer 的 title/extra，Table 放入 children。

当前结构：
```tsx
<div>
  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
    <Title level={4} style={{ margin: 0 }}>集群管理</Title>
    <Button type="primary" ...>添加集群</Button>
  </div>
  <Table ... />
</div>
```

改为：
```tsx
<PageContainer
  title="集群管理"
  description="管理和监控 Kubernetes 集群连接"
  extra={
    <Button type="primary" icon={<PlusOutlined />} onClick={() => router.push('/clusters/new')}
      style={gradientBtnStyle}>
      添加集群
    </Button>
  }
>
  <Table ... size="middle" />
</PageContainer>
```

同时移除 `Typography` 的 `Title` 导入（如果不再使用）。

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/clusters/page.tsx
git commit -m "style: wrap clusters page with PageContainer"
```

---

## Task 11: 改造集群编辑页

**Files:**
- Modify: `src/app/(dashboard)/clusters/[id]/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹**

将现有的裸 div + Title 头部替换为 PageContainer。Tabs 放入 children。

当前头部：
```tsx
<div style={{ marginBottom: 16, display: 'flex', ... }}>
  <Typography.Title level={4} ...>{cluster.displayName}<Tag .../></Typography.Title>
  <Button onClick={() => router.push('/clusters')}>返回列表</Button>
</div>
<Tabs items={[...]} />
```

改为：
```tsx
<PageContainer
  title={cluster.displayName}
  description={`集群标识: ${cluster.name}`}
  extra={
    <Space>
      <Tag color={s.color} icon={s.icon}>{s.label}</Tag>
      <Button onClick={() => router.push('/clusters')}>返回列表</Button>
    </Space>
  }
>
  <div style={{ padding: '16px 24px' }}>
    <Tabs items={[...]} />
  </div>
</PageContainer>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/clusters/\[id\]/page.tsx
git commit -m "style: wrap cluster detail page with PageContainer"
```

---

## Task 12: 改造添加集群页

**Files:**
- Modify: `src/app/(dashboard)/clusters/new/page.tsx`

- [ ] **Step 1: 按钮使用渐变色**

在 `src/app/(dashboard)/clusters/new/page.tsx` 中，给提交按钮加上渐变背景：

```tsx
<Button type="primary" htmlType="submit" loading={loading}
  style={gradientBtnStyle}>
  添加
</Button>
```

Card title 和 maxWidth 保持不变（全局 ConfigProvider 已处理圆角）。

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/clusters/new/page.tsx
git commit -m "style: add gradient button to new cluster page"
```

---

## Task 13: 改造用户管理页

**Files:**
- Modify: `src/app/(dashboard)/admin/users/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹**

当前结构：
```tsx
<div>
  <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
    <h2>用户管理</h2>
    <Button ...>添加用户</Button>
  </div>
  <Table ... size="small" />
  {/* modals */}
</div>
```

改为：
```tsx
<>
  <PageContainer
    title="用户管理"
    description="管理系统用户和权限分配"
    extra={
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}
        style={gradientBtnStyle}>
        添加用户
      </Button>
    }
  >
    <Table ... size="middle" />
  </PageContainer>
  {/* modals 放在 PageContainer 外面 */}
</>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/admin/users/page.tsx
git commit -m "style: wrap users page with PageContainer"
```

---

## Task 14: 改造角色管理页（含权限矩阵重写）

**Files:**
- Modify: `src/app/(dashboard)/admin/roles/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹列表**

同 Task 13 模式，将 `<h2>` + Table 替换为 PageContainer。

- [ ] **Step 2: 重写权限矩阵**

将 Modal 内的原生 HTML `<table>` + `<input type="checkbox">` 替换为 Ant Design `<Table>` + `<Checkbox>`：

```tsx
import { Checkbox } from 'antd';

// 在 Modal 内，替换原生 table 为：
const permColumns = [
  {
    title: '资源',
    dataIndex: 'resource',
    key: 'resource',
    fixed: 'left' as const,
    width: 180,
    render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
  },
  ...ACTIONS.map((action) => ({
    title: action,
    key: action,
    width: 80,
    align: 'center' as const,
    render: (_: any, record: { resource: string }) => (
      <Checkbox
        checked={(permissions[record.resource] || []).includes(action)}
        onChange={() => toggleAction(record.resource, action)}
      />
    ),
  })),
];

const permData = RESOURCES.map((r) => ({ key: r, resource: r }));

// JSX:
<div>
  <p style={{ fontWeight: 600, marginBottom: 8, color: '#0f172a' }}>权限配置</p>
  <Table
    columns={permColumns}
    dataSource={permData}
    pagination={false}
    size="small"
    bordered
    rowClassName={(_, index) => index % 2 === 0 ? '' : 'ant-table-row-alt'}
  />
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/admin/roles/page.tsx
git commit -m "style: wrap roles page with PageContainer, rewrite permission matrix with Ant Design"
```

---

## Task 15: 改造审计日志页

**Files:**
- Modify: `src/app/(dashboard)/admin/audit/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹**

当前结构：
```tsx
<div>
  <h2>审计日志</h2>
  <Space style={{ marginBottom: 16 }}>
    <Select .../>
    <Select .../>
  </Space>
  <Table ... size="small" />
</div>
```

改为：
```tsx
<PageContainer
  title="审计日志"
  description="查看系统操作记录"
  filters={
    <>
      <Select ... style={{ width: 150 }} />
      <Select ... style={{ width: 150 }} />
    </>
  }
>
  <Table ... size="middle" />
</PageContainer>
```

去掉外层 `<Space>` 包裹筛选器（PageContainer filters 区域已有 `display: flex; gap: 8`）。

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/admin/audit/page.tsx
git commit -m "style: wrap audit page with PageContainer, integrate filters"
```

---

## Task 16: 改造发布记录页

**Files:**
- Modify: `src/app/(dashboard)/apps/releases/page.tsx`

- [ ] **Step 1: 用 PageContainer 包裹**

```tsx
// 替换：
<div>
  <Title level={4}>发布记录</Title>
  <Table ... />
</div>

// 为：
<PageContainer title="发布记录" description="查看应用发布历史">
  <Table ... size="middle" />
</PageContainer>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/\(dashboard\)/apps/releases/page.tsx
git commit -m "style: wrap releases page with PageContainer"
```

---

## Task 17: 批量改造资源列表页面（12 个页面）

**Files:**
- Modify: `src/app/(dashboard)/resources/namespaces/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/deployments/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/statefulsets/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/daemonsets/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/jobs/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/pods/page.tsx`
- Modify: `src/app/(dashboard)/resources/networking/services/page.tsx`
- Modify: `src/app/(dashboard)/resources/networking/ingresses/page.tsx`
- Modify: `src/app/(dashboard)/resources/config/configmaps/page.tsx`
- Modify: `src/app/(dashboard)/resources/config/secrets/page.tsx`
- Modify: `src/app/(dashboard)/resources/storage/pvcs/page.tsx`
- Modify: `src/app/(dashboard)/resources/storage/storageclasses/page.tsx`

所有资源页面遵循相同模式，以下以 **Deployments** 为模板：

- [ ] **Step 1: 改造每个资源页**

对于每个页面，执行相同的变换：

**带 NamespaceSelector 的页面**（Deployments, StatefulSets, DaemonSets, Jobs, Pods, Services, Ingresses, ConfigMaps, Secrets, PVCs, StorageClasses）：

```tsx
// 替换：
<div>
  <div style={{ marginBottom: 16, display: 'flex', ... }}>
    <Title level={4} style={{ margin: 0 }}>Deployments</Title>
    {permissions.canCreate && <Button ...>+ 创建</Button>}
  </div>
  <NamespaceSelector value={namespace} onChange={handleNsChange} />
  <ResourceTable data={data} loading={loading} columns={columns} />
  <ResourceDrawer ... />
</div>

// 为：
<>
  <PageContainer
    title="Deployments"
    extra={permissions.canCreate ? (
      <Button type="primary" onClick={() => setDrawerState({ open: true, mode: 'create' })}
        style={gradientBtnStyle}>
        + 创建
      </Button>
    ) : undefined}
    filters={<NamespaceSelector value={namespace} onChange={handleNsChange} />}
  >
    <ResourceTable data={data} loading={loading} columns={columns} />
  </PageContainer>
  <ResourceDrawer ... />
</>
```

**不带 NamespaceSelector 的页面**（Namespaces）：

```tsx
<>
  <PageContainer
    title="Namespaces"
    extra={permissions.canCreate ? (
      <Button type="primary" onClick={...}
        style={gradientBtnStyle}>
        + 创建
      </Button>
    ) : undefined}
  >
    <ResourceTable data={data} loading={loading} columns={columns} />
  </PageContainer>
  <ResourceDrawer ... />
</>
```

每个页面移除 `Typography` 的 `Title` 导入。

- [ ] **Step 2: 验证一个代表页面（如 Deployments）正常显示**

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/resources/
git commit -m "style: wrap all resource list pages with PageContainer"
```

---

## Task 18: 改造详情页面

**Files:**
- Modify: `src/app/(dashboard)/resources/workloads/deployments/[name]/page.tsx`
- Modify: `src/app/(dashboard)/resources/workloads/pods/[name]/page.tsx`

- [ ] **Step 1: Deployment 详情页 Table size 改为 middle**

在 `src/app/(dashboard)/resources/workloads/deployments/[name]/page.tsx` 第 310 行，将 Pods table 的 `size="small"` 改为 `size="middle"`。

Card 的圆角已通过全局 ConfigProvider 处理。

- [ ] **Step 2: Pod 详情页无需额外改动**

Pod 详情页已使用 Card 包裹，圆角由全局 ConfigProvider 统一处理。

- [ ] **Step 3: Commit**

```bash
git add src/app/\(dashboard\)/resources/workloads/deployments/\[name\]/page.tsx
git commit -m "style: update deployment detail page table size"
```

---

## Task 19: 最终验证

- [ ] **Step 1: 运行构建确保无编译错误**

Run: `npx next build`

- [ ] **Step 2: 浏览器逐页检查**

检查清单：
- [ ] 登录页：左右分栏，左品牌区渐变，右表单正常
- [ ] 改密页：同登录页布局
- [ ] Dashboard：渐变统计卡片，事件列表 Card，集群状态 Card
- [ ] 集群管理：PageContainer 包裹
- [ ] 添加集群：渐变按钮
- [ ] 集群编辑：PageContainer + Tabs
- [ ] 用户管理：PageContainer 包裹
- [ ] 角色管理：PageContainer + Ant Design 权限矩阵
- [ ] 审计日志：PageContainer + 筛选器整合
- [ ] 发布记录：PageContainer 包裹
- [ ] 资源页面（抽查 Deployments, Pods, Services）：PageContainer + NamespaceSelector 在 filters
- [ ] 集群切换器：品牌蓝胶囊按钮
- [ ] 移动端响应式：登录页窄屏隐藏品牌区

- [ ] **Step 3: 修复发现的问题（如有）**

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "style: final UI polish and fixes"
```
