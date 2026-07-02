package app

import (
	"github.com/gin-gonic/gin"
	"github.com/google/wire"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/captcha"
	"omnikube/internal/cluster"
	"omnikube/internal/config"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/handler"
	"omnikube/internal/rbac"
	"omnikube/internal/router"
)

// App 是 wire 构建出的应用聚合，持有 main 在运行期需要的组件。
// 注意：pool.OnDelete ← rbac 的交叉接线（pool↔rbac 成环）与健康探活等运行期副作用，
// 由 main 在 wire 构建之后完成，不放进依赖图。
type App struct {
	Cfg    *config.Config
	DB     *gorm.DB
	Engine *gin.Engine
	Pool   *cluster.ClusterPool
	RBAC   *rbac.Service
}

// ProviderSet 是 wire 的 provider 集合。
var ProviderSet = wire.NewSet(
	provideDB,
	provideCipher,
	provideJWT,
	providePool,
	provideRBAC,
	provideHandler,
	provideEngine,
	provideApp,
)

func provideDB(cfg *config.Config) (*gorm.DB, error) {
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := database.Migrate(db); err != nil {
		return nil, err
	}
	if err := database.BootstrapAdmin(db, cfg.AdminUsername); err != nil {
		return nil, err
	}
	return db, nil
}

func provideCipher(cfg *config.Config) (*crypto.Cipher, error) {
	return crypto.New(cfg.MasterKey)
}

func provideJWT(cfg *config.Config) *auth.JWTManager {
	return auth.NewJWTManager(cfg.JWTSecret, cfg.JWTExpiry)
}

func providePool(db *gorm.DB, cipher *crypto.Cipher) (*cluster.ClusterPool, error) {
	pool := cluster.NewPool(db, cipher, cluster.BuildClient)
	if err := pool.Rebuild(); err != nil {
		return nil, err
	}
	return pool, nil
}

func provideRBAC(db *gorm.DB, pool *cluster.ClusterPool) (*rbac.Service, error) {
	return rbac.NewService(db, pool)
}

func provideHandler(db *gorm.DB, jm *auth.JWTManager, pool *cluster.ClusterPool, rbacSvc *rbac.Service) *handler.Handler {
	return &handler.Handler{DB: db, JWT: jm, Pool: pool, RBAC: rbacSvc, Captcha: captcha.NewStore()}
}

func provideEngine(h *handler.Handler, jm *auth.JWTManager) *gin.Engine {
	return router.New(h, jm)
}

func provideApp(cfg *config.Config, db *gorm.DB, engine *gin.Engine, pool *cluster.ClusterPool, rbacSvc *rbac.Service) *App {
	return &App{Cfg: cfg, DB: db, Engine: engine, Pool: pool, RBAC: rbacSvc}
}
