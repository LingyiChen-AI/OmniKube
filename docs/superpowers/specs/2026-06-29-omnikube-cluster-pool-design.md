# OmniKube 子项目 B：多集群连接池与集群管理 — 设计文档

> 日期：2026-06-29
> 来源 PRD：`PRD/v2.md` §2.2、§5.1、§5.4（删除集群部分）
> 依赖：子项目 A（已完成）。复用 A 的 `crypto`(AES-GCM)、`model.Cluster`、`database`、JWT 认证中间件。

## 1. 范围

实现**线程安全的多集群连接池**与**集群管理 CRUD**，让平台能动态托管多个 K8S 集群。

**本 spec 覆盖**：
- `ClusterClient`（一组 client-go 客户端）与 `ClusterPool`（RWMutex 池）
- 连接构建 + 连通性自检（Discovery）
- 启动时从 DB 全量重建连接池（解密 kubeconfig）
- 后台定时探活（30s）更新集群健康状态
- 集群管理 API（admin 专属）：添加 / 列表 / 删除 / 更新 / 测试连接
- admin 守卫中间件

**不在本 spec**（留给后续）：
- Casbin 删除集群时的级联清理（C，`casbin_rule` 清理）——B 仅删 DB 记录 + 摘除连接池
- 资源看板 API、`X-Cluster-ID` 路由消费（D）
- RBAC 鉴权（C）

## 2. 已定技术决策

- **client-go 版本**：与目标集群兼容的稳定版（`k8s.io/client-go`、`k8s.io/apimachinery`、`k8s.io/api`）。
- **客户端构建抽象为 builder 函数**：`type ClientBuilder func(kubeconfig string) (*ClusterClient, error)`。生产用真实 builder；单测注入 fake builder + fake `HealthChecker`，**不依赖真实集群**。
- **连通性自检 = `Discovery.ServerVersion()`**（PRD §2.2 第 2 步）。
- **探活间隔 30s**，后台单 goroutine 遍历池。
- **删除集群**：B 阶段只删 DB + 摘除池；Casbin 级联清理在 C 补（spec 中显式标注 TODO 钩子位置）。
- **加密**：入库前用 A 的 `crypto.Cipher` 加密 kubeconfig；出库（启动重建）时解密。

## 3. 组件设计

### 3.1 `internal/cluster/client.go` — ClusterClient 与构建

```go
type ClusterClient struct {
    Typed      kubernetes.Interface
    Dynamic    dynamic.Interface
    Discovery  discovery.DiscoveryInterface
    RESTMapper meta.RESTMapper
    Config     *rest.Config
}

// Ping 连通性探测，调用 Discovery.ServerVersion()。
func (c *ClusterClient) Ping() error

// BuildClient 从 kubeconfig 文本构建整套客户端（生产实现）。
func BuildClient(kubeconfig string) (*ClusterClient, error)
```

- `BuildClient`：`clientcmd.RESTConfigFromKubeConfig([]byte)` → 建 typed/dynamic/discovery；RESTMapper 用 `restmapper.NewDeferredDiscoveryRESTMapper(memory.NewMemCacheClient(disco))`。
- 接口类型（`kubernetes.Interface`/`dynamic.Interface`/`discovery.DiscoveryInterface`）便于 fake 注入。

### 3.2 `internal/cluster/pool.go` — ClusterPool

```go
type ClusterPool struct {
    mu      sync.RWMutex
    clients map[string]*ClusterClient
    build   ClientBuilder        // 可注入
    cipher  *crypto.Cipher
    db      *gorm.DB
}

func NewPool(db *gorm.DB, cipher *crypto.Cipher, build ClientBuilder) *ClusterPool
func (p *ClusterPool) Get(id string) (*ClusterClient, bool)   // 读锁
func (p *ClusterPool) Set(id string, c *ClusterClient)        // 写锁
func (p *ClusterPool) Remove(id string)                       // 写锁
func (p *ClusterPool) IDs() []string                          // 读锁快照

// Rebuild 启动时从 DB 全量重建：解密 kubeconfig → build → 入池；
// 单个集群失败不致命，记录日志并把该集群 Status 置 Unreachable。
func (p *ClusterPool) Rebuild() error

// AddCluster 添加流程：build(明文) → Ping 自检 → 加密落库 → 入池（事务）。
func (p *ClusterPool) AddCluster(id, name, kubeconfig string) error

// DeleteCluster：删 DB + 摘除池（C 阶段在此追加 Casbin 级联）。
func (p *ClusterPool) DeleteCluster(id string) error
```

### 3.3 `internal/cluster/health.go` — 探活

```go
// StartHealthChecker 启动后台 goroutine，每 interval 遍历池，
// Ping 成功→Healthy 失败→Unreachable，更新 ok_clusters.Status + LastCheck。
// 返回 stop func（供测试/优雅关停）。
func StartHealthChecker(p *ClusterPool, db *gorm.DB, interval time.Duration) (stop func())
```

### 3.4 `internal/middleware/admin.go` — admin 守卫

```go
// RequireAdmin 读取 A 注入的 is_admin，非 admin 返回 403。
func RequireAdmin() gin.HandlerFunc
```

### 3.5 `internal/handler/cluster.go` — 集群管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/clusters` | 添加集群：body `{id,name,kubeconfig}` → AddCluster |
| GET | `/api/v1/clusters` | 列表（DB 读，含 Status/LastCheck；不返回 kubeconfig 密文）|
| DELETE | `/api/v1/clusters/:id` | DeleteCluster |
| PUT | `/api/v1/clusters/:id` | 更新 name/kubeconfig（换 kubeconfig 时重建客户端）|
| POST | `/api/v1/clusters/test` | 测试连接：body `{kubeconfig}` → build+Ping，不落库 |

全部挂在 `JWTAuth + RequireAdmin` 之下。

## 4. 数据流

- **添加**：前端提交明文 kubeconfig → `BuildClient` → `Ping` 自检 → 失败则 400「集群连接失败」；成功则 `cipher.Encrypt` → DB 落库（Status=Healthy, LastCheck=now）→ 入池。
- **启动**：main 中 `pool.Rebuild()` → 逐集群解密+build+入池；随后 `StartHealthChecker`。
- **探活**：每 30s 更新 DB 状态；前端列表读到最新 Status。
- **删除**：写锁摘除池 + 删 DB（事务）。

## 5. 错误处理

- 添加/测试连接失败 → 400 `{"code":400,"message":"集群连接失败: <原因>"}`。
- 重复 ID → 409 `{"code":409,"message":"集群标识已存在"}`。
- 非 admin → 403。
- 删除不存在 → 404。

## 6. 测试策略（TDD）

- **pool_test.go**：注入 fake builder（返回带 fake discovery 的 stub client）。测 Set/Get/Remove/IDs、并发读写无 race（`-race`，多 goroutine）、AddCluster 成功落库+入池、AddCluster 自检失败不落库、DeleteCluster 清池清库、Rebuild 从 DB 解密重建、重复 ID 报错。用内存 sqlite + 真实 `crypto.Cipher`（32 字节 key）。
- **health_test.go**：注入两个 fake client（一个 Ping 成功、一个失败），手动触发一轮，断言 DB Status 分别为 Healthy/Unreachable。
- **admin middleware_test.go**：is_admin=true 放行、false→403、缺失→403。
- **handler/cluster_test.go**：sqlite + fake pool，测各端点状态码与 DB 副作用；非 admin 403。
- fake K8S 客户端用 `client-go` 的 `fake.NewSimpleClientset()`、`dynamicfake.NewSimpleDynamicClient()`、`discoveryfake`；`Ping` 的成功/失败用可控 fake discovery（返回 version 或 error）。

## 7. 验收标准

1. `go build ./... && go test ./... -race` 全绿。
2. 注入 fake builder 时，pool 的 CRUD/Rebuild/并发安全均通过单测。
3. 真实集群手动验证：用真实 kubeconfig 调 `POST /clusters/test` 返回连通；`POST /clusters` 落库且 `GET /clusters` 显示 Healthy；删除后池与库均清除。
4. 探活 goroutine 能把不可达集群标记为 Unreachable。
5. 非 admin 调用集群 API 一律 403。

## 8. 对 A 的改动

- `main.go`：构建 `crypto.Cipher`、`cluster.NewPool`、`pool.Rebuild()`、`StartHealthChecker`，并把 pool 注入集群 handler；注册集群路由（JWTAuth+RequireAdmin）。
