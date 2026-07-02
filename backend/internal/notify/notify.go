// Package notify pushes release notifications to chat-bot webhooks
// (DingTalk / Feishu / WeCom). All sends are best-effort and non-blocking.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// Bot webhook types.
const (
	TypeDingTalk = "dingtalk"
	TypeFeishu   = "feishu"
	TypeWeCom    = "wecom"
)

// Webhook is a single configured bot: a platform type + its URL, plus an
// optional signing secret (钉钉/飞书「加签」安全设置; 企业微信不使用)。
type Webhook struct {
	Type   string `json:"type"`
	URL    string `json:"url"`
	Secret string `json:"secret,omitempty"`
}

// Release is the payload rendered into each bot message.
type Release struct {
	ClusterName string
	ClusterID   string
	Namespace   string
	Kind        string // 发布类型: Deployment / StatefulSet / DaemonSet
	Name        string
	Releaser    string
	ImageBefore string // "container=image;..."
	ImageAfter  string
	Comment     string // 更改原因
	Time        time.Time
}

// SendRelease pushes the release to every configured webhook. Runs each send in
// its own goroutine with a short timeout; failures are swallowed (best-effort).
func SendRelease(hooks []Webhook, r Release) {
	if r.Time.IsZero() {
		r.Time = time.Now()
	}
	for _, h := range hooks {
		if h.URL == "" {
			continue
		}
		url := h.URL
		var payload any
		switch h.Type {
		case TypeDingTalk:
			payload = dingtalkPayload(r)
			if h.Secret != "" {
				url = appendDingTalkSign(url, h.Secret, time.Now().UnixMilli())
			}
		case TypeFeishu:
			p := feishuPayload(r)
			if h.Secret != "" {
				tsSec := time.Now().Unix()
				p["timestamp"] = strconv.FormatInt(tsSec, 10)
				p["sign"] = feishuSign(h.Secret, tsSec)
			}
			payload = p
		case TypeWeCom:
			payload = wecomPayload(r) // 企业微信无加签。
		default:
			continue
		}
		go post(url, payload)
	}
}

// ParseWebhooks decodes the cluster's stored JSON webhook list (empty-safe).
func ParseWebhooks(jsonStr string) []Webhook {
	if jsonStr == "" {
		return nil
	}
	var out []Webhook
	if err := json.Unmarshal([]byte(jsonStr), &out); err != nil {
		return nil
	}
	return out
}

func post(url string, body any) {
	b, err := json.Marshal(body)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

func ts(t time.Time) string { return t.Format("2006-01-02 15:04:05") }

// image line: prefer "before → after" when both known, else just after.
func imageLine(before, after string) string {
	if before != "" && after != "" && before != after {
		return before + "  →  " + after
	}
	if after != "" {
		return after
	}
	return before
}
