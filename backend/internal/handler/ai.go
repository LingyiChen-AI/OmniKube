package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"omnikube/internal/ai"
)

func (h *Handler) aiStore() *ai.Store { return ai.NewStore(h.DB, h.Cipher) }

// GetAIStatus GET /ai/status — any logged-in user; drives the ⚠️ launcher state.
func (h *Handler) GetAIStatus(c *gin.Context) {
	cfg, err := h.aiStore().LoadConfigMeta()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 配置失败"})
		return
	}
	configured := cfg.BaseURL != "" && cfg.ModelID != "" && cfg.HasKey
	c.JSON(http.StatusOK, gin.H{"enabled": cfg.Enabled, "configured": configured})
}

// GetAIConfig GET /ai/config — RequireGlobalPerm("ai","view"); api_key masked.
func (h *Handler) GetAIConfig(c *gin.Context) {
	cfg, err := h.aiStore().LoadConfigMeta()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 配置失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":       cfg.Enabled,
		"base_url":      cfg.BaseURL,
		"model_id":      cfg.ModelID,
		"temperature":   cfg.Temperature,
		"system_prompt": cfg.SystemPrompt,
		"max_steps":     cfg.MaxSteps,
		"has_key":       cfg.HasKey,
	})
}

type aiConfigReq struct {
	Enabled      bool    `json:"enabled"`
	BaseURL      string  `json:"base_url"`
	APIKey       string  `json:"api_key"` // "" = keep existing
	ModelID      string  `json:"model_id"`
	Temperature  float64 `json:"temperature"`
	SystemPrompt string  `json:"system_prompt"`
	MaxSteps     int     `json:"max_steps"`
}

// PutAIConfig PUT /ai/config — RequireGlobalPerm("ai","edit").
func (h *Handler) PutAIConfig(c *gin.Context) {
	var req aiConfigReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	err := h.aiStore().SaveConfig(ai.ConfigInput{
		Enabled: req.Enabled, BaseURL: req.BaseURL, APIKey: req.APIKey, ModelID: req.ModelID,
		Temperature: req.Temperature, SystemPrompt: req.SystemPrompt, MaxSteps: req.MaxSteps,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "保存 AI 配置失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已保存"})
}

// GetAIGrants GET /ai/grants?cluster_id= — RequireGlobalPerm("ai","view").
func (h *Handler) GetAIGrants(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少 cluster_id"})
		return
	}
	ops, err := h.aiStore().LoadGrant(clusterID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 权限失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"cluster_id": clusterID, "operations": ops})
}

type aiGrantReq struct {
	Operations map[string][]string `json:"operations"`
}

// PutAIGrants PUT /ai/grants?cluster_id= — RequireGlobalPerm("ai","edit").
func (h *Handler) PutAIGrants(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少 cluster_id"})
		return
	}
	var req aiGrantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if err := h.aiStore().SaveGrant(clusterID, req.Operations); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "保存 AI 权限失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已保存"})
}
