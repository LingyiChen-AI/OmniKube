package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func validKey() string {
	return base64.StdEncoding.EncodeToString(make([]byte, 32))
}

const validSecret = "0123456789abcdef0123456789abcdef" // 32 chars

// writeYAML 写一个临时 config.yaml 并返回路径。
func writeYAML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func fullYAML() string {
	return `
server:
  port: "8080"
database:
  url: "postgres://x"
auth:
  jwt_secret: "` + validSecret + `"
  jwt_expiry: "2h"
crypto:
  master_key: "` + validKey() + `"
admin:
  username: "admin"
`
}

func TestLoad_Success(t *testing.T) {
	cfg, err := Load(writeYAML(t, fullYAML()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.MasterKey) != 32 {
		t.Fatalf("expected 32-byte key, got %d", len(cfg.MasterKey))
	}
	if cfg.ServerPort != "8080" {
		t.Fatalf("expected port 8080, got %s", cfg.ServerPort)
	}
	if cfg.DatabaseURL != "postgres://x" {
		t.Fatalf("unexpected db url %s", cfg.DatabaseURL)
	}
}

func TestLoad_MissingFile(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Fatal("expected error for missing config file")
	}
}

func TestLoad_MissingDB(t *testing.T) {
	body := `
auth:
  jwt_secret: "` + validSecret + `"
crypto:
  master_key: "` + validKey() + `"
`
	if _, err := Load(writeYAML(t, body)); err == nil {
		t.Fatal("expected error for missing database url")
	}
}

func TestLoad_BadMasterKeyLength(t *testing.T) {
	body := `
database:
  url: "postgres://x"
auth:
  jwt_secret: "` + validSecret + `"
crypto:
  master_key: "` + base64.StdEncoding.EncodeToString(make([]byte, 16)) + `"
`
	if _, err := Load(writeYAML(t, body)); err == nil {
		t.Fatal("expected error for 16-byte key")
	}
}

func TestLoad_ShortJWTSecret(t *testing.T) {
	body := `
database:
  url: "postgres://x"
auth:
  jwt_secret: "tooshort"
crypto:
  master_key: "` + validKey() + `"
`
	if _, err := Load(writeYAML(t, body)); err == nil {
		t.Fatal("expected error for short jwt secret")
	}
}

func TestLoad_EnvOverridesSecret(t *testing.T) {
	// YAML 里给一个占位密钥，env 覆盖为有效值。
	body := `
database:
  url: "postgres://x"
auth:
  jwt_secret: "placeholder-too-short"
crypto:
  master_key: "not-base64-and-wrong"
`
	t.Setenv("JWT_SECRET", validSecret)
	t.Setenv("MASTER_KEY", validKey())
	cfg, err := Load(writeYAML(t, body))
	if err != nil {
		t.Fatalf("env override should yield valid config: %v", err)
	}
	if cfg.JWTSecret != validSecret {
		t.Fatal("env JWT_SECRET should override yaml")
	}
}
