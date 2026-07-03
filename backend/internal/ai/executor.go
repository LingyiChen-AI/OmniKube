package ai

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"

	"omnikube/internal/audit"
	"omnikube/internal/cluster"
	"omnikube/internal/model"
)

// Executor 在用户确认后真正把暂存的写操作下发到集群，并逐条落审计。
type Executor struct {
	pool  *cluster.ClusterPool
	guard *Guard
	db    *gorm.DB
}

// NewExecutor 装配 Executor。
func NewExecutor(pool *cluster.ClusterPool, guard *Guard, db *gorm.DB) *Executor {
	return &Executor{pool: pool, guard: guard, db: db}
}

// Apply 应用单个已确认的写操作：
//  1. 再次过双闸门（defence in depth——绝不信任模型/暂存态，用户 RBAC 可能已变化）；
//  2. 解析 GVR，按动作用动态客户端 Create/Update/Delete（镜像 handler/resource.go，
//     命名空间型强制覆盖 namespace/name，封堵参数混淆越权）；
//  3. 写一条审计行：action="ai_"+动词（该前缀即 AI 来源标记），actor=发起用户。
//
// 更新（update）动作额外做两件事（对齐 REST UpdateResource 口径）：
//   - 先 GET 当前对象并回填其 metadata.resourceVersion，避免乐观锁冲突导致更新失败；
//   - 若为发布型工作负载且容器镜像发生变更，追加一条 model.ReleaseRecord（前后镜像/发布人）。
//
// 任一步失败返回 error 且不落审计（re-gate 拒绝亦然）。
func (e *Executor) Apply(ctx context.Context, userID uint, username, clusterID string, a StagedAction) error {
	// 1. 二次闸门校验（stage 时已校验一次，此处再校验一次，防授权期间被回收）。
	if !e.guard.Allow(userID, clusterID, a.Namespace, a.Resource, gateAction(a.Action)) {
		return fmt.Errorf("permission denied: 无权在集群 %s 命名空间 %s 对 %s 执行 %s", clusterID, a.Namespace, a.Resource, a.Action)
	}

	cc, ok := e.pool.Get(clusterID)
	if !ok {
		return fmt.Errorf("cluster %s 不存在或未连接", clusterID)
	}
	gvr, namespaced, err := resolveGVR(cc, a.Resource)
	if err != nil {
		return fmt.Errorf("解析资源 %s 失败: %w", a.Resource, err)
	}
	ri := cc.Dynamic.Resource(gvr)

	switch a.Action {
	case "create":
		obj := &unstructured.Unstructured{Object: a.Manifest}
		if namespaced {
			obj.SetNamespace(a.Namespace) // 强制覆盖 manifest 自带 namespace，对齐闸门维度。
			_, err = ri.Namespace(a.Namespace).Create(ctx, obj, metav1.CreateOptions{})
		} else {
			_, err = ri.Create(ctx, obj, metav1.CreateOptions{})
		}
	case "update":
		obj := &unstructured.Unstructured{Object: a.Manifest}
		obj.SetName(a.Name) // 暂存态的 name 为权威来源。
		// 命名空间型强制覆盖 namespace，对齐闸门维度；据此选定 client 作用域。
		var dri dynamic.ResourceInterface = ri
		if namespaced {
			obj.SetNamespace(a.Namespace)
			dri = ri.Namespace(a.Namespace)
		}
		// 先 GET 当前对象：一是回填 resourceVersion（否则乐观锁冲突 → 更新失败），
		// 二是拿到旧对象供发布记录做镜像 diff。
		current, gerr := dri.Get(ctx, a.Name, metav1.GetOptions{})
		if gerr != nil {
			return fmt.Errorf("获取 %s %s/%s 当前状态失败: %w", a.Resource, a.Namespace, a.Name, gerr)
		}
		obj.SetResourceVersion(current.GetResourceVersion())
		// 发布记录：发布型工作负载容器镜像变更时，比对前后镜像集合。
		var relBefore, relAfter string
		if isReleaseWorkload(a.Resource) {
			relBefore = formatImages(containerImages(current))
			relAfter = formatImages(containerImages(obj))
		}
		if _, err = dri.Update(ctx, obj, metav1.UpdateOptions{}); err == nil && relBefore != relAfter {
			// 更新成功且镜像有变更 → 补记一条发布记录（与 REST UpdateResource 同口径）。
			e.recordRelease(userID, username, clusterID, a.Namespace, a.Resource, a.Name, relBefore, relAfter)
		}
	case "delete":
		if namespaced {
			err = ri.Namespace(a.Namespace).Delete(ctx, a.Name, metav1.DeleteOptions{})
		} else {
			err = ri.Delete(ctx, a.Name, metav1.DeleteOptions{})
		}
	default:
		return fmt.Errorf("不支持的动作: %s", a.Action)
	}
	if err != nil {
		return fmt.Errorf("下发 %s %s/%s 失败: %w", a.Action, a.Resource, a.Name, err)
	}

	// 3. 落审计（非阻断）。ok_audit_logs 无 username 列，actor 以数字 UserID 记录
	//    （与全站审计口径一致）；AI 来源由 action 的 "ai_" 前缀标识，SourceIP 留空
	//    （无需为此把 gin 请求上下文一路透传到执行层）。
	audit.Log(e.db, audit.Entry{
		UserID:    strconv.FormatUint(uint64(userID), 10),
		ClusterID: clusterID,
		Namespace: a.Namespace,
		Resource:  a.Resource,
		Action:    "ai_" + a.Action,
		Target:    a.Name,
		Result:    "success",
	})
	return nil
}

// aiWorkloadKind 把工作负载复数名映射到 K8S Kind，同时作为「需记发布」白名单。
// 与 handler.workloadKind 同口径，此处复制以免 ai 包反向依赖 handler 包。
var aiWorkloadKind = map[string]string{
	"deployments":  "Deployment",
	"statefulsets": "StatefulSet",
	"daemonsets":   "DaemonSet",
	"jobs":         "Job",
	"cronjobs":     "CronJob",
}

// isReleaseWorkload 判断资源是否属于「发布记录」捕获范围。
func isReleaseWorkload(resource string) bool {
	_, ok := aiWorkloadKind[resource]
	return ok
}

// containerImages 抽取工作负载 Pod 模板里 container→image 的映射。多数工作负载在
// spec.template.spec.containers；CronJob 多嵌一层 spec.jobTemplate.spec.template。
func containerImages(obj *unstructured.Unstructured) map[string]string {
	out := map[string]string{}
	if obj == nil {
		return out
	}
	containers, found, err := unstructured.NestedSlice(obj.Object, "spec", "template", "spec", "containers")
	if err != nil || !found {
		// CronJob：容器在 jobTemplate 之下。
		containers, found, err = unstructured.NestedSlice(obj.Object, "spec", "jobTemplate", "spec", "template", "spec", "containers")
		if err != nil || !found {
			return out
		}
	}
	for _, c := range containers {
		m, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		image, _ := m["image"].(string)
		if name != "" {
			out[name] = image
		}
	}
	return out
}

// formatImages 把 container→image 映射序列化为稳定字符串 "name=image;..."（按容器名排序）。
func formatImages(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ";")
}

// recordRelease 追加一条发布记录（best-effort：落库失败不影响已成功的更新）。
// Comment 固定为「via OmniKube AI」以标识这是经 AI 助手确认执行的发布。
func (e *Executor) recordRelease(userID uint, username, clusterID, ns, resource, name, before, after string) {
	e.db.Create(&model.ReleaseRecord{
		UserID:      userID,
		Username:    username,
		ClusterID:   clusterID,
		Namespace:   ns,
		Kind:        aiWorkloadKind[resource],
		Name:        name,
		ImageBefore: before,
		ImageAfter:  after,
		Comment:     "via OmniKube AI",
	})
}
