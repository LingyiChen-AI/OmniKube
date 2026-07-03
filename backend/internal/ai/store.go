// Package ai holds the OmniKube AI assistant's configuration, permission
// grants, and (later phases) the ReAct agent runtime.
package ai

import (
	"encoding/json"
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
func (s *Store) SaveConfig(in ConfigInput) error {
	var row model.AIConfig
	err := s.db.First(&row, configRowID).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	row.ID = configRowID
	row.Enabled = in.Enabled
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

// LoadGrant returns the AI operations matrix for a cluster (empty when unset).
func (s *Store) LoadGrant(clusterID string) (map[string][]string, error) {
	var row model.AIGrant
	err := s.db.Where("cluster_id = ?", clusterID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return map[string][]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string][]string{}
	if row.Operations != "" {
		if err := json.Unmarshal([]byte(row.Operations), &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// SaveGrant upserts the AI operations matrix for a cluster.
func (s *Store) SaveGrant(clusterID string, ops map[string][]string) error {
	raw, err := json.Marshal(ops)
	if err != nil {
		return err
	}
	var row model.AIGrant
	err = s.db.Where("cluster_id = ?", clusterID).First(&row).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	row.ClusterID = clusterID
	row.Operations = string(raw)
	return s.db.Save(&row).Error
}
