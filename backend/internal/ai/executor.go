package ai

import (
	"context"
	"fmt"
	"strconv"

	"gorm.io/gorm"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"omnikube/internal/audit"
	"omnikube/internal/cluster"
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
//  3. 写一条审计行：action="ai_"+动词，actor=发起用户，SourceIP 标记 "OmniKube AI"
//     以标识这是经 OmniKube AI 助手确认执行的写操作。
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
		if namespaced {
			obj.SetNamespace(a.Namespace)
			_, err = ri.Namespace(a.Namespace).Update(ctx, obj, metav1.UpdateOptions{})
		} else {
			_, err = ri.Update(ctx, obj, metav1.UpdateOptions{})
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
	//    （与全站审计口径一致）；SourceIP 载 "OmniKube AI" 标记 AI 经确认执行的写操作。
	audit.Log(e.db, audit.Entry{
		UserID:    strconv.FormatUint(uint64(userID), 10),
		ClusterID: clusterID,
		Namespace: a.Namespace,
		Resource:  a.Resource,
		Action:    "ai_" + a.Action,
		Target:    a.Name,
		Result:    "success",
		SourceIP:  "OmniKube AI",
	})
	return nil
}
