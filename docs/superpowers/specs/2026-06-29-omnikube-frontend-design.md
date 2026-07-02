# OmniKube 子项目 F：前端（React + AntD + ui-ux-pro-max）— 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md` §6（前端页面解构）+ §5（功能模块）
> 依赖：A–E 后端 API（均已实现）。前端独立目录 `frontend/`，与后端零冲突。

## 1. 范围与技术栈

实现 OmniKube 完整前端：登录、首登改密、集群管理（admin）、用户管理 + 权限矩阵（admin）、资源看板（工作负载/网络/存储）、Pod 日志、WebSSH 终端。

**技术栈**：Vite + React 18 + TypeScript + Ant Design 5 + Axios + React Router v6 + `@xterm/xterm`（WebSSH）+ Zustand（全局状态）。**设计用 `ui-ux-pro-max` skill** 产出精细 AntD 主题（配色/间距/暗色模式/排版），避免默认 AntD 的廉价感——"不能太丑"是硬要求。

**目录**：
```
frontend/
├── index.html  package.json  vite.config.ts  tsconfig.json  .env.example
└── src/
    ├── main.tsx  App.tsx  theme.ts            # ConfigProvider 主题 token (ui-ux-pro-max 产出)
    ├── api/      client.ts auth.ts cluster.ts user.ts grant.ts resource.ts ws.ts
    ├── store/    auth.ts ctx.ts               # token/user; currentCluster/currentNamespace
    ├── components/ AppLayout.tsx TopBar.tsx Sidebar.tsx ProtectedRoute.tsx AdminRoute.tsx
    │              ResourceTable.tsx YamlDrawer.tsx
    └── pages/     Login.tsx ChangePassword.tsx
                   clusters/Clusters.tsx  users/Users.tsx
                   dashboard/Dashboard.tsx
                   workloads/{Deployments,StatefulSets,DaemonSets,Pods,Jobs}.tsx
                   networking/{Services,Ingresses}.tsx
                   storage/{ConfigMaps,Secrets,PVCs}.tsx
```

## 2. 全局约定

- **Axios 拦截器**（`api/client.ts`）：请求注入 `Authorization: Bearer <jwt>` 与（资源类请求）`X-Cluster-ID: <currentCluster>`；响应 401 → 清 token 跳 `/login`；统一错误 toast（读后端 `{code,message}`）。
- **全局状态**：`auth`（token、user：id/username/is_admin/must_reset）；`ctx`（currentCluster、currentNamespace）。顶栏持有 cluster/ns 状态（PRD §6）。token 存 localStorage。
- **路由守卫**：`ProtectedRoute`（需登录；`must_reset` 强制跳改密）；`AdminRoute`（需 is_admin）。

## 3. 后端 API 契约（前端据此对接）

所有路径前缀 `/api/v1`。错误体 `{code:int, message:string}`。

### 认证（A）
- `POST /login` `{username,password}` → `{token, must_reset}`
- `POST /change-password` `{old_password,new_password}`（Bearer）→ `{code:0,message}`
- `GET /me`（Bearer）→ `{id,username,is_admin,must_reset}`

### 集群管理（B，admin）
- `POST /clusters` `{id,name,kubeconfig}` → 201/200
- `GET /clusters` → `[{id,name,status,last_check}]`（无 kubeconfig）
- `PUT /clusters/:id` `{name?,kubeconfig?}`
- `DELETE /clusters/:id`
- `POST /clusters/test` `{kubeconfig}` → 连通性结果

### 用户与授权（C，admin）
- `POST /users` `{username}` → `{...,temp_password}`（一次性返回，UI 显著展示并提示转交）
- `GET /users` → `[{id,username,is_admin,disabled}]`
- `PUT /users/:id/disable`，`PUT /users/:id/enable`，`DELETE /users/:id`
- `POST /grants` `{user_id,cluster_id,scope:"cluster"|"namespace",namespaces:[],role}`
- `GET /grants?user_id=` → `[{role,cluster_id,namespace}]`
- `DELETE /grants` `{user_id,role,domain}`
- 角色：`Cluster-Admin`/`Cluster-Viewer`/`NS-Editor`/`NS-Viewer`

### 资源看板（D，需 `X-Cluster-ID`）
- `GET /namespaces` → 当前用户在该集群可见的 NS 列表（顶栏 NS 下拉数据源）
- `GET /resources/:resource?namespace=ns` → 列表（命名空间型）；ns 空=集群级聚合（仅可见 NS）
- `GET /namespaces/:ns/resources/:resource/:name` → 详情（YAML/JSON）
- `POST /namespaces/:ns/resources/:resource`（body=对象）/ `PUT .../:name` / `DELETE .../:name`
- `POST /namespaces/:ns/resources/secrets/:name/reveal` → 明文（揭示，NS-Editor 及以上）

### WebSocket（E）
- WebSSH：`GET /api/v1/exec?cluster_id=&namespace=&pod=&container=&token=<jwt>`（wss）
- 日志：`GET /api/v1/logs?cluster_id=&namespace=&pod=&container=&token=<jwt>&follow=true&tail=200`
- resize 控制消息：`{"type":"resize","cols","rows"}`

## 4. 页面设计

### 4.1 登录 `/login`
品牌化登录卡片（ui-ux-pro-max 主题）。提交 → 存 token → `must_reset` 则跳 `/change-password` 否则跳 `/dashboard`。

### 4.2 首登改密 `/change-password`
`must_reset` 时强制；旧/新密码 + 确认；成功后清标记进主应用。

### 4.3 主框架 `AppLayout`
- **顶栏**：品牌 + **集群下拉**（数据 `GET /clusters`，选中写 currentCluster）+ **NS 下拉**（数据 `GET /namespaces`，依赖当前集群）+ 用户菜单（改密/登出）。
- **侧边栏**：Dashboard / 工作负载 / 网络 / 存储；admin 额外显示「集群管理」「用户与权限」。
- 切换集群/NS 触发资源页刷新。

### 4.4 集群管理 `/clusters`（admin）
表格列出集群（名称/ID/状态徽标 Healthy绿·Unreachable红·Unknown灰/最近探活）。「添加集群」抽屉：ID/别名/kubeconfig 文本域 + 「测试连接」按钮（调 `/clusters/test`）→ 通过才允许提交。行操作：删除（二次确认）。

### 4.5 用户与权限 `/users`（admin）
- 用户表（用户名/管理员/状态）+ 创建用户（返回临时密码用 Modal 醒目展示，提示「仅显示一次」）+ 禁用/启用/删除。
- **权限矩阵指派**（级联，PRD §5.2）：选用户 → 抽屉：层级1 选集群 → 层级2 选范围（整集群 / 指定 NS 多选，NS 数据来自该集群 `/namespaces`，但 admin 指派需全部 NS——可让后端 `/namespaces` 对 admin 返回全部）→ 层级3 选角色（Cluster-* 仅整集群范围、NS-* 仅 NS 范围）→ 提交 `POST /grants`。下方展示该用户现有绑定（`GET /grants`）可删除。

### 4.6 资源看板（依赖顶栏 cluster/ns）
- **Dashboard**：当前集群/NS 概览卡片（各资源计数，调若干 `GET /resources/*`）。
- **工作负载/网络/存储**：通用 `ResourceTable`（列：名称/NS/状态/创建时间 + 操作）。
  - 行操作：查看/编辑 YAML（`YamlDrawer`，Monaco 或 AntD 文本域；保存调 PUT）、删除。
  - **Pods**：额外「日志」（打开抽屉，xterm 接 `/logs` ws 流）、「终端」（WebSSH，仅当有 exec 权限时显示——前端可乐观显示，后端 403 兜底）。
  - **Secrets**：`data` 默认 `******`；「揭示」按钮调 `/reveal` 显示明文（写后端审计）。
  - **网络**：Services/Ingresses 列表，Ingress 展示域名→Service。

### 4.7 WebSSH 终端 & 日志
`@xterm/xterm` + FitAddon。终端：建立 ws（token 取自 store），双向桥接，窗口变化发 resize 控制消息。日志：只读 xterm，接 `/logs` 流，支持 follow/tail。

## 5. 测试与验收

- **构建/类型**：`npm run build`（tsc + vite build）零错误；`npm run lint` 通过。
- **关键交互单测**（Vitest + React Testing Library，mock axios）：登录成功跳转 + must_reset 跳改密；Axios 拦截器注入 Bearer/X-Cluster-ID 且 401 跳登录；集群「测试连接」未过禁止提交；权限矩阵按 scope 约束角色；Secrets 揭示前后展示切换。
- **设计质量**：由 `ui-ux-pro-max` 把关——一致的 token 化主题、合理留白、状态色、暗色模式、空/加载/错误态，杜绝默认 AntD 廉价感。
- **手动联调**（可选）：后端起在 :8080，前端 `.env` 配 `VITE_API_BASE`，跑通登录→集群→资源。

### 验收标准
1. `npm run build` 与 `npm run lint`、`npm run test` 全过。
2. 登录/改密/集群管理/用户权限/资源看板/Secrets 揭示/Pod 日志/WebSSH 页面齐全且接真实 API 契约。
3. Axios 注入 Bearer + X-Cluster-ID，401 自动登出。
4. 设计经 ui-ux-pro-max 处理，非默认廉价 AntD 观感（暗色模式 + 一致 token）。

## 6. 不在本 spec
- 后端任何改动（前端纯对接既有 API；若发现契约缺口，记 TODO 不擅自改后端）。
- i18n、SSR、移动端适配（YAGNI）。
