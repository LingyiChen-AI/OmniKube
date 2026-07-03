package ai

import (
	"context"

	model "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino-ext/components/model/openai"
)

// BuildChatModel 依据 AI 配置构建一个 Eino 的 ToolCallingChatModel（OpenAI 兼容端点）。
// 仅做构造，不发起网络请求；APIKey/BaseURL/ModelID 来自 Store.LoadConfig。
func BuildChatModel(ctx context.Context, cfg Config) (model.ToolCallingChatModel, error) {
	oc := &openai.ChatModelConfig{
		APIKey:  cfg.APIKey,
		BaseURL: cfg.BaseURL,
		Model:   cfg.ModelID,
	}
	// Temperature 仅在显式设置(>0)时下发；openai 侧为 *float32 指针语义。
	if cfg.Temperature > 0 {
		t := float32(cfg.Temperature)
		oc.Temperature = &t
	}
	return openai.NewChatModel(ctx, oc)
}
