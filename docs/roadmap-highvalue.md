# OmniKube 高价值路线图

> 生成于 2026-07-04。基于对现有代码的实际核对,盘点「面向真实生产可用」还缺什么,并排定优先级。

## 现状盘点(已完成)

多集群纳管(kubeconfig AES-256-GCM 加密、连接测试)· 工作负载全生命周期(Deploy/STS/DS/Pod/Job/CronJob 列表/详情/可视化创建/YAML 编辑、伸缩/滚动重启/版本历史+回滚/事件)· 网络(Service/Ingress)/存储(ConfigMap/Secret/PVC/PV)/节点 · WebSSH + 实时日志 · metrics-server 用量 · **RBAC v3**(用户/角色/集群,全局区域 + 每资源×操作矩阵,Casbin 域隔离)· 审计中心 · 发布记录 + 发布通知(钉钉/飞书/企业微信)· **AI 助手**(Eino ReAct,流式,两阶段确认)· **集成部署**(工单打包 + 固定顺序发布 + WebSocket 实时流 + 挂载自动识别)· i18n×7 · 明暗主题 · 全列表后端分页。

## 确认的高价值缺口(已核对代码,确实未做)

| # | 缺口 | 为什么高价值 | 架构契合度 | 工作量 |
|---|---|---|---|---|
| 1 | **通用资源 / CRD 支持** | 目前仅支持 **13 种硬编码资源**(`rbac.moduleResources`)。真实集群里大量是 CRD(Istio / cert-manager / ArgoCD / Prometheus Operator / 自研 operator),现在完全管不了。这是走向「能管真实生产集群」的最大门槛。 | 高 —— 已有 dynamic client + discovery + RESTMapper | 中-高 |
| 2 | **集群事件 / 告警中心** | 「集群现在哪里出问题」是运维第一诉求。现在只能钻进单个资源看 events;没有 CrashLoopBackOff / OOMKilled / FailedScheduling / 拉镜像失败 的集群级聚合视图。可接入 AI「诊断为什么出错」。 | 高 | 中 |
| 3 | **HPA 自动伸缩管理** | 最常用的 k8s 资源之一,workload 管理里明显的洞;还能在部署详情展示伸缩状态。 | 高(就是加一种资源) | 低(快速见效) |
| 4 | **命名空间生命周期 + 配额** | 现在 namespace 只是只读筛选器;不能建/删 ns、看不了 ResourceQuota / LimitRange。 | 中 | 低-中 |
| 5 | **Helm 应用管理** | 部署/升级/回滚 Helm release,values 编辑 + 历史,生态刚需。 | 高 | 高 |

## 其它候选(Tier 2/3)

- 监控集成(Prometheus 历史指标 + 图表)· k8s 原生 RBAC 查看(SA/Role/ClusterRole/Binding)· Pod 排障工具箱(上一容器日志 / describe / ephemeral debug)· 批量操作 · 工作负载健康标记(重启次数 / CrashLoop 徽标)· 多集群资源搜索 · SSO/OIDC 登录 · 2FA · 编程访问 Token。

## 执行顺序(本路线图)

1. ~~**通用资源 / CRD 支持**~~ ✅ 已完成(粗粒度 `customresources` 权限 + `GET /api-resources` 发现端点 + 「API 资源」通用浏览页 + AI 同步放开;spec/plan 见 `docs/superpowers/`)
2. 集群事件 / 告警中心(← 下一项)
3. HPA 自动伸缩管理
4. 命名空间生命周期 + 配额
5. Helm 应用管理

> 每一项都走 brainstorm → 设计 spec → 实现计划 → 实现(subagent 驱动)。设计与计划文档见 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。
