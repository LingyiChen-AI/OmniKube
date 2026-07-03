package ws

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"omnikube/internal/ai"
)

// AIChatHandler GET /api/v1/ai/chat —— AI 助手流式对话（只读 agent）。
//
// 与 exec/logs 一致：不挂 Header 中间件，升级前用 query 的 token 完成身份校验，
// cluster_id 亦经 query 传入。握手后进入收发循环：读到 {type:"user_message",
// conversation_id, text} 即调用 Runner.Stream，把每帧 Event 编码为 JSON 文本帧下发，
// 本轮以 done 帧收尾。AI 未启用则回一条 error 帧并关闭。
//
// 权限双闸门（AI 授予矩阵 ∩ 用户 RBAC）由工具层 Guard 在每次工具调用时把关，
// 故此处 WS 级鉴权仅校验 token 合法；越权读取会在回答里以 permission denied 体现。
func (h *Handler) AIChatHandler(c *gin.Context) {
	token := c.Query("token")
	clusterID := c.Query("cluster_id")
	if token == "" || clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少必填参数 cluster_id/token"})
		return
	}

	// token 仅校验身份，绝不外泄。
	claims, err := h.JWT.Parse(token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "无效或过期的令牌"})
		return
	}
	userID := claims.UserID

	// 升级前先读一次 AI 状态元信息（不解密 key）。
	store := ai.NewStore(h.DB, h.Cipher)
	cfg, err := store.LoadConfigMeta()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "读取 AI 配置失败"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade 失败时已写好 HTTP 响应。
	}
	defer conn.Close()

	// AI 未启用：回 error 帧并关闭（握手已完成，不能再改 HTTP 状态码）。
	if !cfg.Enabled {
		writeAIFrame(conn, ai.Event{Type: "error", Text: "AI 助手未启用"})
		return
	}

	runner := ai.NewRunner(store, ai.NewConvStore(h.DB), h.Pool, ai.NewGuard(store, h.RBAC))

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return // 客户端关闭或读错误，退出循环。
		}
		var in struct {
			Type           string      `json:"type"`
			ConversationID json.Number `json:"conversation_id"`
			Text           string      `json:"text"`
		}
		if err := json.Unmarshal(data, &in); err != nil {
			writeAIFrame(conn, ai.Event{Type: "error", Text: "消息格式错误"})
			continue
		}
		if in.Type != "user_message" || in.Text == "" {
			continue // 忽略非对话帧 / 空输入。
		}

		emit := func(ev ai.Event) { writeAIFrame(conn, ev) }
		if err := runner.Stream(c.Request.Context(), userID, clusterID, in.ConversationID.String(), in.Text, emit); err != nil {
			writeAIFrame(conn, ai.Event{Type: "error", Text: err.Error()})
		}
	}
}

// writeAIFrame 把一帧 Event 编码为 JSON 文本帧下发。调用点均为同一读循环 goroutine
// 顺序调用，无并发写，故无需额外加锁。
func writeAIFrame(conn *websocket.Conn, ev ai.Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}
