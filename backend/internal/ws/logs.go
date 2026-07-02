package ws

import (
	"context"
	"io"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"

	"omnikube/internal/audit"
)

// LogHandler GET /api/v1/logs —— 实时日志流（kubectl logs -f）。
//
// 升级前先过 authorizeWS（动作 "read"，资源 "pods"）。鉴权通过并握手成功后强制落
// 一条 read allow 审计，然后把 Pod 日志流逐块推送到 ws；客户端断开或流结束即停止。
func (h *Handler) LogHandler(c *gin.Context) {
	ac, ok := h.authorizeWS(c, "read")
	if !ok {
		return
	}

	follow := c.Query("follow") != "false" // 默认跟随。
	var tailLines *int64
	if tail := c.Query("tail"); tail != "" {
		if n, err := strconv.ParseInt(tail, 10, 64); err == nil && n >= 0 {
			tailLines = &n
		}
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade 失败时已写好 HTTP 响应。
	}
	defer conn.Close()

	// 鉴权通过 + 握手成功 = 放行，落 read allow 审计。
	audit.Log(h.DB, audit.Entry{
		UserID:    ac.UserID,
		ClusterID: ac.ClusterID,
		Namespace: ac.Namespace,
		Resource:  "pods",
		Action:    "read",
		Target:    podTarget(ac.Pod, ac.Container),
		Result:    "allow",
		SourceIP:  ac.SourceIP,
	})

	streamLogs(conn, ac, follow, tailLines)
}

// streamLogs 打开 Pod 日志流并推送到 ws；客户端断开 → cancel ctx 停止流。
func streamLogs(conn *websocket.Conn, ac *authContext, follow bool, tailLines *int64) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 客户端断开（读到错误/关闭帧）→ 取消上下文停止流。
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	stream, err := ac.Client.Typed.CoreV1().Pods(ac.Namespace).
		GetLogs(ac.Pod, &corev1.PodLogOptions{
			Container: ac.Container,
			Follow:    follow,
			TailLines: tailLines,
		}).Stream(ctx)
	if err != nil {
		sendWSError(conn, "日志流启动失败: "+err.Error())
		return
	}
	defer stream.Close()

	buf := make([]byte, 4096)
	for {
		n, readErr := stream.Read(buf)
		if n > 0 {
			if werr := conn.WriteMessage(websocket.TextMessage, buf[:n]); werr != nil {
				return
			}
		}
		if readErr != nil {
			if readErr != io.EOF && ctx.Err() == nil {
				sendWSError(conn, "日志读取结束: "+readErr.Error())
			}
			return
		}
	}
}
