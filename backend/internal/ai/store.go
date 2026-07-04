// Package ai holds the OmniKube AI assistant's configuration and the ReAct
// agent runtime. Permissions follow the initiating user's own RBAC.
package ai

import (
	"errors"

	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/model"
)

// configRowID is the fixed primary key of the single global AI config row.
const configRowID = 1

// ConfigInput is the writable AI model config. An empty APIKey means "keep the
// stored key" (so the frontend never has to round-trip the secret).
type ConfigInput struct {
	Enabled      bool
	BaseURL      string
	APIKey       string
	ModelID      string
	Temperature  float64
	SystemPrompt string
	MaxSteps     int
}

// Config is the decrypted, readable AI config. APIKey is only populated for
// server-side use (agent); handlers must mask it before returning to clients.
type Config struct {
	Enabled      bool
	BaseURL      string
	APIKey       string
	HasKey       bool
	ModelID      string
	Temperature  float64
	SystemPrompt string
	MaxSteps     int
}

type Store struct {
	db     *gorm.DB
	cipher *crypto.Cipher
}

func NewStore(db *gorm.DB, cipher *crypto.Cipher) *Store {
	return &Store{db: db, cipher: cipher}
}

// LoadConfig returns the current config with the api_key decrypted (for
// server-side use, e.g. the agent). Zero-value Config when unset.
func (s *Store) LoadConfig() (Config, error) {
	return s.loadConfig(true)
}

// LoadConfigMeta returns the current config WITHOUT decrypting the api_key
// (APIKey stays ""); HasKey still reflects whether a key is stored. Use this
// for read-only metadata paths (status/config views) that never need the
// plaintext secret. Zero-value Config when unset.
func (s *Store) LoadConfigMeta() (Config, error) {
	return s.loadConfig(false)
}

// loadConfig is the shared implementation; decryptKey toggles whether the
// stored api_key is decrypted into Config.APIKey.
func (s *Store) loadConfig(decryptKey bool) (Config, error) {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	out := Config{
		Enabled: row.Enabled, BaseURL: row.BaseURL, ModelID: row.ModelID,
		Temperature: row.Temperature, SystemPrompt: row.SystemPrompt, MaxSteps: row.MaxSteps,
		HasKey: row.APIKeyEnc != "",
	}
	if decryptKey && row.APIKeyEnc != "" {
		plain, err := s.cipher.Decrypt(row.APIKeyEnc)
		if err != nil {
			return Config{}, err
		}
		out.APIKey = plain
	}
	return out, nil
}

// SaveConfig upserts the single config row; a blank APIKey keeps the stored one.
// 注意：不改 Enabled——启用/停用是单独权限，只经 SetEnabled 变更（见 handler PutAIEnabled）。
func (s *Store) SaveConfig(in ConfigInput) error {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	row.ID = configRowID
	row.BaseURL = in.BaseURL
	row.ModelID = in.ModelID
	row.Temperature = in.Temperature
	row.SystemPrompt = in.SystemPrompt
	row.MaxSteps = in.MaxSteps
	if in.APIKey != "" {
		enc, err := s.cipher.Encrypt(in.APIKey)
		if err != nil {
			return err
		}
		row.APIKeyEnc = enc
	}
	return s.db.Save(&row).Error
}

// SetEnabled 单独设置 AI 启用状态（对应「AI 启用开关」权限 ai:create），与模型配置编辑
// (ai:edit) 分离：有编辑权不代表能开关 AI。其它字段保持不动。
func (s *Store) SetEnabled(enabled bool) error {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	row.ID = configRowID
	row.Enabled = enabled
	return s.db.Save(&row).Error
}
