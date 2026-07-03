package ai

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"omnikube/internal/cluster"
)

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
	Items []resourceSummary `json:"items,omitempty"`
	Count int               `json:"count,omitempty"`
	Error string            `json:"error,omitempty"`
}

type getResult struct {
	resourceSummary
	Error string `json:"error,omitempty"`
}

// ReadTools 构建供 ReAct agent 使用的只读工具集（list_resources / get_resource）。
// 每次调用都会经 guard.Allow(userID, clusterID, ns, resource, "view") 双闸门校验，
// 未授权时返回结构化的 permission denied 结果而非报错崩溃。
func ReadTools(pool *cluster.ClusterPool, clusterID string, guard *Guard, userID uint) []tool.BaseTool {
	listTool, _ := utils.InferTool("list_resources",
		"列出指定命名空间下某类资源（返回名称与关键状态摘要）。",
		func(ctx context.Context, p listParams) (listResult, error) {
			if !guard.Allow(userID, clusterID, p.Namespace, p.Resource, "view") {
				return listResult{Error: fmt.Sprintf("permission denied: 无权读取集群 %s 命名空间 %s 的 %s", clusterID, p.Namespace, p.Resource)}, nil
			}
			cc, ok := pool.Get(clusterID)
			if !ok {
				return listResult{Error: fmt.Sprintf("cluster %s 不存在或未连接", clusterID)}, nil
			}
			gvr, namespaced, err := resolveGVR(cc, p.Resource)
			if err != nil {
				return listResult{Error: fmt.Sprintf("解析资源 %s 失败: %v", p.Resource, err)}, nil
			}
			ri := cc.Dynamic.Resource(gvr)
			var list *unstructured.UnstructuredList
			if namespaced && p.Namespace != "" {
				list, err = ri.Namespace(p.Namespace).List(ctx, metav1.ListOptions{})
			} else {
				list, err = ri.List(ctx, metav1.ListOptions{})
			}
			if err != nil {
				return listResult{Error: fmt.Sprintf("列举失败: %v", err)}, nil
			}
			out := listResult{Items: make([]resourceSummary, 0, len(list.Items))}
			for i := range list.Items {
				out.Items = append(out.Items, summarize(&list.Items[i]))
			}
			out.Count = len(out.Items)
			return out, nil
		})

	getTool, _ := utils.InferTool("get_resource",
		"读取单个资源的名称与关键状态摘要。",
		func(ctx context.Context, p getParams) (getResult, error) {
			if !guard.Allow(userID, clusterID, p.Namespace, p.Resource, "view") {
				return getResult{Error: fmt.Sprintf("permission denied: 无权读取集群 %s 命名空间 %s 的 %s", clusterID, p.Namespace, p.Resource)}, nil
			}
			cc, ok := pool.Get(clusterID)
			if !ok {
				return getResult{Error: fmt.Sprintf("cluster %s 不存在或未连接", clusterID)}, nil
			}
			gvr, namespaced, err := resolveGVR(cc, p.Resource)
			if err != nil {
				return getResult{Error: fmt.Sprintf("解析资源 %s 失败: %v", p.Resource, err)}, nil
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

	tools := make([]tool.BaseTool, 0, 2)
	if listTool != nil {
		tools = append(tools, listTool)
	}
	if getTool != nil {
		tools = append(tools, getTool)
	}
	return tools
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
