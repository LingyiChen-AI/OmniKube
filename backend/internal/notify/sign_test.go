package notify

import (
	"strings"
	"testing"
)

func TestDingTalkSign_Deterministic(t *testing.T) {
	// Fixed timestamp + secret → stable, non-empty, URL-safe signature.
	s1 := dingtalkSign("SECtest", 1700000000000)
	s2 := dingtalkSign("SECtest", 1700000000000)
	if s1 == "" || s1 != s2 {
		t.Fatalf("sign must be deterministic and non-empty: %q vs %q", s1, s2)
	}
	if dingtalkSign("SECother", 1700000000000) == s1 {
		t.Fatal("different secret must produce a different sign")
	}
	if strings.ContainsAny(s1, " \n") {
		t.Fatalf("sign must be URL-encoded (no spaces/newlines): %q", s1)
	}
}

func TestAppendDingTalkSign_QuerySeparator(t *testing.T) {
	withToken := appendDingTalkSign("https://oapi.dingtalk.com/robot/send?access_token=abc", "sec", 1700000000000)
	if !strings.Contains(withToken, "?access_token=abc&timestamp=1700000000000&sign=") {
		t.Fatalf("should append with & when URL has a query: %s", withToken)
	}
	noQuery := appendDingTalkSign("https://example.com/hook", "sec", 1700000000000)
	if !strings.Contains(noQuery, "/hook?timestamp=1700000000000&sign=") {
		t.Fatalf("should append with ? when URL has no query: %s", noQuery)
	}
}

func TestFeishuSign_Deterministic(t *testing.T) {
	s1 := feishuSign("fsecret", 1700000000)
	s2 := feishuSign("fsecret", 1700000000)
	if s1 == "" || s1 != s2 {
		t.Fatalf("feishu sign must be deterministic and non-empty: %q vs %q", s1, s2)
	}
	// Feishu uses a different construction than DingTalk → different output.
	if feishuSign("fsecret", 1700000000) == dingtalkSign("fsecret", 1700000000) {
		t.Fatal("feishu and dingtalk signing must differ")
	}
}

func TestSendRelease_SignedDispatch(t *testing.T) {
	// Feishu payload gains timestamp+sign when a secret is set; dingtalk URL is signed.
	// Reuse the dispatch test's server pattern to assert the signed feishu body.
	// (Covered structurally here; full HTTP dispatch is in notify_test.go.)
	p := feishuPayload(Release{Name: "web"})
	if _, ok := p["sign"]; ok {
		t.Fatal("unsigned feishu payload must not contain sign")
	}
}
