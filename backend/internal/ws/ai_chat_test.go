package ws

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestAIChat_UnknownCluster_400 升级前校验 cluster_id：未知集群直接 400（不握手）。
func TestAIChat_UnknownCluster_400(t *testing.T) {
	srv, _, h := newWSEnv(t)
	tok := issue(t, h, 5, false)
	_, resp, err := dial(t, srv.URL, "/api/v1/ai/chat", "cluster_id=nope&token="+tok)
	if err != websocket.ErrBadHandshake || resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 bad handshake, got err=%v resp=%v", err, resp)
	}
}

// TestAIChat_Disabled_RefusalFrame AI 未配置（默认 Enabled=false）时：握手成功(101)后
// 立即回一帧 error「AI 助手未启用」并关闭。
func TestAIChat_Disabled_RefusalFrame(t *testing.T) {
	srv, _, h := newWSEnv(t)
	tok := issue(t, h, 5, false)
	conn, resp, err := dial(t, srv.URL, "/api/v1/ai/chat", "cluster_id="+testCluster+"&token="+tok)
	if err != nil {
		t.Fatalf("expected 101 handshake, got err=%v resp=%v", err, resp)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101, got %d", resp.StatusCode)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, rerr := conn.ReadMessage()
	if rerr != nil {
		t.Fatalf("expected a refusal frame, got read error: %v", rerr)
	}
	var ev struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		t.Fatalf("frame not JSON: %v (%q)", err, data)
	}
	if ev.Type != "error" || ev.Text != "AI 助手未启用" {
		t.Fatalf("expected disabled error frame, got %+v", ev)
	}
}
