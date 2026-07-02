package notify

import "fmt"

// ---- DingTalk: markdown message ----------------------------------------

func dingtalkPayload(r Release) map[string]any {
	text := fmt.Sprintf(
		"### 🚀 发布通知 · %s\n\n"+
			"**资源**：`%s` %s / **%s**\n\n"+
			"- **发布人**：%s\n"+
			"- **发布类型**：%s\n"+
			"- **命名空间**：%s\n"+
			"- **镜像**：%s\n"+
			"- **发布时间**：%s\n"+
			"- **更改原因**：%s\n",
		safe(r.ClusterName, r.ClusterID),
		safe(r.ClusterName, r.ClusterID), r.Namespace, r.Name,
		dash(r.Releaser),
		dash(r.Kind),
		dash(r.Namespace),
		dash(imageLine(r.ImageBefore, r.ImageAfter)),
		ts(r.Time),
		dash(r.Comment),
	)
	return map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]any{
			"title": "发布通知 · " + r.Name,
			"text":  text,
		},
	}
}

// ---- WeCom (企业微信): markdown message ---------------------------------

func wecomPayload(r Release) map[string]any {
	content := fmt.Sprintf(
		"### 🚀 发布通知\n"+
			"> 集群：<font color=\"info\">%s</font>\n"+
			"> 资源：**%s** (`%s`)\n"+
			"> 发布人：<font color=\"comment\">%s</font>\n"+
			"> 发布类型：%s\n"+
			"> 命名空间：%s\n"+
			"> 镜像：%s\n"+
			"> 发布时间：%s\n"+
			"> 更改原因：<font color=\"warning\">%s</font>",
		safe(r.ClusterName, r.ClusterID),
		r.Name, r.Kind,
		dash(r.Releaser),
		dash(r.Kind),
		dash(r.Namespace),
		dash(imageLine(r.ImageBefore, r.ImageAfter)),
		ts(r.Time),
		dash(r.Comment),
	)
	return map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]any{
			"content": content,
		},
	}
}

// ---- Feishu (飞书): interactive card ------------------------------------

func feishuField(label, value string) map[string]any {
	return map[string]any{
		"is_short": true,
		"text": map[string]any{
			"tag":     "lark_md",
			"content": fmt.Sprintf("**%s**\n%s", label, dash(value)),
		},
	}
}

func feishuPayload(r Release) map[string]any {
	fields := []map[string]any{
		feishuField("发布人", r.Releaser),
		feishuField("发布类型", r.Kind),
		feishuField("命名空间", r.Namespace),
		feishuField("发布时间", ts(r.Time)),
	}
	elements := []any{
		map[string]any{"tag": "div", "fields": fields},
		map[string]any{"tag": "div", "text": map[string]any{
			"tag": "lark_md", "content": "**镜像**\n" + dash(imageLine(r.ImageBefore, r.ImageAfter)),
		}},
		map[string]any{"tag": "div", "text": map[string]any{
			"tag": "lark_md", "content": "**更改原因**\n" + dash(r.Comment),
		}},
	}
	return map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"config": map[string]any{"wide_screen_mode": true},
			"header": map[string]any{
				"template": "blue",
				"title": map[string]any{
					"tag":     "plain_text",
					"content": fmt.Sprintf("🚀 发布通知 · %s / %s", safe(r.ClusterName, r.ClusterID), r.Name),
				},
			},
			"elements": elements,
		},
	}
}

func dash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

// safe returns the first non-empty of name, fallback.
func safe(name, fallback string) string {
	if name != "" {
		return name
	}
	if fallback != "" {
		return fallback
	}
	return "—"
}
