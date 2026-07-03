# OmniKube AI 助手 — 设计文档

- 日期：2026-07-03
- 分支：`feat/ai-assistant`
- 状态：设计已确认，待审后进入 writing-plans

## 1. 目标

在 OmniKube 里内置一个名为 **OmniKube** 的全局 AI 助手：用户用自然语言，让 AI 在**当前选中的集群**里查询和操作 Kubernetes 资源（列表、详情、创建、编辑、删除等）。AI 是一个**自主 agent（ReAct 思想）**，能自己规划并连续执行多步（先查再改）。

关键约束：

- AI 的操作能力必须**受控**——管理员在后台配置 AI 可执行的「资源 × 操作」范围；未配置的操作 AI 做不了（例：没给 `deployments:create` 就无法创建部署）。
- AI 的每一步操作还要**不超过发起用户本人的权限**（防越权）。
- 写操作（创建/编辑/删除/exec/reveal）**先给用户确认**，确认后才真正下发。
- 未配置或未开启 AI 时，页面上的助手入口显示 **⚠️**，提示「未配置或未开启 AI，请联系管理员开启 AI 功能」。

## 2. 关键决策（已与用户确认）

| 维度 | 决策 |
|------|------|
| 执行引擎 | 自主 agent + **ReAct**，框架用 **Eino**（`github.com/cloudwego/eino`） |
| 权限裁决 | **AI 配置 ∩ 发起用户 RBAC**（双闸取交集） |
| 写操作 | **先确认**（Eino interrupt/resume）；读操作直接执行 |
| 权限粒度 | **复用角色权限矩阵**（资源 × 操作：view/create/edit/delete/exec/reveal） |
| 配置范围 | **模型配置全局一份 + AI 权限每集群一份**（整集群，不细分命名空间） |
| 对话 | **多轮 + 持久化到数据库** |
| 传输 | **WebSocket 流式**（双向：下行流式推 agent 事件，上行收确认/resume） |
| 配置准入 | RBAC 新增全局区 **`ai`(view/edit)**，**角色可配**；管理员旁路 |
| 名称 | OmniKube |

## 3. 架构总览

```
前端 (React)                        后端 (Go/Gin)                    外部
────────────                        ─────────────                    ────
全局助手悬浮入口 ──ws──▶  /api/v1/ai/chat (WS)  ──▶  internal/ai
  · ⚠️ 未配置态                        · runner: 跑 Eino ReAct agent      Eino ChatModelAgent
  · 聊天面板/步骤轨迹                   · tools: k8s 操作工具（双闸）  ──▶  OpenAI 兼容端点
  · 待确认卡片(确认/拒绝)               · guard: AI 配置 ∩ 用户 RBAC        (base_url/api_key/model)
  · 历史对话切换                        · 写操作 interrupt → 持久化
系统管理 › AI 配置(页面, ai:view/edit) · 审计埋点                    ──▶  K8s (client-go dynamic)
  · 模型配置 + 每集群权限矩阵          GORM ok_ai_* 表
```

## 4. 权限模型（双闸）

对 agent 想执行的每一次工具调用 `(cluster, namespace, resource, action)`：

1. **AI 闸**：该集群的 AI 授权 `aiGrant[resource]` 是否包含 `action`。
2. **用户闸**：`rbac.Authorize(userID, cluster, namespace, resource, casbin(action))` 是否放行（复用现有 Casbin 裁决，含 admin 旁路与集群级聚合读逻辑）。
3. **两闸都过**才允许；任一不过 → 工具返回「无权限（原因）」的观察结果给 agent，agent 据此如实告知用户，且前端明确提示被拒。
4. `action` 分类：
   - **读**（view/list、get）：直接执行。
   - **写**（create/edit/delete/exec/reveal）：触发 **interrupt**，把「拟执行动作」返回前端等确认。

> 命名空间：v1 的 AI 授权按**整集群**（`namespace` 由 agent 按用户指令决定，用户闸仍会按 ns 校验）。AI 授权本身不细分 ns。

## 5. 执行流程（ReAct + 流式 + 人在环）

单个用户消息的一轮（WebSocket 内）：

```
client ──▶ {type: "user_message", conversation_id, text}
server: 载入对话历史 + 系统提示 → Eino ChatModelAgent.Query(stream)
loop (ReAct):
  ├─ 模型思考/产出文本增量 ──▶ {type: "token", text}          （流式）
  ├─ 模型决定调用工具 ──▶ {type: "tool_call", name, args}
  │    ├─ guard 双闸校验
  │    ├─ 读工具 → 执行 → {type: "tool_result", ...} → 回喂模型
  │    └─ 写工具 → INTERRUPT：
  │         · 持久化 pending_action + Eino checkpoint 到 ok_ai_messages
  │         · ──▶ {type: "confirm_required", action_preview}
  │         · 等 client ──▶ {type: "confirm", approved: true|false}
  │             ├─ approved → resume：执行写操作 + 审计埋点 → tool_result → 回喂模型
  │             └─ rejected → resume：把「用户拒绝」作为观察结果回喂模型
  └─ 模型给出最终回复 ──▶ {type: "done", assistant_message}
server: 持久化本轮 user/assistant/tool 消息
```

断线容错：pending_action + checkpoint 已落库，客户端重连后可用 `POST /ai/conversations/:id/confirm` 兜底恢复。

## 6. 数据模型（新增 GORM 表，`ok_*`）

- `ok_ai_config`（全局单行）：`id, enabled bool, base_url, api_key(密文，crypto.Cipher 加密), model_id, temperature, system_prompt, max_steps, created_at, updated_at`
- `ok_ai_grants`（每集群）：`id, cluster_id, operations(JSON 资源→[操作]，复用 RoleRule.Operations 格式), created_at, updated_at`
- `ok_ai_conversations`：`id, user_id, cluster_id, title, created_at, updated_at`
- `ok_ai_messages`：`id, conversation_id, role(user|assistant|tool), content(text), tool_calls(JSON), tool_call_id, pending_action(JSON,可空), checkpoint(bytea,可空), created_at`

密钥处理同 kubeconfig：`api_key` 用 `crypto.Cipher` 加密存储；`GET /ai/config` 返回时**不回明文**（仅返回是否已设置的标志与掩码）。

## 7. 接口

| 方法 | 路径 | 准入 | 说明 |
|------|------|------|------|
| GET | `/ai/config` | `ai:view` | 模型配置（apiKey 掩码） |
| PUT | `/ai/config` | `ai:edit` | 保存模型配置（apiKey 留空则保留原值） |
| GET | `/ai/grants?cluster_id=` | `ai:view` | 某集群 AI 权限矩阵 |
| PUT | `/ai/grants?cluster_id=` | `ai:edit` | 保存某集群 AI 权限矩阵 |
| GET | `/ai/status` | 登录 | `{enabled, configured}`，驱动 ⚠️ 状态 |
| GET | `/ai/conversations` | 登录 | 当前用户的对话列表 |
| POST | `/ai/conversations` | 登录 | 新建对话（绑定当前集群） |
| GET | `/ai/conversations/:id` | 本人 | 对话 + 消息 |
| DELETE | `/ai/conversations/:id` | 本人 | 删除对话 |
| GET(WS) | `/ai/chat` | 登录(query token) | 流式跑 agent（见 §5 协议） |
| POST | `/ai/conversations/:id/confirm` | 本人 | 断线兜底：确认/拒绝待确认动作并恢复 |

WS 鉴权与 exec/logs 一致：浏览器原生 WS 无法带 Header，token 走 query 参数，升级前校验。

## 8. RBAC 集成（新增全局区 `ai`）

- 后端 `internal/rbac/resources.go`：`validGlobalAreas` 增加 `"ai"`（动作 view/edit）。
- 前端 `src/api/role.ts`：`GlobalArea` 增加 `'ai'`；`GLOBAL_AREAS`/`SYSTEM_AREAS` 相应加入，角色编辑的全局权限矩阵自动出现「AI」行。
- 菜单派生：`ai:view` → 系统管理下出现「AI 配置」菜单；写操作按 `ai:edit`。
- 预置角色：`集群管理员/admin` 含 `ai:view+edit`；其余按需（种子逻辑更新）。

## 9. AI 工具集（Eino tools）

每个工具 = 名称 + 描述 + JSON Schema 参数 + Run（内含双闸）。v1：

- `list_resources(resource, namespace?)` — 读
- `get_resource(resource, namespace, name)` — 读
- `create_resource(resource, namespace, manifest)` — 写（interrupt）
- `update_resource(resource, namespace, name, manifest)` — 写（interrupt）
- `delete_resource(resource, namespace, name)` — 写（interrupt）

工具在服务端用现有 `cluster.ClusterPool` + dynamic client 执行，资源/动作经现有 `resolveResource`/RBAC 动作映射。（scale/restart/logs 等留作后续增量。）

## 10. 审计

AI 执行的写操作不经公共资源路由，需在 AI 执行路径**显式落审计**（复用 `ok_audit_logs`）：`user_id`=发起用户，`action`=`ai_create|ai_update|ai_delete`，备注「via OmniKube AI」，记录集群/命名空间/资源/名称。

## 11. 前端

- **全局悬浮入口**（右下角）：常驻，点开聊天面板（Drawer）。操作对象 = 顶栏当前集群；未选集群时提示先选集群。
- **⚠️ 未配置态**：`/ai/status` 返回未开启/未配置 → 入口带 ⚠️ 徽标，点击提示「未配置或未开启 AI，请联系管理员开启 AI 功能」（非管理员无配置入口）。
- **聊天面板**：消息流（流式逐字）+ **工具调用步骤轨迹**（可折叠展示 agent 调了哪些工具/结果）+ **待确认卡片**（展示拟执行动作预览，确认/拒绝）+ 历史对话切换/新建/删除。
- **系统管理 › AI 配置**（`ai:view` 可见）：模型配置表单（开关、baseURL、apiKey 掩码写入、modelId、温度/系统提示/最大步数）+ 下方**每集群权限矩阵**（复用 `ResourceOpsMatrix`）。写操作按 `ai:edit`。
- **i18n**：新增文案全部覆盖 7 种语言（zh/en/ja/ko/fr/de/es）。

## 12. 分期（供 writing-plans 拆分）

1. **配置基座**：`ok_ai_*` 数据模型 + `ai` 全局区（前后端）+ `/ai/config`、`/ai/grants`、`/ai/status` + AI 配置页 + ⚠️ 状态 + 悬浮入口壳（未接 agent）。
2. **只读 agent**：接 Eino + OpenAI 兼容 ChatModel + 读工具 + 双闸 + WS 流式 + 聊天面板（能查询）。
3. **写操作 + 确认**：写工具 + interrupt/resume + 待确认卡片 + 审计。
4. **对话持久化 + 历史 UI + i18n + 打磨**。

## 13. 不在本期范围（YAGNI / 后续）

- 命名空间级 AI 授权（v1 整集群）。
- scale/restart/logs 等增量工具。
- 多模型/每集群不同模型（v1 模型全局一份）。
- 对话导出、跨用户共享对话。

## 14. 风险与缓解

- **模型无 tool-calling**：Eino ReAct 依赖工具调用；配置的端点须支持。→ 配置页做一次「连通性+能力探测」，不支持则明确报错。
- **越权/误操作**：双闸 + 写操作强制确认 + 全量审计。
- **提示注入**：工具层永远以服务端双闸为准，绝不因模型「自称有权」而放行；写操作必须用户确认。
- **长循环/失控**：`max_steps` 上限 + WS 可中断。
- **密钥泄露**：apiKey 加密存储、接口不回明文、日志不打印。
