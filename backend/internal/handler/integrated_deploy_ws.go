package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"omnikube/internal/model"
)

// publishWriteWait 是单帧 WS 写超时:死客户端不能阻塞发布 goroutine。
const publishWriteWait = 10 * time.Second

// publishUpgrader 升级 HTTP 连接为 WebSocket。鉴权已在 Upgrade 之前完成(与 ws 包的
// exec/logs/ai_chat 一致),此处放开 Origin 校验(同源策略由前置鉴权门承担)。
var publishUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

// PublishDeployOrderWS GET /integrated-deploy/publish?id=&token=
//
// 浏览器原生 WebSocket 无法自定义 Header,故与 exec/logs/ai/chat 同一鉴权模式:
// query 传 token,升级前完成身份 + 权限校验(不合法一律 401/403/404,不升级连接);
// 升级后调用共享的 executePublish,把每条资源的 running/结果事件与最终 done 编码为
// JSON 文本帧下发。executePublish 全程同步执行,emit 均从本 goroutine 单线程调用,
// 故无需为 conn 写加锁。
func (h *Handler) PublishDeployOrderWS(c *gin.Context) {
	token := c.Query("token")
	idStr := c.Query("id")
	if token == "" || idStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少必填参数 id/token"})
		return
	}

	claims, err := h.JWT.Parse(token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "无效或过期的令牌"})
		return
	}
	uid := claims.UserID

	if !claims.IsAdmin && !h.GlobalPermCheck(uid, "integrated_deploy", "publish") {
		c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "无该操作权限"})
		return
	}

	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的工单 id"})
		return
	}
	var o model.DeployOrder
	if err := h.DB.First(&o, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "工单不存在"})
		return
	}

	conn, err := publishUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade 失败时已写好 HTTP 响应。
	}
	defer conn.Close()

	emit := func(ev publishEvent) { writePublishFrame(conn, ev) }

	run, msg, code := h.executePublish(c.Request.Context(), o, uid, emit)
	if code != 0 {
		writePublishFrame(conn, publishEvent{Type: "error", Message: msg})
		return
	}
	writePublishFrame(conn, publishEvent{Type: "done", Status: run.Status})
}

// writePublishFrame 把一帧 publishEvent 编码为 JSON 文本帧下发。
func writePublishFrame(conn *websocket.Conn, ev publishEvent) {
	payload, err := json.Marshal(ev)
	if err != nil {
		return
	}
	_ = conn.SetWriteDeadline(time.Now().Add(publishWriteWait))
	_ = conn.WriteMessage(websocket.TextMessage, payload)
}
