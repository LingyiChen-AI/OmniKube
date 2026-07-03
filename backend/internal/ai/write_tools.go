package ai

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"omnikube/internal/cluster"
)

// StagedAction 是一个「已暂存、待用户确认」的写操作。它由写工具在 agent 一轮内收集，
// 经用户确认后才由 Executor 真正下发到集群。Manifest 为 create/update 的资源清单
// （delete 为 nil）。Resource 恒为规范复数名（已过 GVR 解析归一）。
type StagedAction struct {
	Action    string         `json:"action"`    // create / update / delete
	Resource  string         `json:"resource"`  // 规范复数名，如 deployments
	Namespace string         `json:"namespace"` // 命名空间型资源必填；集群型为空
	Name      string         `json:"name"`      // 资源名（create 从 manifest.metadata.name 抽取）
	Manifest  map[string]any `json:"manifest,omitempty"`
}

// Stager 是「每次对话轮」共享的写操作收集器：写工具 STAGE 时 Add，
// Runner 一轮结束后读取 Actions 决定是否发起确认。并发安全（工具可能被并发调用）。
type Stager struct {
	mu      sync.Mutex
	actions []StagedAction
}

// Add 追加一个暂存动作。
func (s *Stager) Add(a StagedAction) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.actions = append(s.actions, a)
}

// Actions 返回已暂存动作的快照副本。
func (s *Stager) Actions() []StagedAction {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]StagedAction, len(s.actions))
	copy(out, s.actions)
	return out
}

// createWriteParams / updateWriteParams / deleteWriteParams 是暴露给模型的写工具入参。
type createWriteParams struct {
	Resource  string         `json:"resource" jsonschema:"required" jsonschema_description:"资源的规范复数名，如 deployments/services"`
	Namespace string         `json:"namespace" jsonschema_description:"命名空间；命名空间型资源必填"`
	Manifest  map[string]any `json:"manifest" jsonschema:"required" jsonschema_description:"完整的资源清单对象（含 apiVersion/kind/metadata/spec）"`
}

type updateWriteParams struct {
	Resource  string         `json:"resource" jsonschema:"required" jsonschema_description:"资源的规范复数名，如 deployments"`
	Namespace string         `json:"namespace" jsonschema_description:"命名空间；命名空间型资源必填"`
	Name      string         `json:"name" jsonschema:"required" jsonschema_description:"要更新的资源名称"`
	Manifest  map[string]any `json:"manifest" jsonschema:"required" jsonschema_description:"更新后的完整资源清单对象"`
}

type deleteWriteParams struct {
	Resource  string `json:"resource" jsonschema:"required" jsonschema_description:"资源的规范复数名，如 deployments"`
	Namespace string `json:"namespace" jsonschema_description:"命名空间；命名空间型资源必填"`
	Name      string `json:"name" jsonschema:"required" jsonschema_description:"要删除的资源名称"`
}

// stageResult 是写工具回给模型的结构化观测：暂存成功置 Staged+Summary，
// 未授权/解析失败只填 Error（绝不返回 Go error，避免中断 agent）。
type stageResult struct {
	Staged  bool   `json:"staged,omitempty"`
	Summary string `json:"summary,omitempty"`
	Error   string `json:"error,omitempty"`
}

// gateAction 把写工具动词映射为闸门动作（与 AI 授予矩阵/rbac 的动作口径对齐）：
// create→create、update→edit、delete→delete。Guard.Allow 内再把 edit 映射为 casbin write。
func gateAction(verb string) string {
	if verb == "update" {
		return "edit"
	}
	return verb
}

// WriteTools 构建供 ReAct agent 使用的写工具集（create/update/delete_resource）。
//
// 关键设计：写工具「只暂存、不执行」。每次调用会（1）解析 GVR 归一资源名；
// （2）经 Guard.Allow 的双闸门（AI 授予矩阵 ∩ 用户 RBAC）校验写动作，未授权即返回
// 结构化 permission denied 且不暂存；（3）授权则把动作追加进共享 stager 并返回「已暂存」
// 观测——绝不触碰动态客户端。真正的下发在用户确认后由 Executor 完成（见 executor.go），
// 且届时会再次过闸门（defence in depth）。
func WriteTools(pool *cluster.ClusterPool, clusterID string, guard *Guard, userID uint, stager *Stager) []tool.BaseTool {
	// stage 是三个工具共享的暂存逻辑：解析 GVR → 过闸门 → Add。name 为空（create）时
	// 从 manifest.metadata.name 抽取，供确认卡片与审计使用。
	stage := func(verb, resource, namespace, name string, manifest map[string]any) (stageResult, error) {
		cc, ok := pool.Get(clusterID)
		if !ok {
			return stageResult{Error: fmt.Sprintf("cluster %s 不存在或未连接", clusterID)}, nil
		}
		gvr, _, err := resolveGVR(cc, resource)
		if err != nil {
			return stageResult{Error: fmt.Sprintf("解析资源 %s 失败: %v", resource, err)}, nil
		}
		canonical := gvr.Resource
		// 闸门 1/2：写动作必须同时满足 AI 授予矩阵与用户 RBAC，否则拒绝且不暂存。
		if !guard.Allow(userID, clusterID, namespace, canonical, gateAction(verb)) {
			return stageResult{Error: fmt.Sprintf("permission denied: 无权在集群 %s 命名空间 %s 对 %s 执行 %s", clusterID, namespace, canonical, verb)}, nil
		}
		if name == "" && manifest != nil {
			name, _, _ = unstructured.NestedString(manifest, "metadata", "name")
		}
		stager.Add(StagedAction{Action: verb, Resource: canonical, Namespace: namespace, Name: name, Manifest: manifest})
		return stageResult{Staged: true, Summary: fmt.Sprintf("已暂存待确认：将 %s %s/%s（命名空间 %s），等待用户确认", verb, canonical, name, namespace)}, nil
	}

	createTool, err := utils.InferTool("create_resource",
		"创建一个资源（仅暂存，等待用户确认后才执行；调用后请停止并等待用户确认，不要声称已创建）。",
		func(ctx context.Context, p createWriteParams) (stageResult, error) {
			return stage("create", p.Resource, p.Namespace, "", p.Manifest)
		})
	if err != nil {
		log.Printf("ai: 构建 create_resource 工具失败: %v", err)
	}

	updateTool, uerr := utils.InferTool("update_resource",
		"更新一个已存在的资源（仅暂存，等待用户确认后才执行；调用后请停止并等待用户确认）。",
		func(ctx context.Context, p updateWriteParams) (stageResult, error) {
			return stage("update", p.Resource, p.Namespace, p.Name, p.Manifest)
		})
	if uerr != nil {
		log.Printf("ai: 构建 update_resource 工具失败: %v", uerr)
	}

	deleteTool, derr := utils.InferTool("delete_resource",
		"删除一个资源（仅暂存，等待用户确认后才执行；调用后请停止并等待用户确认）。",
		func(ctx context.Context, p deleteWriteParams) (stageResult, error) {
			return stage("delete", p.Resource, p.Namespace, p.Name, nil)
		})
	if derr != nil {
		log.Printf("ai: 构建 delete_resource 工具失败: %v", derr)
	}

	tools := make([]tool.BaseTool, 0, 3)
	for _, tl := range []tool.BaseTool{createTool, updateTool, deleteTool} {
		if tl != nil {
			tools = append(tools, tl)
		}
	}
	return tools
}
