# OmniKube 后端地基（子项目 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 OmniKube 最小可运行后端：连接 PostgreSQL、迁移建表、首启自举 admin、完成登录/改密/查当前用户。

**Architecture:** 标准 Go layout（`cmd/` + `internal/`）。`internal` 下按职责分包：config / crypto / auth / model / database / middleware / handler / router。纯逻辑包（crypto/auth）不依赖框架；handler 依赖 auth/database；main 做装配。

**Tech Stack:** Go 1.22+、Gin、GORM + postgres driver、golang-jwt/jwt v5、x/crypto/bcrypt、joho/godotenv。测试用 glebarez/sqlite（纯 Go、内存库）注入，无需真实 PG。

模块路径：`omnikube`（`go mod init omnikube`）。

> **Monorepo 布局（重要）**：仓库根 `OmniKube/` 下后端在 `backend/`、前端（子项目 F）将在 `frontend/`，git 仓库在根目录。
> **本计划所有 Go 文件路径都相对 `backend/`，所有 `go` 命令都在 `backend/` 目录下执行。** 例如 `internal/config/config.go` 实际为 `backend/internal/config/config.go`；`go test ./internal/config/` 需先 `cd backend`。
> Task 1 的脚手架已完成并已迁入 `backend/`（go.mod/cmd/internal 等都在 `backend/` 下，根目录有共用 `.gitignore`）。从 Task 2 起在 `backend/` 内继续。

---

## 文件结构（均相对 `backend/`）

| 文件 | 职责 |
|---|---|
| `cmd/server/main.go` | 装配：配置→连库→迁移→自举→启动 |
| `internal/config/config.go` | 环境变量加载 + 校验 |
| `internal/crypto/crypto.go` | AES-256-GCM 加解密 |
| `internal/auth/password.go` | bcrypt 哈希/校验 |
| `internal/auth/jwt.go` | JWT 签发/解析 |
| `internal/model/model.go` | GORM 模型（4 张表）|
| `internal/database/database.go` | 连库 / 迁移 / admin 自举 |
| `internal/middleware/auth.go` | JWT 认证中间件 |
| `internal/handler/handler.go` | Handler 结构 + healthz |
| `internal/handler/auth.go` | login / change-password / me |
| `internal/router/router.go` | 路由注册 |

---

## Task 1: 项目脚手架与最小服务

**Files:**
- Create: `go.mod`, `.env.example`, `.gitignore`, `cmd/server/main.go`, `internal/handler/handler.go`, `internal/router/router.go`

- [ ] **Step 1: 初始化 git 与 go module**

Run:
```bash
cd /Users/chenhao/codes/myself/OmniKube
git init
go mod init omnikube
go get github.com/gin-gonic/gin@latest
```
Expected: 生成 `go.mod`，下载 gin。

- [ ] **Step 2: 写 `.gitignore` 与 `.env.example`**

`.gitignore`:
```
/.env
/server
*.test
/tmp/
```

`.env.example`:
```
DATABASE_URL=postgres://omnikube:omnikube@localhost:5432/omnikube?sslmode=disable
JWT_SECRET=change-me-to-a-long-random-string
# base64 编码的 32 字节，可用: openssl rand -base64 32
MASTER_KEY=
JWT_EXPIRY=2h
SERVER_PORT=8080
ADMIN_USERNAME=admin
```

- [ ] **Step 3: 写最小 Handler 与 healthz（临时不依赖 DB）**

`internal/handler/handler.go`:
```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/auth"
)

type Handler struct {
	DB  *gorm.DB
	JWT *auth.JWTManager
}

func (h *Handler) Healthz(c *gin.Context) {
	if h.DB != nil {
		sqlDB, err := h.DB.DB()
		if err != nil || sqlDB.Ping() != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "db unavailable"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
```
> 注：此文件 import 了 `auth` 与 `gorm`，它们在 Task 5/Task 6 后才存在。本任务先只放 `Healthz` 能编译所需的最小内容——若此刻 `auth` 包不存在会编译失败，因此**本步骤先用下方临时版**，Task 7 完成后再替换为上方完整版。

临时版 `internal/handler/handler.go`（本任务用）:
```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Handler struct{}

func (h *Handler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
```

- [ ] **Step 4: 写临时路由与 main**

`internal/router/router.go`（临时版）:
```go
package router

import (
	"github.com/gin-gonic/gin"

	"omnikube/internal/handler"
)

func New(h *handler.Handler) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", h.Healthz)
	return r
}
```

`cmd/server/main.go`（临时版）:
```go
package main

import (
	"log"

	"omnikube/internal/handler"
	"omnikube/internal/router"
)

func main() {
	h := &handler.Handler{}
	r := router.New(h)
	log.Printf("OmniKube 监听 :8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
```

- [ ] **Step 5: 编译并手动验证**

Run:
```bash
go mod tidy
go build ./...
go run cmd/server/main.go &
sleep 2 && curl -s localhost:8080/healthz && kill %1
```
Expected: `go build` 无错误；curl 返回 `{"status":"ok"}`。

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: scaffold omnikube backend with healthz"
```

---

## Task 2: config 包

**Files:**
- Create: `internal/config/config.go`, `internal/config/config_test.go`

- [ ] **Step 1: 写失败测试**

`internal/config/config_test.go`:
```go
package config

import (
	"encoding/base64"
	"testing"
)

func setEnv(t *testing.T, kv map[string]string) {
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func validKey() string {
	return base64.StdEncoding.EncodeToString(make([]byte, 32))
}

func TestLoad_Success(t *testing.T) {
	setEnv(t, map[string]string{
		"DATABASE_URL": "postgres://x",
		"JWT_SECRET":   "s",
		"MASTER_KEY":   validKey(),
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.MasterKey) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(cfg.MasterKey))
	}
	if cfg.ServerPort != "8080" {
		t.Fatalf("expected default port 8080, got %s", cfg.ServerPort)
	}
}

func TestLoad_MissingDB(t *testing.T) {
	setEnv(t, map[string]string{"JWT_SECRET": "s", "MASTER_KEY": validKey()})
	if _, err := Load(); err == nil {
		t.Fatal("expected error for missing DATABASE_URL")
	}
}

func TestLoad_BadMasterKeyLength(t *testing.T) {
	setEnv(t, map[string]string{
		"DATABASE_URL": "postgres://x",
		"JWT_SECRET":   "s",
		"MASTER_KEY":   base64.StdEncoding.EncodeToString(make([]byte, 16)),
	})
	if _, err := Load(); err == nil {
		t.Fatal("expected error for 16-byte key")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/config/ -v`
Expected: FAIL（`Load` undefined）。

- [ ] **Step 3: 写实现**

`internal/config/config.go`:
```go
package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"time"
)

type Config struct {
	DatabaseURL   string
	JWTSecret     string
	MasterKey     []byte
	JWTExpiry     time.Duration
	ServerPort    string
	AdminUsername string
}

func Load() (*Config, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}
	mkEnc := os.Getenv("MASTER_KEY")
	if mkEnc == "" {
		return nil, fmt.Errorf("MASTER_KEY is required")
	}
	masterKey, err := base64.StdEncoding.DecodeString(mkEnc)
	if err != nil {
		return nil, fmt.Errorf("MASTER_KEY must be valid base64: %w", err)
	}
	if len(masterKey) != 32 {
		return nil, fmt.Errorf("MASTER_KEY must decode to 32 bytes, got %d", len(masterKey))
	}
	expiry := 2 * time.Hour
	if v := os.Getenv("JWT_EXPIRY"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("JWT_EXPIRY invalid: %w", err)
		}
		expiry = d
	}
	port := os.Getenv("SERVER_PORT")
	if port == "" {
		port = "8080"
	}
	admin := os.Getenv("ADMIN_USERNAME")
	if admin == "" {
		admin = "admin"
	}
	return &Config{
		DatabaseURL:   dbURL,
		JWTSecret:     jwtSecret,
		MasterKey:     masterKey,
		JWTExpiry:     expiry,
		ServerPort:    port,
		AdminUsername: admin,
	}, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/config/ -v`
Expected: PASS（3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add internal/config/
git commit -m "feat: add config loader with env validation"
```

---

## Task 3: crypto 包（AES-256-GCM）

**Files:**
- Create: `internal/crypto/crypto.go`, `internal/crypto/crypto_test.go`

- [ ] **Step 1: 写失败测试**

`internal/crypto/crypto_test.go`:
```go
package crypto

import "testing"

func key32() []byte { return make([]byte, 32) }

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	c, err := New(key32())
	if err != nil {
		t.Fatal(err)
	}
	plain := "kubeconfig-secret-content"
	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("round trip mismatch: got %q want %q", got, plain)
	}
}

func TestEncrypt_NonceUnique(t *testing.T) {
	c, _ := New(key32())
	a, _ := c.Encrypt("same")
	b, _ := c.Encrypt("same")
	if a == b {
		t.Fatal("two encryptions of same plaintext must differ (random nonce)")
	}
}

func TestDecrypt_WrongKeyFails(t *testing.T) {
	c1, _ := New(key32())
	enc, _ := c1.Encrypt("data")
	other := make([]byte, 32)
	other[0] = 1
	c2, _ := New(other)
	if _, err := c2.Decrypt(enc); err == nil {
		t.Fatal("expected decryption with wrong key to fail")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/crypto/ -v`
Expected: FAIL（`New` undefined）。

- [ ] **Step 3: 写实现**

`internal/crypto/crypto.go`:
```go
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
)

type Cipher struct {
	gcm cipher.AEAD
}

// New 用 32 字节密钥构造 AES-256-GCM 加密器。
func New(key []byte) (*Cipher, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{gcm: gcm}, nil
}

// Encrypt 返回 base64(nonce ‖ ciphertext)。
func (c *Cipher) Encrypt(plain string) (string, error) {
	nonce := make([]byte, c.gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := c.gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

func (c *Cipher) Decrypt(enc string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	ns := c.gcm.NonceSize()
	if len(data) < ns {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := data[:ns], data[ns:]
	pt, err := c.gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/crypto/ -v`
Expected: PASS（3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add internal/crypto/
git commit -m "feat: add AES-256-GCM cipher for kubeconfig encryption"
```

---

## Task 4: auth/password（bcrypt）

**Files:**
- Create: `internal/auth/password.go`, `internal/auth/password_test.go`

- [ ] **Step 1: 写失败测试**

`internal/auth/password_test.go`:
```go
package auth

import "testing"

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("s3cret-pw")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "s3cret-pw" {
		t.Fatal("hash must not equal plaintext")
	}
	if !VerifyPassword(hash, "s3cret-pw") {
		t.Fatal("correct password should verify")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("wrong password should not verify")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/auth/ -run TestHashAndVerify -v`
Expected: FAIL（`HashPassword` undefined）。

- [ ] **Step 3: 写实现**

Run: `go get golang.org/x/crypto/bcrypt`

`internal/auth/password.go`:
```go
package auth

import "golang.org/x/crypto/bcrypt"

func HashPassword(pwd string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pwd), 12)
	return string(b), err
}

func VerifyPassword(hash, pwd string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pwd)) == nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/auth/ -run TestHashAndVerify -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add internal/auth/password.go internal/auth/password_test.go
git commit -m "feat: add bcrypt password hashing"
```

---

## Task 5: auth/jwt

**Files:**
- Create: `internal/auth/jwt.go`, `internal/auth/jwt_test.go`

- [ ] **Step 1: 写失败测试**

`internal/auth/jwt_test.go`:
```go
package auth

import (
	"testing"
	"time"
)

func TestJWT_IssueParse(t *testing.T) {
	m := NewJWTManager("secret", time.Hour)
	tok, err := m.Issue(42, true)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := m.Parse(tok)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || !claims.IsAdmin {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestJWT_Expired(t *testing.T) {
	m := NewJWTManager("secret", -time.Hour) // 已过期
	tok, _ := m.Issue(1, false)
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("expected expired token to fail")
	}
}

func TestJWT_Tampered(t *testing.T) {
	m := NewJWTManager("secret", time.Hour)
	tok, _ := m.Issue(1, false)
	if _, err := m.Parse(tok + "x"); err == nil {
		t.Fatal("expected tampered token to fail")
	}
}

func TestJWT_WrongSecret(t *testing.T) {
	tok, _ := NewJWTManager("secret-a", time.Hour).Issue(1, false)
	if _, err := NewJWTManager("secret-b", time.Hour).Parse(tok); err == nil {
		t.Fatal("expected wrong-secret parse to fail")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/auth/ -run TestJWT -v`
Expected: FAIL（`NewJWTManager` undefined）。

- [ ] **Step 3: 写实现**

Run: `go get github.com/golang-jwt/jwt/v5`

`internal/auth/jwt.go`:
```go
package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID  uint `json:"user_id"`
	IsAdmin bool `json:"is_admin"`
	jwt.RegisteredClaims
}

type JWTManager struct {
	secret []byte
	expiry time.Duration
}

func NewJWTManager(secret string, expiry time.Duration) *JWTManager {
	return &JWTManager{secret: []byte(secret), expiry: expiry}
}

func (m *JWTManager) Issue(userID uint, isAdmin bool) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:  userID,
		IsAdmin: isAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(m.expiry)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
}

func (m *JWTManager) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/auth/ -v`
Expected: PASS（password + jwt 全部）。

- [ ] **Step 5: Commit**

```bash
git add internal/auth/jwt.go internal/auth/jwt_test.go go.mod go.sum
git commit -m "feat: add JWT issue/parse manager"
```

---

## Task 6: model 包

**Files:**
- Create: `internal/model/model.go`

- [ ] **Step 1: 写模型**

`internal/model/model.go`:
```go
package model

import "time"

type User struct {
	ID        uint   `gorm:"primaryKey"`
	Username  string `gorm:"unique;not null;size:50"`
	Password  string `gorm:"not null;size:100"` // bcrypt 哈希
	IsAdmin   bool   `gorm:"default:false"`
	MustReset bool   `gorm:"default:false"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (User) TableName() string { return "ok_users" }

type Cluster struct {
	ID         string `gorm:"primaryKey;size:50"`
	Name       string `gorm:"not null;size:100"`
	Kubeconfig string `gorm:"type:text;not null"` // AES-256-GCM 密文
	Status     string `gorm:"size:20;default:'Unknown'"`
	LastCheck  time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

func (Cluster) TableName() string { return "ok_clusters" }

type AuditLog struct {
	ID        uint      `gorm:"primaryKey"`
	UserID    string    `gorm:"index;size:50"`
	ClusterID string    `gorm:"index;size:50"`
	Namespace string    `gorm:"size:100"`
	Resource  string    `gorm:"size:100"`
	Action    string    `gorm:"size:20"`
	Target    string    `gorm:"size:200"`
	Result    string    `gorm:"size:20"`
	SourceIP  string    `gorm:"size:50"`
	CreatedAt time.Time `gorm:"index"`
}

func (AuditLog) TableName() string { return "ok_audit_logs" }

// CasbinRule 与 casbin gorm-adapter 默认 schema 对齐，A 阶段仅建表，
// 子项目 C 接入真正的 adapter 时复用同一张表。
type CasbinRule struct {
	ID    uint   `gorm:"primaryKey;autoIncrement"`
	Ptype string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V0    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V1    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V2    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V3    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V4    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V5    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
}

func (CasbinRule) TableName() string { return "casbin_rule" }
```

- [ ] **Step 2: 编译验证**

Run: `go get gorm.io/gorm && go build ./internal/model/`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add internal/model/ go.mod go.sum
git commit -m "feat: add GORM models for users/clusters/audit/casbin"
```

---

## Task 7: database（连库 / 迁移 / admin 自举）

**Files:**
- Create: `internal/database/database.go`, `internal/database/database_test.go`

- [ ] **Step 1: 写失败测试（用内存 sqlite 注入）**

Run: `go get github.com/glebarez/sqlite`

`internal/database/database_test.go`:
```go
package database

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/model"
)

func memDB(t *testing.T) *gorm.DB {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestBootstrapAdmin_CreatesOnEmpty(t *testing.T) {
	db := memDB(t)
	if err := BootstrapAdmin(db, "admin"); err != nil {
		t.Fatal(err)
	}
	var u model.User
	if err := db.Where("username = ?", "admin").First(&u).Error; err != nil {
		t.Fatalf("admin not created: %v", err)
	}
	if !u.IsAdmin || !u.MustReset {
		t.Fatalf("admin flags wrong: %+v", u)
	}
	if u.Password == "" {
		t.Fatal("admin password hash empty")
	}
}

func TestBootstrapAdmin_SkipsWhenUsersExist(t *testing.T) {
	db := memDB(t)
	if err := BootstrapAdmin(db, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := BootstrapAdmin(db, "admin"); err != nil { // 第二次不应再建
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.User{}).Count(&count)
	if count != 1 {
		t.Fatalf("expected exactly 1 user, got %d", count)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/database/ -v`
Expected: FAIL（`Migrate` / `BootstrapAdmin` undefined）。

- [ ] **Step 3: 写实现**

Run: `go get gorm.io/driver/postgres`

`internal/database/database.go`:
```go
package database

import (
	"crypto/rand"
	"log"
	"math/big"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/model"
)

func Connect(dsn string) (*gorm.DB, error) {
	return gorm.Open(postgres.Open(dsn), &gorm.Config{})
}

func Migrate(db *gorm.DB) error {
	return db.AutoMigrate(
		&model.User{},
		&model.Cluster{},
		&model.AuditLog{},
		&model.CasbinRule{},
	)
}

// BootstrapAdmin 在 ok_users 为空时创建一个随机密码的管理员，
// 明文密码仅打印到启动日志一次。
func BootstrapAdmin(db *gorm.DB, username string) error {
	var count int64
	if err := db.Model(&model.User{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	pwd, err := generatePassword(16)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(pwd)
	if err != nil {
		return err
	}
	admin := model.User{Username: username, Password: hash, IsAdmin: true, MustReset: true}
	if err := db.Create(&admin).Error; err != nil {
		return err
	}
	log.Printf("==== OmniKube 初始管理员已创建 ====")
	log.Printf("用户名: %s", username)
	log.Printf("初始密码(仅显示一次, 请立即登录修改): %s", pwd)
	log.Printf("===================================")
	return nil
}

func generatePassword(n int) (string, error) {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%"
	b := make([]byte, n)
	max := big.NewInt(int64(len(charset)))
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = charset[idx.Int64()]
	}
	return string(b), nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/database/ -v`
Expected: PASS（2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add internal/database/ go.mod go.sum
git commit -m "feat: add db connect, migrate, and admin bootstrap"
```

---

## Task 8: middleware（JWT 认证）

**Files:**
- Create: `internal/middleware/auth.go`, `internal/middleware/auth_test.go`

- [ ] **Step 1: 写失败测试**

`internal/middleware/auth_test.go`:
```go
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
)

func setup() (*gin.Engine, *auth.JWTManager) {
	gin.SetMode(gin.TestMode)
	jm := auth.NewJWTManager("secret", time.Hour)
	r := gin.New()
	r.GET("/protected", JWTAuth(jm), func(c *gin.Context) {
		uid := c.MustGet("user_id").(uint)
		c.JSON(http.StatusOK, gin.H{"user_id": uid})
	})
	return r, jm
}

func TestJWTAuth_NoHeader(t *testing.T) {
	r, _ := setup()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestJWTAuth_ValidToken(t *testing.T) {
	r, jm := setup()
	tok, _ := jm.Issue(7, false)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestJWTAuth_BadToken(t *testing.T) {
	r, _ := setup()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer garbage")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/middleware/ -v`
Expected: FAIL（`JWTAuth` undefined）。

- [ ] **Step 3: 写实现**

`internal/middleware/auth.go`:
```go
package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
)

func JWTAuth(jm *auth.JWTManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "未认证"})
			return
		}
		claims, err := jm.Parse(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "无效或过期的令牌"})
			return
		}
		c.Set("user_id", claims.UserID)
		c.Set("is_admin", claims.IsAdmin)
		c.Next()
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/middleware/ -v`
Expected: PASS（3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add internal/middleware/
git commit -m "feat: add JWT auth middleware"
```

---

## Task 9: handler — login / change-password / me

**Files:**
- Replace: `internal/handler/handler.go`（升级为完整版）
- Create: `internal/handler/auth.go`, `internal/handler/auth_test.go`

- [ ] **Step 1: 升级 handler.go 为完整版**

`internal/handler/handler.go`（替换 Task 1 的临时版）:
```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/auth"
)

type Handler struct {
	DB  *gorm.DB
	JWT *auth.JWTManager
}

func (h *Handler) Healthz(c *gin.Context) {
	sqlDB, err := h.DB.DB()
	if err != nil || sqlDB.Ping() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "db unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
```

- [ ] **Step 2: 写失败测试**

`internal/handler/auth_test.go`:
```go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/database"
	"omnikube/internal/middleware"
	"omnikube/internal/model"
)

func testApp(t *testing.T) (*gin.Engine, *Handler, *gorm.DB) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	jm := auth.NewJWTManager("secret", time.Hour)
	h := &Handler{DB: db, JWT: jm}
	r := gin.New()
	r.POST("/login", h.Login)
	authed := r.Group("")
	authed.Use(middleware.JWTAuth(jm))
	authed.POST("/change-password", h.ChangePassword)
	authed.GET("/me", h.Me)
	return r, h, db
}

func seedUser(t *testing.T, db *gorm.DB, username, pwd string, mustReset bool) {
	hash, _ := auth.HashPassword(pwd)
	if err := db.Create(&model.User{Username: username, Password: hash, MustReset: mustReset}).Error; err != nil {
		t.Fatal(err)
	}
}

func doJSON(r *gin.Engine, method, path, token string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestLogin_Success(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", true)
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "pw123456"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["token"] == nil || resp["must_reset"] != true {
		t.Fatalf("unexpected body: %v", resp)
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	r, _, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	w := doJSON(r, "POST", "/login", "", map[string]string{"username": "alice", "password": "bad"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestChangePassword_Success(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "oldpw123", true)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "POST", "/change-password", tok, map[string]string{"old_password": "oldpw123", "new_password": "newpw123"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	db.Where("username = ?", "alice").First(&u)
	if u.MustReset {
		t.Fatal("must_reset should be cleared")
	}
	if !auth.VerifyPassword(u.Password, "newpw123") {
		t.Fatal("password not updated")
	}
}

func TestChangePassword_WrongOld(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "oldpw123", false)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "POST", "/change-password", tok, map[string]string{"old_password": "WRONG", "new_password": "newpw123"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestMe(t *testing.T) {
	r, h, db := testApp(t)
	seedUser(t, db, "alice", "pw123456", false)
	var u model.User
	db.Where("username = ?", "alice").First(&u)
	tok, _ := h.JWT.Issue(u.ID, false)
	w := doJSON(r, "GET", "/me", tok, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["username"] != "alice" {
		t.Fatalf("unexpected: %v", resp)
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `go test ./internal/handler/ -v`
Expected: FAIL（`Login` / `ChangePassword` / `Me` undefined）。

- [ ] **Step 4: 写实现**

`internal/handler/auth.go`:
```go
package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
	"omnikube/internal/model"
)

type loginReq struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *Handler) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	var user model.User
	err := h.DB.Where("username = ?", req.Username).First(&user).Error
	if err != nil || !auth.VerifyPassword(user.Password, req.Password) {
		// 不区分用户不存在/密码错误，防枚举
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户名或密码错误"})
		return
	}
	token, err := h.JWT.Issue(user.ID, user.IsAdmin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "must_reset": user.MustReset})
}

type changePwdReq struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required,min=8"`
}

func (h *Handler) ChangePassword(c *gin.Context) {
	var req changePwdReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误(新密码至少8位)"})
		return
	}
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户不存在"})
		return
	}
	if !auth.VerifyPassword(user.Password, req.OldPassword) {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "旧密码错误"})
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.DB.Model(&user).Updates(map[string]interface{}{
		"password": hash, "must_reset": false,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "改密成功"})
}

func (h *Handler) Me(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户不存在"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": user.ID, "username": user.Username,
		"is_admin": user.IsAdmin, "must_reset": user.MustReset,
	})
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/handler/ -v`
Expected: PASS（5 个用例）。

- [ ] **Step 6: Commit**

```bash
git add internal/handler/
git commit -m "feat: add login, change-password, and me handlers"
```

---

## Task 10: 路由与 main 装配

**Files:**
- Replace: `internal/router/router.go`（完整版）
- Replace: `cmd/server/main.go`（完整版）

- [ ] **Step 1: 写完整路由**

`internal/router/router.go`（替换临时版）:
```go
package router

import (
	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
	"omnikube/internal/handler"
	"omnikube/internal/middleware"
)

func New(h *handler.Handler, jm *auth.JWTManager) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", h.Healthz)
	api := r.Group("/api/v1")
	{
		api.POST("/login", h.Login)
		authed := api.Group("")
		authed.Use(middleware.JWTAuth(jm))
		{
			authed.POST("/change-password", h.ChangePassword)
			authed.GET("/me", h.Me)
		}
	}
	return r
}
```

- [ ] **Step 2: 写完整 main**

`cmd/server/main.go`（替换临时版）:
```go
package main

import (
	"log"

	"github.com/joho/godotenv"

	"omnikube/internal/auth"
	"omnikube/internal/config"
	"omnikube/internal/database"
	"omnikube/internal/handler"
	"omnikube/internal/router"
)

func main() {
	_ = godotenv.Load() // .env 可选

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	if err := database.Migrate(db); err != nil {
		log.Fatalf("数据库迁移失败: %v", err)
	}
	if err := database.BootstrapAdmin(db, cfg.AdminUsername); err != nil {
		log.Fatalf("admin 自举失败: %v", err)
	}

	jm := auth.NewJWTManager(cfg.JWTSecret, cfg.JWTExpiry)
	h := &handler.Handler{DB: db, JWT: jm}
	r := router.New(h, jm)

	log.Printf("OmniKube 监听 :%s", cfg.ServerPort)
	if err := r.Run(":" + cfg.ServerPort); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
```

- [ ] **Step 3: 安装 godotenv 并编译**

Run:
```bash
go get github.com/joho/godotenv
go mod tidy
go build ./...
```
Expected: 无错误。

- [ ] **Step 4: 全量测试**

Run: `go test ./...`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: wire router and main with full auth flow"
```

---

## Task 11: 端到端手动验证（需真实 PostgreSQL）

- [ ] **Step 1: 准备 PostgreSQL 与 .env**

Run:
```bash
# 若本地无 PG，可用 docker:
docker run -d --name omnikube-pg -e POSTGRES_USER=omnikube \
  -e POSTGRES_PASSWORD=omnikube -e POSTGRES_DB=omnikube \
  -p 5432:5432 postgres:16
cp .env.example .env
# 写入 MASTER_KEY:
echo "MASTER_KEY=$(openssl rand -base64 32)" >> .env
```
> 注：`.env` 里 `MASTER_KEY=` 那一行原本为空，上面 `>>` 追加的新行会覆盖生效（godotenv 后者优先）。如担心重复，手动编辑 `.env` 把空的 `MASTER_KEY=` 删掉。

- [ ] **Step 2: 启动并抓取初始密码**

Run: `go run cmd/server/main.go`
Expected: 日志打印「初始管理员已创建」+ 用户名 `admin` + 一串随机初始密码。记下该密码。

- [ ] **Step 3: 验证 healthz**

Run（另开终端）: `curl -s localhost:8080/healthz`
Expected: `{"status":"ok"}`

- [ ] **Step 4: 用初始密码登录**

Run: `curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"<上一步的初始密码>"}'`
Expected: 返回 `{"token":"<jwt>","must_reset":true}`。记下 token。

- [ ] **Step 5: 改密**

Run: `curl -s -X POST localhost:8080/api/v1/change-password -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d '{"old_password":"<初始密码>","new_password":"NewStrongPw123"}'`
Expected: `{"code":0,"message":"改密成功"}`。

- [ ] **Step 6: 验证旧密码失效、新密码可登录、must_reset 已清**

Run:
```bash
curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"<初始密码>"}'   # 期望 401
curl -s -X POST localhost:8080/api/v1/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"NewStrongPw123"}' # 期望 200, must_reset:false
```
Expected: 旧密码 401；新密码 200 且 `must_reset:false`。

- [ ] **Step 7: 验证四张表存在**

Run: `docker exec -it omnikube-pg psql -U omnikube -d omnikube -c '\dt'`
Expected: 列出 `ok_users`、`ok_clusters`、`ok_audit_logs`、`casbin_rule`。

- [ ] **Step 8: 更新 README 并提交**

`README.md`:
```markdown
# OmniKube

多集群多租户 Kubernetes 管控平台。当前进度：子项目 A（后端地基）。

## 本地运行
1. 启动 PostgreSQL（见 docker 命令）。
2. `cp .env.example .env`，填入 `MASTER_KEY=$(openssl rand -base64 32)`。
3. `go run cmd/server/main.go`，从日志读取初始 admin 密码。
4. 登录：`POST /api/v1/login`，首登 `must_reset=true`，调用 `POST /api/v1/change-password` 改密。

## 测试
`go test ./...`
```

Run:
```bash
git add README.md
git commit -m "docs: add README for backend foundation"
```

---

## 自检结果（Spec 覆盖对照）

| Spec 要求 | 对应任务 |
|---|---|
| 标准 Go layout 分层 | Task 1 |
| 环境变量配置 + MASTER_KEY 32字节校验 | Task 2 |
| AES-256-GCM 加解密 | Task 3 |
| bcrypt cost=12 | Task 4 |
| 仅 Access Token 的 JWT | Task 5 |
| 4 张表模型 | Task 6 |
| 连库/迁移/admin 自举(随机密码+MustReset+日志一次) | Task 7 |
| JWT 认证中间件注入 user_id/is_admin | Task 8 |
| login/change-password/me + 防枚举 + 统一错误体 | Task 9 |
| healthz + 路由 + main 装配 | Task 1/9/10 |
| 验收标准全部可验证 | Task 11 |

**未覆盖（按 spec 第 10 节，留给后续子项目）**：连接池/集群 CRUD（B）、Casbin enforce（C）、资源 API（D）、WebSocket（E）、前端（F）、refresh/登出（暂不做）。
