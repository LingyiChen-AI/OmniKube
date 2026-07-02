# 子项目 C — 监控指标(Metrics)设计

> 日期:2026-07-01 · P0-2 · 依赖:集群 metrics-server(本地将安装)、cluster client

## 目标

接入 `metrics.k8s.io`,让节点/Pod 有 CPU、内存实时用量;Node 页展示水位、Pod 列表加用量列、仪表盘加集群资源水位卡片。metrics-server 缺失时优雅降级。

## 非目标

- 不接 Prometheus / 不做历史趋势曲线(P1/P2)。
- 不做容器级细分(仅 Pod / Node 汇总)。

## 前置:本地安装 metrics-server

Docker Desktop k8s 默认无 metrics-server。开发前安装(kubelet 证书自签,需 `--kubelet-insecure-tls`):
- apply 官方 components.yaml,给 Deployment 加 arg `--kubelet-insecure-tls`。
- 验证 `kubectl top nodes` 可用后再开发。

## 架构

新增 `backend/internal/handler/metrics.go`。用集群 client 的 REST 访问 `metrics.k8s.io/v1beta1`(优先用 metricsv1beta1 clientset;或 dynamic client 读 `nodes`/`pods` metrics 资源)。

### 端点(命名空间/集群级只读,view 门控)
- `GET /api/v1/metrics/available` → `{ available: bool }`:检测 APIService `v1beta1.metrics.k8s.io` 是否就绪。前端据此决定是否渲染指标 UI。
- `GET /api/v1/metrics/nodes` → 每节点 `{ name, cpu(mCPU), memory(bytes), cpuCapacity, memCapacity, cpuPct, memPct }`。cap 来自 node.status.allocatable,usage 来自 node metrics;两者 join。
- `GET /api/v1/metrics/pods?namespace=` → 每 Pod `{ namespace, name, cpu(mCPU), memory(bytes) }`(容器求和)。namespace 空则全量(受可见性约束)。

metrics-server 缺失(APIService 不存在或 503)→ 端点返回 `{ available:false, ... }` 或空列表 + 200,前端隐藏指标列/显示「指标不可用,请安装 metrics-server」。

### 单位
- CPU 以 mCPU(毫核)返回整数;内存以 bytes 返回,前端格式化为 Mi/Gi。

## 前端

- `frontend/src/api/metrics.ts`:`available()`、`nodes()`、`pods(namespace?)`。
- Node 页(`pages/cluster/Nodes.tsx`):新增 CPU/内存两列水位条(用量/可分配 + 百分比 Progress);metrics 不可用时列显示「—」或提示。
- Pod 列表(`pages/workloads/Pods.tsx`):新增 CPU(mCPU)、内存(Mi)列;不可用时隐藏。
- 仪表盘(`pages/dashboard/Dashboard.tsx`):新增「集群资源水位」卡片——节点 CPU/内存汇总占比(Progress)。gated:无当前集群或指标不可用时降级。
- i18n:`metrics.*` key 补 7 语。

## 数据流

前端进页 → `metrics/available` 判定 → 若可用则拉 `metrics/nodes` / `metrics/pods` → 与列表 join 渲染水位。

## 测试

`backend/internal/handler/metrics_test.go`:
- available:APIService 存在→true,不存在→false。
- nodes:usage 与 allocatable join 出正确百分比;缺失时降级返回。
- pods:容器 CPU/内存求和;namespace 过滤。
（用 fake clientset / 注入的 metrics 数据脚手架;不可用路径用无 metrics APIService 的 fake。）

前端:Nodes/Pods/Dashboard 组件在「可用/不可用」两态下 render 冒烟。

## 验收

- 装好 metrics-server 后:Node 页有 CPU/内存水位、Pod 列表有用量列、仪表盘有资源水位卡。
- 停用 metrics-server:界面优雅降级不报错。
- 前端 tsc/lint/test/build 全绿;后端 `go test ./...` 全绿。
