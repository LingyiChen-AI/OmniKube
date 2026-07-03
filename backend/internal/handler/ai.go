package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"omnikube/internal/ai"
)

func (h *Handler) aiStore() *ai.Store         { return ai.NewStore(h.DB, h.Cipher) }
func (h *Handler) aiConvStore() *ai.ConvStore { return ai.NewConvStore(h.DB) }

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

// ---- 会话 REST（任意登录用户；GetConversation 强制归属校验）----

// ListConversations GET /ai/conversations — 返回当前用户自己的会话（最新在前）。
func (h *Handler) ListConversations(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	convs, err := h.aiConvStore().List(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取会话失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": convs})
}

type createConvReq struct {
	ClusterID string `json:"cluster_id"`
	Title     string `json:"title"`
}

// CreateConversation POST /ai/conversations — 为当前用户新建一次会话。
func (h *Handler) CreateConversation(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	var req createConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	id, err := h.aiConvStore().Create(userID, req.ClusterID, req.Title)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "创建会话失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id, "cluster_id": req.ClusterID, "title": req.Title})
}

// GetConversation GET /ai/conversations/:id — 返回会话及其消息。
//
// ConvStore.Get 不带用户过滤，故此处必须显式做归属校验：非本人会话一律 403，
// 且不区分「不存在」与「他人所有」，避免泄露会话存在性。
func (h *Handler) GetConversation(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的会话 id"})
		return
	}
	conv, err := h.aiConvStore().Get(uint(id))
	if err != nil || conv.UserID != userID {
		c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "无权访问该会话"})
		return
	}
	msgs, err := h.aiConvStore().Messages(conv.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取消息失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversation": conv, "messages": msgs})
}

type confirmConvReq struct {
	Approved bool `json:"approved"`
}

// ConfirmConversation POST /ai/conversations/:id/confirm —— WS 断线后的 REST 兜底：
// 对上一轮暂存的写操作确认(approved=true)/取消(false)。Runner.Confirm 内部再做归属
// 校验与二次过闸门；本处把逐帧 Event 收集进 JSON 数组一次性返回（重连客户端据此渲染）。
func (h *Handler) ConfirmConversation(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	if _, err := strconv.ParseUint(c.Param("id"), 10, 64); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的会话 id"})
		return
	}
	var req confirmConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}

	store := h.aiStore()
	runner := ai.NewRunner(store, h.aiConvStore(), h.Pool, ai.NewGuard(h.RBAC))
	var events []ai.Event
	err := runner.Confirm(c.Request.Context(), userID, "", c.Param("id"), req.Approved, func(e ai.Event) {
		events = append(events, e)
	})
	if err != nil {
		// 归属校验失败 → 403（不区分不存在/他人所有，统一口径）。
		if errors.Is(err, ai.ErrConversationNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "无权访问该会话"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"events": events})
}
