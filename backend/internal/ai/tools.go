package ai

import (
	"context"
	"fmt"
	"log"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"omnikube/internal/cluster"
)

// listLimit 限制单次列举回传给模型的资源条数，保护上下文窗口；同时用作 K8s ListOptions.Limit。
const listLimit = 100

// listParams / getParams 是暴露给模型的工具入参（json 标签即模型可见参数名）。
type listParams struct {
	Resource  string `json:"resource" jsonschema:"required" jsonschema_description:"资源的规范复数名，如 deployments/pods/services"`
	Namespace string `json:"namespace" jsonschema_description:"命名空间；命名空间型资源不填则跨可见范围列举"`
}

type getParams struct {
	Resource  string `json:"resource" jsonschema:"required" jsonschema_description:"资源的规范复数名，如 deployments/pods"`
	Namespace string `json:"namespace" jsonschema_description:"命名空间；命名空间型资源必填"`
	Name      string `json:"name" jsonschema:"required" jsonschema_description:"资源名称"`
}

// resourceSummary 是回传给模型的紧凑摘要（只含名字与关键状态，保护上下文窗口）。
type resourceSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Status    string `json:"status,omitempty"`
}

// listResult / getResult 为工具返回值；被 denied 时只填 Error（不返回 Go error，避免中断 agent）。
type listResult struct {
	Items     []resourceSummary `json:"items,omitempty"`
	Count     int               `json:"count,omitempty"`
	Truncated bool              `json:"truncated,omitempty"` // 命中 listLimit 截断，模型据此知悉结果不完整。
	Error     string            `json:"error,omitempty"`
}

type getResult struct {
	resourceSummary
	Error string `json:"error,omitempty"`
}

// ReadTools 构建供 ReAct agent 使用的只读工具集（list_resources / get_resource）。
// 每次调用都会经 guard 的双闸门校验（AI 授予矩阵 + 用户自身 RBAC），未授权时返回
// 结构化的 permission denied 结果而非报错崩溃。列举路径还会据 rbac 的可见 NS 子集
// 把「集群级只读」收敛为「逐 NS 聚合」，绝不越权全集群列举（见 AllowRead）。
func ReadTools(pool *cluster.ClusterPool, clusterID string, guard *Guard, userID uint) []tool.BaseTool {
	listTool, err := utils.InferTool("list_resources",
		"列出指定命名空间下某类资源（返回名称与关键状态摘要）。",
		func(ctx context.Context, p listParams) (listResult, error) {
			cc, ok := pool.Get(clusterID)
			if !ok {
				return listResult{Error: fmt.Sprintf("cluster %s 不存在或未连接", clusterID)}, nil
			}
			// 先解析 GVR，再用规范复数名过闸门：把 deploy/deployment 归一到 deployments
			// 后再比对授予矩阵；解析失败即 fail-closed。
			gvr, namespaced, err := resolveGVR(cc, p.Resource)
			if err != nil {
				return listResult{Error: fmt.Sprintf("解析资源 %s 失败: %v", p.Resource, err)}, nil
			}
			canonical := gvr.Resource

			allowed, visibleNS := guard.AllowRead(userID, clusterID, p.Namespace, canonical)
			if !allowed {
				return listResult{Error: fmt.Sprintf("permission denied: 无权读取集群 %s 命名空间 %s 的 %s", clusterID, p.Namespace, canonical)}, nil
			}

			ri := cc.Dynamic.Resource(gvr)
			opts := metav1.ListOptions{Limit: listLimit}

			// 集群型资源 → 全量单次列举。
			if !namespaced {
				list, err := ri.List(ctx, opts)
				return summarizeList(list, err)
			}
			// 命名空间型且指定了具体 namespace（已被单 NS 闸门放行）→ 单 NS 列举。
			if p.Namespace != "" {
				list, err := ri.Namespace(p.Namespace).List(ctx, opts)
				return summarizeList(list, err)
			}

			// 命名空间型且 namespace 为空（集群级聚合）。
			if visibleNS == nil {
				// 无约束（admin / 集群级角色）→ 全集群列举。
				list, err := ri.List(ctx, opts)
				return summarizeList(list, err)
			}
			// 受控集群级只读：只遍历可见 NS 逐一聚合，绝不全集群列举。
			out := listResult{Items: make([]resourceSummary, 0, listLimit)}
			for _, n := range visibleNS {
				list, err := ri.Namespace(n).List(ctx, metav1.ListOptions{Limit: listLimit})
				if err != nil {
					return listResult{Error: fmt.Sprintf("列举失败: %v", err)}, nil
				}
				for i := range list.Items {
					if len(out.Items) >= listLimit {
						out.Truncated = true
						break
					}
					out.Items = append(out.Items, summarize(&list.Items[i]))
				}
				if out.Truncated {
					break
				}
			}
			out.Count = len(out.Items)
			return out, nil
		})
	if err != nil {
		log.Printf("ai: 构建 list_resources 工具失败: %v", err)
	}

	getTool, gerr := utils.InferTool("get_resource",
		"读取单个资源的名称与关键状态摘要。",
		func(ctx context.Context, p getParams) (getResult, error) {
			cc, ok := pool.Get(clusterID)
			if !ok {
				return getResult{Error: fmt.Sprintf("cluster %s 不存在或未连接", clusterID)}, nil
			}
			gvr, namespaced, err := resolveGVR(cc, p.Resource)
			if err != nil {
				return getResult{Error: fmt.Sprintf("解析资源 %s 失败: %v", p.Resource, err)}, nil
			}
			// get_resource 走具体 namespace，用规范复数名过闸门即可（visibleNS 无关）。
			if allowed, _ := guard.AllowRead(userID, clusterID, p.Namespace, gvr.Resource); !allowed {
				return getResult{Error: fmt.Sprintf("permission denied: 无权读取集群 %s 命名空间 %s 的 %s", clusterID, p.Namespace, gvr.Resource)}, nil
			}
			var obj *unstructured.Unstructured
			if namespaced {
				obj, err = cc.Dynamic.Resource(gvr).Namespace(p.Namespace).Get(ctx, p.Name, metav1.GetOptions{})
			} else {
				obj, err = cc.Dynamic.Resource(gvr).Get(ctx, p.Name, metav1.GetOptions{})
			}
			if err != nil {
				return getResult{Error: fmt.Sprintf("读取失败: %v", err)}, nil
			}
			return getResult{resourceSummary: summarize(obj)}, nil
		})
	if gerr != nil {
		log.Printf("ai: 构建 get_resource 工具失败: %v", gerr)
	}

	tools := make([]tool.BaseTool, 0, 2)
	if listTool != nil {
		tools = append(tools, listTool)
	}
	if getTool != nil {
		tools = append(tools, getTool)
	}
	return tools
}

// summarizeList 把一次列举结果压成 listResult（超过 listLimit 截断并置 Truncated）。
func summarizeList(list *unstructured.UnstructuredList, err error) (listResult, error) {
	if err != nil {
		return listResult{Error: fmt.Sprintf("列举失败: %v", err)}, nil
	}
	out := listResult{Items: make([]resourceSummary, 0, len(list.Items))}
	for i := range list.Items {
		if len(out.Items) >= listLimit {
			out.Truncated = true
			break
		}
		out.Items = append(out.Items, summarize(&list.Items[i]))
	}
	out.Count = len(out.Items)
	return out, nil
}

// resolveGVR 经 RESTMapper 把规范资源名解析为完整 GVR，并返回是否命名空间型
// （与 handler.resolveGVR 同逻辑，此处复制以免跨包依赖）。
func resolveGVR(cc *cluster.ClusterClient, resource string) (schema.GroupVersionResource, bool, error) {
	gvr, err := cc.RESTMapper.ResourceFor(schema.GroupVersionResource{Resource: resource})
	if err != nil {
		return gvr, false, err
	}
	gvk, err := cc.RESTMapper.KindFor(gvr)
	if err != nil {
		return gvr, false, err
	}
	mapping, err := cc.RESTMapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return gvr, false, err
	}
	return gvr, mapping.Scope.Name() == meta.RESTScopeNameNamespace, nil
}

// summarize 从 unstructured 对象抽取紧凑摘要：名字、命名空间、kind、以及一个
// 可读的状态串（优先 status.phase；工作负载则用 readyReplicas/replicas）。
func summarize(obj *unstructured.Unstructured) resourceSummary {
	s := resourceSummary{
		Name:      obj.GetName(),
		Namespace: obj.GetNamespace(),
		Kind:      obj.GetKind(),
	}
	if phase, ok, _ := unstructured.NestedString(obj.Object, "status", "phase"); ok && phase != "" {
		s.Status = phase
		return s
	}
	ready, okR, _ := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
	desired, okD, _ := unstructured.NestedInt64(obj.Object, "status", "replicas")
	if okR || okD {
		s.Status = fmt.Sprintf("%d/%d ready", ready, desired)
	}
	return s
}
