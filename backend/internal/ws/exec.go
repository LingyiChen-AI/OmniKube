package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"

	"omnikube/internal/audit"
)

// upgrader 升级 HTTP 连接为 WebSocket。鉴权已在 Upgrade 之前完成（PRD §8），
// 此处放开 Origin 校验（同源策略由前置鉴权门承担）。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ExecHandler GET /api/v1/exec —— WebSSH 交互式终端。
//
// 升级前先过 authorizeWS（缺参 400 / 坏 token 401 / 未知集群 400 / 无 exec 权 403）。
// 鉴权通过并握手成功即视为会话建立，强制落一条 exec allow 审计；随后桥接
// remotecommand SPDY 流与 ws。鉴权与真实 exec 流启动解耦：握手成功(101)后即便流
// 无法建立（无真实集群），也只是回送 ws 错误并关闭，握手本身已完成。
func (h *Handler) ExecHandler(c *gin.Context) {
	ac, ok := h.authorizeWS(c, "exec")
	if !ok {
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade 失败时已写好 HTTP 响应。
	}
	defer conn.Close()

	// 鉴权通过 + 握手成功 = 会话建立，强制落 exec allow 审计（admin 同样记录）。
	audit.Log(h.DB, audit.Entry{
		UserID:    ac.UserID,
		ClusterID: ac.ClusterID,
		Namespace: ac.Namespace,
		Resource:  "pods",
		Action:    "exec",
		Target:    podTarget(ac.Pod, ac.Container),
		Result:    "allow",
		SourceIP:  ac.SourceIP,
	})

	runExec(conn, ac)
}

// runExec 建立 SPDY executor 并桥接 ws；流启动失败则回送错误并关闭。
func runExec(conn *websocket.Conn, ac *authContext) {
	exec, err := newSPDYExecutor(ac)
	if err != nil {
		sendWSError(conn, "建立终端失败: "+err.Error())
		return
	}

	bridge := newExecBridge(conn)
	defer bridge.close()
	go bridge.readLoop()

	streamErr := exec.StreamWithContext(bridge.ctx, remotecommand.StreamOptions{
		Stdin:             bridge.stdinR,
		Stdout:            bridge,
		Stderr:            bridge,
		Tty:               true,
		TerminalSizeQueue: bridge,
	})
	if streamErr != nil {
		sendWSError(conn, "终端会话结束: "+streamErr.Error())
	}
}

// newSPDYExecutor 用 ClusterClient.Config 构造对 pods/<pod>/exec 的 SPDY executor。
func newSPDYExecutor(ac *authContext) (remotecommand.Executor, error) {
	if ac.Client == nil || ac.Client.Config == nil {
		return nil, errors.New("集群配置不可用")
	}
	cs, err := kubernetes.NewForConfig(ac.Client.Config)
	if err != nil {
		return nil, err
	}
	req := cs.CoreV1().RESTClient().Post().
		Resource("pods").
		Namespace(ac.Namespace).
		Name(ac.Pod).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: ac.Container,
			Command:   []string{"/bin/sh", "-c", "exec /bin/bash || exec /bin/sh"},
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec)
	return remotecommand.NewSPDYExecutor(ac.Client.Config, "POST", req.URL())
}

// execBridge 桥接一个 gorilla/websocket 连接与 remotecommand 流：
//   - ws→stdin：读 ws 消息写入 stdin 管道（resize 控制消息除外）。
//   - stdout/stderr→ws：实现 io.Writer，写为二进制 ws 消息（写串行化）。
//   - resize：JSON {"type":"resize","cols":..,"rows":..} 驱动 TerminalSizeQueue。
type execBridge struct {
	conn   *websocket.Conn
	wmu    sync.Mutex // 串行化 ws 写。
	stdinR *io.PipeReader
	stdinW *io.PipeWriter
	sizeCh chan remotecommand.TerminalSize

	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
}

func newExecBridge(conn *websocket.Conn) *execBridge {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	return &execBridge{
		conn:   conn,
		stdinR: pr,
		stdinW: pw,
		sizeCh: make(chan remotecommand.TerminalSize, 1),
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
}

// Write 实现 io.Writer：把容器 stdout/stderr 写为二进制 ws 消息（串行化）。
func (b *execBridge) Write(p []byte) (int, error) {
	b.wmu.Lock()
	defer b.wmu.Unlock()
	if err := b.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Next 实现 remotecommand.TerminalSizeQueue：阻塞等待下一个尺寸，会话结束返回 nil。
func (b *execBridge) Next() *remotecommand.TerminalSize {
	select {
	case size := <-b.sizeCh:
		return &size
	case <-b.done:
		return nil
	}
}

// readLoop 持续读 ws：resize 控制消息驱动尺寸队列，其余消息写入 stdin。
func (b *execBridge) readLoop() {
	defer b.close()
	for {
		mt, data, err := b.conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.TextMessage && b.handleControl(data) {
			continue
		}
		if _, err := b.stdinW.Write(data); err != nil {
			return
		}
	}
}

// handleControl 解析 resize 控制消息；命中返回 true，否则 false（按普通输入处理）。
func (b *execBridge) handleControl(data []byte) bool {
	var msg struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "resize" {
		return false
	}
	select {
	case b.sizeCh <- remotecommand.TerminalSize{Width: msg.Cols, Height: msg.Rows}:
	case <-b.done:
	}
	return true
}

// close 幂等清理：取消 ctx、关 stdin 管道、关闭连接。
func (b *execBridge) close() {
	b.closeOnce.Do(func() {
		close(b.done)
		b.cancel()
		_ = b.stdinW.Close()
		_ = b.conn.Close()
	})
}

// sendWSError 向客户端回送一条错误消息并发起关闭握手。
func sendWSError(conn *websocket.Conn, msg string) {
	payload, _ := json.Marshal(map[string]string{"type": "error", "message": msg})
	_ = conn.WriteMessage(websocket.TextMessage, payload)
	reason := msg
	if len(reason) > 120 {
		reason = reason[:120]
	}
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseInternalServerErr, reason),
		time.Now().Add(time.Second),
	)
}
