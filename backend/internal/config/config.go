package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Config 是应用运行配置。来源：YAML 文件 + 敏感项的环境变量覆盖。
type Config struct {
	DatabaseURL   string
	JWTSecret     string
	MasterKey     []byte
	JWTExpiry     time.Duration
	ServerPort    string
	AdminUsername string
}

// fileConfig 是 YAML 文件的结构映射。
type fileConfig struct {
	Server struct {
		Port string `yaml:"port"`
	} `yaml:"server"`
	Database struct {
		URL string `yaml:"url"`
	} `yaml:"database"`
	Auth struct {
		JWTSecret string `yaml:"jwt_secret"`
		JWTExpiry string `yaml:"jwt_expiry"`
	} `yaml:"auth"`
	Crypto struct {
		MasterKey string `yaml:"master_key"`
	} `yaml:"crypto"`
	Admin struct {
		Username string `yaml:"username"`
	} `yaml:"admin"`
}

// Load 读取 YAML 配置文件并应用环境变量覆盖（敏感项 env 优先），再校验。
func Load(path string) (*Config, error) {
	var fc fileConfig
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file %q: %w", path, err)
	}
	if err := yaml.Unmarshal(raw, &fc); err != nil {
		return nil, fmt.Errorf("parse config yaml: %w", err)
	}

	// 敏感项允许环境变量覆盖（保留 PRD「主密钥/密钥来自 env/KMS」原则）。
	dbURL := envOr("DATABASE_URL", fc.Database.URL)
	jwtSecret := envOr("JWT_SECRET", fc.Auth.JWTSecret)
	masterKeyEnc := envOr("MASTER_KEY", fc.Crypto.MasterKey)
	port := envOr("SERVER_PORT", fc.Server.Port)
	admin := envOr("ADMIN_USERNAME", fc.Admin.Username)
	expiryStr := envOr("JWT_EXPIRY", fc.Auth.JWTExpiry)

	if dbURL == "" {
		return nil, fmt.Errorf("database.url (or DATABASE_URL) is required")
	}
	if jwtSecret == "" {
		return nil, fmt.Errorf("auth.jwt_secret (or JWT_SECRET) is required")
	}
	// HS256 签名密钥至少 32 字节，防弱密钥被暴力破解。
	if len(jwtSecret) < 32 {
		return nil, fmt.Errorf("jwt_secret must be at least 32 chars, got %d", len(jwtSecret))
	}
	if masterKeyEnc == "" {
		return nil, fmt.Errorf("crypto.master_key (or MASTER_KEY) is required")
	}
	masterKey, err := base64.StdEncoding.DecodeString(masterKeyEnc)
	if err != nil {
		return nil, fmt.Errorf("master_key must be valid base64: %w", err)
	}
	if len(masterKey) != 32 {
		return nil, fmt.Errorf("master_key must decode to 32 bytes, got %d", len(masterKey))
	}

	expiry := 2 * time.Hour
	if expiryStr != "" {
		d, err := time.ParseDuration(expiryStr)
		if err != nil {
			return nil, fmt.Errorf("jwt_expiry invalid: %w", err)
		}
		expiry = d
	}
	if port == "" {
		port = "8080"
	}
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

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
