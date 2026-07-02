package notify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
)

// 钉钉与飞书的「加签」安全设置算法不同：
//   - 钉钉：HMAC-SHA256(key=secret, data="{ms}\n{secret}"), 结果 base64 后 URL-encode,
//     以 &timestamp=&sign= 追加到 webhook URL(时间戳为毫秒)。
//   - 飞书：HMAC-SHA256(key="{sec}\n{secret}", data=空), 结果 base64,
//     以 timestamp/sign 字段写入请求体(时间戳为秒)。

// dingtalkSign 计算钉钉加签(已 URL 编码), tsMillis 为毫秒时间戳。
func dingtalkSign(secret string, tsMillis int64) string {
	stringToSign := fmt.Sprintf("%d\n%s", tsMillis, secret)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stringToSign))
	return url.QueryEscape(base64.StdEncoding.EncodeToString(mac.Sum(nil)))
}

// appendDingTalkSign 把 timestamp+sign 追加到钉钉 webhook URL。
func appendDingTalkSign(webhook, secret string, tsMillis int64) string {
	sep := "?"
	if strings.Contains(webhook, "?") {
		sep = "&"
	}
	return fmt.Sprintf("%s%stimestamp=%d&sign=%s", webhook, sep, tsMillis, dingtalkSign(secret, tsMillis))
}

// feishuSign 计算飞书加签, tsSec 为秒时间戳。
func feishuSign(secret string, tsSec int64) string {
	stringToSign := fmt.Sprintf("%d\n%s", tsSec, secret)
	mac := hmac.New(sha256.New, []byte(stringToSign))
	// 飞书以 stringToSign 为密钥, 空数据。
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
