package ai

import (
	"context"

	model "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent/react"
)

// BuildAgent 依据聊天模型、只读工具集与系统提示词装配一个 Eino ReAct agent。
//
//   - cm：ToolCallingChatModel（BuildChatModel 产物）。
//   - tools：ReadTools 产物；经 compose.ToolsNodeConfig 注入。
//   - systemPrompt：非空时以 PersonaModifier 注入为系统人设；为空则不加。
//   - maxStep：ReAct 最大步数；<=0 时交给 react 默认值（节点数+10）。
//
// 仅装配，不发起任何网络请求；真正的模型调用发生在 agent.Generate/Stream。
func BuildAgent(ctx context.Context, cm model.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (*react.Agent, error) {
	cfg := &react.AgentConfig{
		ToolCallingModel: cm,
		ToolsConfig:      compose.ToolsNodeConfig{Tools: tools},
		MaxStep:          maxStep,
	}
	// 仅在显式提供系统提示词时注入人设，避免空 persona 消息污染上下文。
	if systemPrompt != "" {
		cfg.MessageModifier = react.NewPersonaModifier(systemPrompt)
	}
	return react.NewAgent(ctx, cfg)
}
