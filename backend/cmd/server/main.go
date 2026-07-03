package main

import (
	"flag"
	"log"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

	"omnikube/internal/app"
	"omnikube/internal/cluster"
	"omnikube/internal/config"
)

// version is stamped at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	cfgPath := flag.String("config", "config.yaml", "配置文件路径 (YAML)")
	flag.Parse()

	_ = godotenv.Load() // 可选: 从 .env 注入敏感项环境变量覆盖

	// 默认 release 模式，消除生产 debug 日志/告警；开发可设 GIN_MODE=debug 覆盖。
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	// wire 构建静态依赖图（含 DB 迁移+admin 自举、连接池重建、RBAC 角色种子）。
	application, err := app.InitializeApp(cfg)
	if err != nil {
		log.Fatalf("应用初始化失败: %v", err)
	}

	// 运行期交叉接线与生命周期（不放进 wire 依赖图）：
	// 1) 级联清理回调（pool↔rbac 成环，构建后再接）。
	application.Pool.OnDelete = application.RBAC.RemoveClusterPolicies
	// 2) 后台定时探活。
	stopHealth := cluster.StartHealthChecker(application.Pool, application.DB, 30*time.Second)
	defer stopHealth()

	log.Printf("OmniKube %s 监听 :%s", version, cfg.ServerPort)
	if err := application.Engine.Run(":" + cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
