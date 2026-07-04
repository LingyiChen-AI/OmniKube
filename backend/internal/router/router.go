package router

import (
	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
	"omnikube/internal/handler"
	"omnikube/internal/middleware"
	"omnikube/internal/web"
	"omnikube/internal/ws"
)

func New(h *handler.Handler, jm *auth.JWTManager) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", h.Healthz)
	api := r.Group("/api/v1")
	{
		api.GET("/captcha", h.GetCaptcha)
		api.POST("/login", h.Login)

		// WebSocket 流（WebSSH / 实时日志）：不挂 Header 中间件，handler 内从
		// query 参数完成升级前鉴权（PRD §8）。浏览器原生 WebSocket 无法自定义 Header。
		wsh := &ws.Handler{DB: h.DB, JWT: jm, Pool: h.Pool, RBAC: h.RBAC, Cipher: h.Cipher}
		api.GET("/exec", wsh.ExecHandler)
		api.GET("/logs", wsh.LogHandler)
		// AI 助手流式对话：同为 query-token 鉴权的 WebSocket，不挂 Header 中间件。
		api.GET("/ai/chat", wsh.AIChatHandler)

		authed := api.Group("")
		authed.Use(middleware.JWTAuth(jm))
		// 写操作自动审计(POST/PUT/DELETE)。挂在 JWTAuth 之后, 依赖 user_id。
		authed.Use(middleware.Audit(h.DB))
		{
			authed.POST("/change-password", h.ChangePassword)
			authed.GET("/me", h.Me)
			authed.GET("/me/capabilities", h.MyCapabilities)
			// 当前用户可访问的集群（所有登录用户，非管理员专属）
			authed.GET("/my/clusters", h.MyClusters)

			// 发布记录：JWTAuth + global-perm releases:view（admin 旁路）。
			authed.GET("/releases", middleware.RequireGlobalPerm(h.GlobalPermCheck, "releases", "view"), h.ListReleases)

			// 集成部署:JWTAuth + global-perm integrated_deploy:<action>(admin 旁路)。
			authed.GET("/integrated-deploy/orders", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.ListDeployOrders)
			authed.POST("/integrated-deploy/orders", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "create"), h.CreateDeployOrder)
			authed.GET("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.GetDeployOrder)
			authed.PUT("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "edit"), h.UpdateDeployOrder)
			authed.DELETE("/integrated-deploy/orders/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "delete"), h.DeleteDeployOrder)
			authed.POST("/integrated-deploy/orders/:id/copy", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "create"), h.CopyDeployOrder)
			authed.POST("/integrated-deploy/orders/:id/publish", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "publish"), h.PublishDeployOrder)
			authed.GET("/integrated-deploy/namespaces", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.ListDeployNamespaces)
			authed.GET("/integrated-deploy/selectable", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.ListSelectable)
			authed.GET("/integrated-deploy/snapshot", middleware.RequireGlobalPerm(h.GlobalPermCheck, "integrated_deploy", "view"), h.SnapshotResource)

			// 审计日志：JWTAuth + global-perm audit:view（admin 旁路）。
			authed.GET("/audit-logs", middleware.RequireGlobalPerm(h.GlobalPermCheck, "audit", "view"), h.ListAuditLogs)
			authed.GET("/audit-logs/export", middleware.RequireGlobalPerm(h.GlobalPermCheck, "audit", "view"), h.ExportAuditLogs)

			// AI 助手：状态任意登录用户可读（驱动 ⚠️ 态）；模型配置按 global-perm ai。
			// 权限不再单独配置，一律跟随发起用户自身 RBAC（见 internal/ai/guard.go）。
			authed.GET("/ai/status", h.GetAIStatus)
			authed.GET("/ai/config", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "view"), h.GetAIConfig)
			authed.PUT("/ai/config", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "edit"), h.PutAIConfig)
			// AI 启用/停用开关：单独授权（ai:create），与模型配置编辑(ai:edit)分离。
			authed.PUT("/ai/enabled", middleware.RequireGlobalPerm(h.GlobalPermCheck, "ai", "create"), h.PutAIEnabled)

			// AI 会话 REST：任意登录用户可用；GetConversation 在 handler 内强制归属校验。
			authed.GET("/ai/conversations", h.ListConversations)
			authed.POST("/ai/conversations", h.CreateConversation)
			authed.GET("/ai/conversations/:id", h.GetConversation)
			// 确认/取消上一轮暂存的 AI 写操作（WS 断线兜底；handler 内强制归属校验）。
			authed.POST("/ai/conversations/:id/confirm", h.ConfirmConversation)

			// 集群管理：JWTAuth + per-端点 global-perm（admin 旁路；注意 /my/clusters 不在此组）
			clusters := authed.Group("/clusters")
			{
				clusters.POST("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "clusters", "create"), h.CreateCluster)
				clusters.GET("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "clusters", "view"), h.ListClusters)
				clusters.DELETE("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "clusters", "delete"), h.DeleteCluster)
				clusters.PUT("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "clusters", "edit"), h.UpdateCluster)
				clusters.POST("/test", middleware.RequireGlobalPerm(h.GlobalPermCheck, "clusters", "create"), h.TestCluster)
			}

			// 用户管理：JWTAuth + per-端点 global-perm（admin 旁路）
			users := authed.Group("/users")
			{
				users.POST("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "create"), h.CreateUser)
				users.GET("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "view"), h.ListUsers)
				users.PUT("/:id/disable", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "edit"), h.DisableUser)
				users.PUT("/:id/enable", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "edit"), h.EnableUser)
				users.PUT("/:id/roles", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "edit"), h.SetUserRoles)
				// 重置密码：仅系统管理员可用（敏感操作，不下放给 users:edit）。
				users.POST("/:id/reset-password", middleware.RequireAdmin(), h.ResetUserPassword)
				users.DELETE("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "users", "delete"), h.DeleteUser)
			}

			// 角色管理：JWTAuth + per-端点 global-perm（admin 旁路；子项目 G）
			roles := authed.Group("/roles")
			{
				roles.POST("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "roles", "create"), h.CreateRole)
				roles.GET("", middleware.RequireGlobalPerm(h.GlobalPermCheck, "roles", "view"), h.ListRoles)
				roles.GET("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "roles", "view"), h.GetRole)
				roles.PUT("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "roles", "edit"), h.UpdateRole)
				roles.DELETE("/:id", middleware.RequireGlobalPerm(h.GlobalPermCheck, "roles", "delete"), h.DeleteRole)
			}

			// NS 下拉数据权限：JWTAuth + 有效 X-Cluster-ID（handler 内校验）。
			authed.GET("/namespaces", h.ListNamespaces)

			// 监控指标：JWTAuth + 有效 X-Cluster-ID（handler 内校验）。metrics-server 缺失时优雅降级。
			authed.GET("/metrics/available", h.MetricsAvailable)
			authed.GET("/metrics/nodes", h.NodeMetrics)
			authed.GET("/metrics/pods", h.PodMetrics)

			// Secret 揭示：独立 reveal 动作鉴权 + 强制审计，不经通用 RBAC 中间件。
			// 用 :resource（handler 内约束为 secrets）而非静态段，避免与通用资源
			// 路由的 :resource 通配符在 gin 路由树同层冲突。
			authed.POST("/namespaces/:namespace/resources/:resource/:name/reveal", h.RevealSecret)

			// 通用动态资源：JWTAuth + RBACAuthMiddleware。
			res := authed.Group("")
			res.Use(middleware.RBACAuthMiddleware(h.Pool, h.RBAC, h.DB))
			{
				res.GET("/resources/:resource", h.ListResource)
				res.GET("/namespaces/:namespace/resources/:resource/:name", h.GetResource)
				res.POST("/namespaces/:namespace/resources/:resource", h.CreateResource)
				res.PUT("/namespaces/:namespace/resources/:resource/:name", h.UpdateResource)
				res.DELETE("/namespaces/:namespace/resources/:resource/:name", h.DeleteResource)

				// 工作负载运维动作。scale/restart/rollback 用 PUT → RBAC 映射为 write(edit)；
				// revisions/events 为 GET → read(view)。均自动进审计(scale/restart/rollback)。
				res.PUT("/namespaces/:namespace/resources/:resource/:name/scale", h.ScaleWorkload)
				res.PUT("/namespaces/:namespace/resources/:resource/:name/restart", h.RestartWorkload)
				res.PUT("/namespaces/:namespace/resources/:resource/:name/rollback", h.RollbackWorkload)
				res.PUT("/namespaces/:namespace/resources/:resource/:name/trigger", h.TriggerCronJob)
				res.GET("/namespaces/:namespace/resources/:resource/:name/revisions", h.ListRevisions)
				res.GET("/namespaces/:namespace/resources/:resource/:name/events", h.ResourceEvents)
				// 集群型资源写操作（namespace 恒为 ""）。
				res.POST("/resources/:resource", h.CreateResource)
				res.PUT("/resources/:resource/:name", h.UpdateResource)
				res.DELETE("/resources/:resource/:name", h.DeleteResource)
			}
		}
	}

	// Serve the embedded React SPA (static assets + client-side-route fallback)
	// for every non-API path, so the whole app ships as one binary / one port.
	web.Register(r)
	return r
}
