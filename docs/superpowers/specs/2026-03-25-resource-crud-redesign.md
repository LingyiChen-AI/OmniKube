# 资源页面 CRUD 重构设计

## 概述

去掉「应用模板」模块，将 CRUD 操作直接放到每个资源类型页面中。保留「发布记录」作为自动操作历史。每个资源页面通过右侧抽屉（Drawer）完成查看/编辑/创建，所有操作受 RBAC 权限管控。

## 改动范围

### 删除

- `src/app/(dashboard)/apps/templates/` — 模板页面（列表、创建）
- `src/app/(dashboard)/apps/releases/new/` — 新建发布页面
- `src/app/api/apps/templates/` — 模板 API（含 import）
- `src/app/api/apps/releases/[id]/rollback/route.ts` — 回滚 API
- DB 表 `app_templates` 保留不动（不删数据，只是不再使用）
- 侧边栏「应用发布」菜单改为「发布记录」单入口

### 保留

- `src/app/(dashboard)/apps/releases/page.tsx` — 发布记录列表（改为纯查看，移除「新建发布」按钮）
- `src/app/api/apps/releases/route.ts` — 发布记录 GET API（保留查询，移除 POST）
- `src/app/api/apps/releases/[id]/route.ts` — 保留 GET 详情

### 新增

- `src/components/resource-drawer.tsx` — 通用资源抽屉组件
- `src/components/delete-confirm.tsx` — 统一删除确认组件
- `src/components/resource-templates.ts` — 预设 YAML 模板数据
- `src/hooks/use-permissions.ts` — 权限检查 hook
- `src/app/api/rbac/check/route.ts` — 权限检查 API
- `src/lib/release-logger.ts` — 发布记录写入工具

### 改造

- 13 个资源页面 — 加入 CRUD 操作
- K8s 代理 API — 写操作成功后自动写发布记录
- 发布记录页面 — 纯查看模式
- 侧边栏布局 — 菜单调整
- DB schema — `app_releases.appTemplateId` 改为 nullable，`namespace` 改为 nullable

## 数据库调整

`src/lib/db/schema.ts` 修改：

```typescript
// app_releases 表
appTemplateId: uuid('app_template_id').references(() => appTemplates.id),  // 去掉 .notNull()
namespace: varchar('namespace', { length: 255 }),  // 去掉 .notNull()，集群级资源无 namespace
```

迁移命令：`npx drizzle-kit push`

## 交互设计

### 资源列表页

```
┌─────────────────────────────────────────────────────────┐
│ Deployments                    [Namespace ▾]  [+ 创建]  │
├─────────────────────────────────────────────────────────┤
│ 名称(可点击)  命名空间  就绪  状态  镜像  创建时间  操作  │
│ nginx-demo   default  2/2  Ready  ...  ...    编辑 删除  │
│ api-server   prod     3/3  Ready  ...  ...    编辑 删除  │
└─────────────────────────────────────────────────────────┘
```

- 「创建」按钮：RBAC canCreate 控制显隐
- 「编辑」按钮：RBAC canUpdate 控制显隐
- 「删除」按钮：RBAC canDelete 控制显隐
- 点击资源名称：以只读模式打开抽屉查看 YAML

### 右侧抽屉（ResourceDrawer）

三种模式：

**查看模式（点击资源名称）：**
```
┌──────────────────────────────┐
│ nginx-demo          [编辑] X │
├──────────────────────────────┤
│                              │
│  YAML 编辑器（只读暗色）       │
│  完整资源 YAML（含 status）   │
│                              │
└──────────────────────────────┘
```

**编辑模式（点击编辑按钮或抽屉内切换）：**
```
┌──────────────────────────────┐
│ 编辑 nginx-demo            X │
├──────────────────────────────┤
│                              │
│  YAML 编辑器（可编辑暗色）     │
│                              │
├──────────────────────────────┤
│              [取消]  [保存]   │
└──────────────────────────────┘
```

编辑模式清理的字段列表（明确）：
- `status` — 整个字段
- `metadata.managedFields` — K8s 内部管理
- `metadata.uid` — 自动生成
- `metadata.generation` — 自动生成
- `metadata.creationTimestamp` — 自动生成
- `metadata.selfLink` — 已废弃
- `metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]` — kubectl 内部
- `metadata.annotations["deployment.kubernetes.io/revision"]` — 自动生成

**保留** `metadata.resourceVersion` 用于 K8s 乐观锁冲突检测。如果保存时返回 409 Conflict，前端提示"资源已被其他人修改，请刷新后重试"。

**创建模式（点击创建按钮）：**
```
┌──────────────────────────────┐
│ 创建 Deployment            X │
├──────────────────────────────┤
│ 选择模板：                    │
│ [Deployment基础] [Deploy+Svc]│
│ [空白]                       │
├──────────────────────────────┤
│                              │
│  YAML 编辑器（可编辑暗色）     │
│  （预填模板内容或空白）        │
│                              │
├──────────────────────────────┤
│              [取消]  [创建]   │
└──────────────────────────────┘
```

**多文档 YAML 处理（如 Deployment + Service 模板）：**
前端提交前用 `yaml.parseAllDocuments()` 拆分为多个 manifest，依次调用代理 API 创建。如果第 N 个失败，前面已创建的不回滚，前端提示"部分资源创建成功，{failedKind} 创建失败: {error}"。

**Namespace 处理规则：**
- 命名空间级资源：YAML 中的 `metadata.namespace` 优先；如果未指定，使用页面顶部 Namespace 选择器的值；如果都没有，默认 `default`
- 集群级资源（StorageClasses、Namespaces）：忽略 namespace

**错误处理：**
- YAML 解析失败 → 提示 "YAML 格式错误: {detail}"
- K8s API 返回错误 → 提示 "操作失败: {K8s error message}"
- 网络超时 → 提示 "请求超时，请重试"
- 409 Conflict → 提示 "资源已被其他人修改，请刷新后重试"

**抽屉与 Namespace 切换：**
切换 Namespace 选择器时，如果抽屉打开，自动关闭抽屉。

### 删除确认（DeleteConfirm）

所有资源类型统一流程：

1. 点击「删除」→ Popconfirm 气泡 "确认要删除此资源？"
2. 点击「确认」→ 弹出 Modal：
```
┌────────────────────────────────┐
│ 删除 Deployment                │
├────────────────────────────────┤
│                                │
│ 请输入资源名称以确认删除：       │
│ ┌────────────────────────────┐ │
│ │                            │ │
│ └────────────────────────────┘ │
│                                │
│ 输入 nginx-demo 以确认          │
│                                │
├────────────────────────────────┤
│          [取消]  [确认删除]     │
│                  (输入正确前禁用)│
└────────────────────────────────┘
```

## 权限控制

### RBAC Check API

`GET /api/rbac/check?clusterId={id}&resource={kind}`

返回：
```json
{
  "canCreate": true,
  "canUpdate": true,
  "canDelete": false
}
```

### usePermissions Hook

```typescript
// 自动从 useClusterStore() 获取 clusterId
const permissions = usePermissions('deployments');
// { canCreate: boolean, canUpdate: boolean, canDelete: boolean }
```

内部实现：
```typescript
export function usePermissions(resource: string) {
  const { clusterId } = useClusterStore();
  const { data } = useRequest(async () => {
    if (!clusterId) return { canCreate: false, canUpdate: false, canDelete: false };
    const res = await fetch(`/api/rbac/check?clusterId=${clusterId}&resource=${resource}`);
    if (!res.ok) return { canCreate: false, canUpdate: false, canDelete: false };
    return res.json();
  }, { refreshDeps: [clusterId] });
  return data || { canCreate: false, canUpdate: false, canDelete: false };
}
```

按钮显隐规则：
- `permissions.canCreate` → 「创建」按钮
- `permissions.canUpdate` → 「编辑」按钮 + 抽屉内「编辑」切换
- `permissions.canDelete` → 「删除」按钮

## 发布记录自动生成

### 工具函数 `src/lib/release-logger.ts`

从 K8s 代理 API 调用，封装发布记录写入逻辑：

```typescript
interface ReleaseLogEntry {
  action: 'create' | 'update' | 'delete';
  kind: string;          // deployments, services, etc.
  resourceName: string;
  clusterId: string;
  namespace: string | null;  // null for cluster-scoped
  userId: string;
  requestBody?: any;     // POST/PUT body, null for DELETE
}

async function writeReleaseLog(entry: ReleaseLogEntry): Promise<void> {
  // 1. Compute revision: query max revision for (name+cluster+namespace), +1
  // 2. Generate message: "创建 Deployment nginx-demo" / "更新 Deployment nginx-demo" / "删除 Deployment nginx-demo"
  // 3. Insert into app_releases
}
```

### 触发时机

K8s 代理 API（`/api/k8s/[clusterId]/[...resource]`）的 POST/PUT/PATCH/DELETE 成功后调用 `writeReleaseLog`。

### 记录内容

写入 `app_releases` 表：

| 字段 | 值 |
|------|-----|
| name | 资源名称（如 nginx-demo） |
| namespace | 命名空间（集群级资源为 null） |
| clusterId | 当前集群 |
| status | applied |
| revision | 自增（按 name+cluster+namespace 组合） |
| message | 自动生成（见下） |
| releasedBy | 当前用户 |
| appTemplateId | null |
| renderedManifests | 请求体（POST/PUT）或 null（DELETE） |
| values | null |

### 自动生成 message 规则

Kind 名称映射（显示友好名称）：
- deployments → Deployment
- statefulsets → StatefulSet
- daemonsets → DaemonSet
- services → Service
- configmaps → ConfigMap
- secrets → Secret
- ingresses → Ingress
- jobs → Job
- cronjobs → CronJob
- pods → Pod
- persistentvolumeclaims → PVC
- storageclasses → StorageClass
- namespaces → Namespace

规则：
- 创建：`"创建 {Kind} {name}"`
- 更新：`"更新 {Kind} {name}"`
- 删除：`"删除 {Kind} {name}"`

不做镜像变更检测（需要额外 GET 增加复杂度和延迟，不值得）。镜像信息可通过发布记录详情页查看 renderedManifests 获得。

## 预设 YAML 模板

`src/components/resource-templates.ts` 导出模板数据，按资源类型索引。

### Deployment（基础）
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
```

### Deployment + Service
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: default
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
```

### StatefulSet
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-statefulset
  namespace: default
spec:
  serviceName: my-statefulset
  replicas: 1
  selector:
    matchLabels:
      app: my-statefulset
  template:
    metadata:
      labels:
        app: my-statefulset
    spec:
      containers:
        - name: my-statefulset
          image: nginx:latest
          ports:
            - containerPort: 80
```

### DaemonSet
```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-daemonset
  namespace: default
spec:
  selector:
    matchLabels:
      app: my-daemonset
  template:
    metadata:
      labels:
        app: my-daemonset
    spec:
      containers:
        - name: my-daemonset
          image: nginx:latest
```

### Service
```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
```

### ConfigMap
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key: value
```

### Secret
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
data:
  username: YWRtaW4=
  password: cGFzc3dvcmQ=
```

### CronJob
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
  namespace: default
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: my-job
              image: busybox
              command: ["echo", "hello"]
          restartPolicy: OnFailure
```

### Ingress
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: default
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
```

### PVC
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

### StorageClass
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: my-storageclass
provisioner: kubernetes.io/no-provisioner
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
```

### Namespace
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
```

每个资源页面只显示与本页资源类型相关的模板选项。

## 涉及的资源页面

以下 13 个页面都需要改造：

| 页面 | 资源类型 | 创建 | 编辑 | 删除 | 预设模板 |
|------|---------|------|------|------|---------|
| Deployments | deployments | Yes | Yes | Yes | Deployment 基础, Deployment+Service |
| StatefulSets | statefulsets | Yes | Yes | Yes | StatefulSet |
| DaemonSets | daemonsets | Yes | Yes | Yes | DaemonSet |
| Jobs/CronJobs | jobs | Yes | Yes | Yes | CronJob |
| Pods | pods | No | No | Yes(仅删除) | 无 |
| Services | services | Yes | Yes | Yes | Service |
| Ingresses | ingresses | Yes | Yes | Yes | Ingress |
| ConfigMaps | configmaps | Yes | Yes | Yes | ConfigMap |
| Secrets | secrets | Yes | Yes | Yes | Secret |
| PVC | persistentvolumeclaims | Yes | Yes | Yes | PVC |
| StorageClasses | storageclasses | Yes | Yes | Yes | StorageClass |
| Namespaces | namespaces | Yes | No | Yes | Namespace |

特殊处理：
- **Pods** 页面：只支持查看和删除（Pod 由控制器管理，直接创建/编辑无意义）
- **Namespaces** 页面：支持创建和删除，不支持编辑（namespace spec 基本不需要改）
- **StorageClasses / Namespaces**：集群级资源，不显示 Namespace 选择器，namespace 为 null
- **Jobs/CronJobs** 页面：一个页面处理两种资源，创建模板为 CronJob（Job 通常由 CronJob 产生）

## 侧边栏调整

```
Dashboard
集群资源
  ├── Namespaces
  ├── Workloads ▾
  │   ├── Deployments
  │   ├── StatefulSets
  │   ├── DaemonSets
  │   ├── Jobs / CronJobs
  │   └── Pods
  ├── Networking ▾
  │   ├── Services
  │   └── Ingresses
  ├── Config ▾
  │   ├── ConfigMaps
  │   └── Secrets
  └── Storage ▾
      ├── PV / PVC
      └── StorageClasses
发布记录              ← 原「应用发布」改为单入口
系统管理
  ├── 用户管理
  ├── 角色管理
  ├── 集群管理
  └── 审计日志
```

## 飞书通知

保持现有逻辑不变：K8s 代理 API 写操作成功后，检查集群 notifyEnabled，推送飞书卡片。卡片内容中「镜像版本」从请求体中提取。
