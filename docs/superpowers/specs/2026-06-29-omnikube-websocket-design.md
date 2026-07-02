# OmniKube 子项目 E：WebSocket（WebSSH + 实时日志流）— 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md` §8（WebSocket 鉴权）、§5.3（WebSSH/实时日志）、§4.3（exec 动作）
> 依赖：A、B、C、D（均已完成）。复用 `auth.JWTManager`、`rbac.Service.Authorize`、`cluster.ClusterPool`/`ClusterClient`（`Typed`+`Config`）、`audit.Log`、`model.User`（IsAdmin 旁路）。

## 1. 范围

实现两条 WebSocket 流，**握手前完成鉴权**（PRD §8）：
1. **WebSSH（exec）**：进容器交互式终端，动作 `exec`。
2. **实时日志流**：`kubectl logs -f` 推流，动作 `read`。

浏览器原生 WebSocket 无法自定义 Header，故 `cluster_id` / `namespace` / token 等经 **query 参数**传递。

**本 spec 覆盖**：升级前鉴权、exec 双向流（remotecommand SPDY ↔ ws）、日志流、强制审计、终端 resize。

## 2. 连接与鉴权（PRD §8）

### 端点
- WebSSH：`GET /api/v1/exec?cluster_id=&namespace=&pod=&container=&token=<jwt>`
- 日志流：`GET /api/v1/logs?cluster_id=&namespace=&pod=&container=&token=<jwt>&follow=true&tail=200`

二者**不挂常规 `JWTAuth`/`RBACAuthMiddleware`**（它们读 Header），各自 handler 自行从 query 鉴权。

### 升级前鉴权顺序（在 `Upgrade` 之前完成；任一不过直接 HTTP 403/401/400，不进入 stream）
1. 解析 query；缺 `cluster_id`/`pod`/`token`（exec 还需可定位容器）→ 400。
2. `jwt.Parse(token)` → `userID`/`isAdmin`；失败 → 401。**token 仅用于校验，绝不写入日志/审计**（审计只记 userID）。
3. 校验 `cluster_id` 在连接池存在 → 否则 400。
4. 鉴权（系统 admin 旁路）：
   - exec：`rbac.Authorize(userID, clusterID, namespace, "pods", "exec")`
   - logs：`rbac.Authorize(userID, clusterID, namespace, "pods", "read")`
   - 不通过 → 403 + 写 deny 审计，**不升级握手**。
5. 通过后再 `Upgrade`。

> userID 传给 `Authorize` 用与 C/D 相同的 `strconv.FormatUint(uint64(uid),10)` 形式。

## 3. WebSSH 执行（`internal/ws/exec.go`）

- 用 `ClusterClient.Config` + `remotecommand.NewSPDYExecutor` 对 `pods/<pod>/exec`（`core/v1` POST，SubResource("exec")，`PodExecOptions{Container, Command:["/bin/sh","-c","exec /bin/bash || exec /bin/sh"], Stdin/Stdout/Stderr:true, TTY:true}`）。
- 用 gorilla/websocket 升级；构造 `remotecommand.StreamOptions{Stdin, Stdout, Stderr, Tty:true, TerminalSizeQueue}`，其中 Stdin/Stdout 由一个 **ws↔io 适配器**桥接：
  - ws→容器 stdin：读 ws 文本/二进制消息写入 stdin pipe。
  - 容器 stdout/stderr→ws：写入 ws。
  - **resize**：约定 ws 上的控制消息（JSON `{"type":"resize","cols":..,"rows":..}`）driving `TerminalSizeQueue`；普通消息为键盘输入。
- 会话结束（流关闭/出错/ws 断开）清理 goroutine 与管道。

## 4. 日志流（`internal/ws/logs.go`）

- `Typed.CoreV1().Pods(ns).GetLogs(pod, &corev1.PodLogOptions{Container, Follow:follow, TailLines:tail}).Stream(ctx)` → `io.ReadCloser`。
- 逐块读取写入 ws；ws 关闭或客户端断开 → cancel ctx 停止流。

## 5. 审计（强制）

- **WebSSH 会话**：建立成功写一条 `audit.Entry{Action:"exec", Resource:"pods", Target:"pod/"+pod+"/"+container, Result:"allow", Namespace, ClusterID, UserID, SourceIP}`；会话结束可再记一条（起止）。鉴权拒绝写 `Result:"deny"`。
- **日志流**：放行写 `Action:"read"` 审计（可选，PRD 重点在 exec/reveal，但日志流也记一条 allow 便于留痕）；拒绝写 deny。

## 6. 路由装配

```
api/v1 (无 Header 中间件，handler 内 query 鉴权):
  GET /exec  → ExecHandler
  GET /logs  → LogHandler
```

`main.go` 注入 `JWTManager`、`Pool`、`RBAC`、`DB` 到 ws handler。

## 7. 依赖

`go get github.com/gorilla/websocket`。`remotecommand` 来自既有 client-go。

## 8. 测试策略（TDD）

WebSocket + SPDY exec 难以纯单测，**重点测「升级前鉴权门」**（不实际 upgrade，handler 在鉴权失败时返回 HTTP 状态码）：
- **缺参数** → 400。
- **坏 token** → 401。
- **不存在的 cluster_id** → 400。
- **无 exec 权限**（NS-Viewer 调 exec）→ 403 且写一条 deny 审计；**有 exec 权限**（NS-Editor）→ 通过鉴权门（测试在 upgrade 前用一个可注入的 hook 断言「已授权」，或用 httptest 客户端发起真实 ws 握手并断言 101 vs 403）。
- **日志流**：NS-Viewer（有 read）→ 通过；无任何绑定 → 403。
- **token 不入审计**：断言写入的 audit 行的任何字段都不含 token 值。
- 用 `httptest.NewServer` + `gorilla/websocket` Dialer 做握手层测试：授权失败时 Dial 返回 403（`websocket.ErrBadHandshake` + resp.StatusCode==403）；授权成功时握手 101（之后可立即关闭，不依赖真实 K8S exec）。为此把「鉴权」与「真正启动 exec/log 流」解耦：鉴权通过 → 升级 → 若 stream 启动失败（fake/无真实集群）则发一条 ws 错误消息并关闭，握手本身已成功（101）。
- rbac 绑定经真实 `rbac.Service` 种子，端到端校验。

## 9. 验收标准

1. `go build ./... && go test ./... -race` 全绿。
2. 升级前鉴权门：缺参 400 / 坏 token 401 / 无权 403（且 deny 审计）/ 有权 101。
3. WebSSH 放行写 exec 审计；日志流放行写 read 审计；token 不出现在审计任何字段。
4. exec 用 `exec` 动作、日志用 `read` 动作（不被 write 覆盖）。

## 10. 对既有代码的改动

- 新增 `internal/ws/{exec.go, logs.go, auth.go}`（`auth.go` 放共用的 query 鉴权门 `authorizeWS`）。
- `router.go`：注册 `/exec`、`/logs`。
- `main.go`：注入依赖（已有 Handler 持 Pool/RBAC/DB/JWT，可复用或单独构造 ws handler）。
