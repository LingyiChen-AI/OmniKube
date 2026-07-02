package notify

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestSendRelease_DispatchesByType(t *testing.T) {
	var mu sync.Mutex
	got := map[string]map[string]any{} // path → decoded body

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		mu.Lock()
		got[r.URL.Path] = m
		mu.Unlock()
		w.WriteHeader(200)
	}))
	defer srv.Close()

	hooks := []Webhook{
		{Type: TypeDingTalk, URL: srv.URL + "/ding"},
		{Type: TypeFeishu, URL: srv.URL + "/feishu"},
		{Type: TypeWeCom, URL: srv.URL + "/wecom"},
		{Type: "bogus", URL: srv.URL + "/nope"}, // unknown type → skipped
	}
	SendRelease(hooks, Release{
		ClusterName: "prod", Namespace: "default", Kind: "Deployment", Name: "web",
		Releaser: "alice", ImageBefore: "app=nginx:1.26", ImageAfter: "app=nginx:1.27",
		Comment: "security patch", Time: time.Now(),
	})

	// sends are async
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n >= 3 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("expected 3 sends (unknown type skipped), got %d: %v", len(got), got)
	}
	if got["/ding"]["msgtype"] != "markdown" {
		t.Fatalf("dingtalk should be markdown, got %v", got["/ding"])
	}
	if got["/feishu"]["msg_type"] != "interactive" {
		t.Fatalf("feishu should be interactive card, got %v", got["/feishu"])
	}
	if got["/wecom"]["msgtype"] != "markdown" {
		t.Fatalf("wecom should be markdown, got %v", got["/wecom"])
	}
	if _, ok := got["/nope"]; ok {
		t.Fatal("unknown webhook type must not be sent")
	}
}

func TestParseWebhooks(t *testing.T) {
	if ParseWebhooks("") != nil {
		t.Fatal("empty string should parse to nil")
	}
	hooks := ParseWebhooks(`[{"type":"dingtalk","url":"https://x"}]`)
	if len(hooks) != 1 || hooks[0].Type != "dingtalk" || hooks[0].URL != "https://x" {
		t.Fatalf("unexpected parse: %v", hooks)
	}
	if ParseWebhooks("not json") != nil {
		t.Fatal("invalid json should parse to nil")
	}
}
