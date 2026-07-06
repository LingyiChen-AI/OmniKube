package handler

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestFlattenAPIResources(t *testing.T) {
	lists := []*metav1.APIResourceList{
		{
			GroupVersion: "apps/v1",
			APIResources: []metav1.APIResource{
				{Name: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"get", "list", "create"}},
				{Name: "deployments/status", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"get"}}, // 子资源,跳过
				{Name: "replicasets", Kind: "ReplicaSet", Namespaced: true, Verbs: metav1.Verbs{"get", "list"}},
			},
		},
		{
			GroupVersion: "v1",
			APIResources: []metav1.APIResource{
				{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"get", "list"}},
				{Name: "componentstatuses", Kind: "ComponentStatus", Namespaced: false, Verbs: metav1.Verbs{"get"}}, // 无 list,跳过
			},
		},
	}
	got := flattenAPIResources(lists)

	// 子资源与无 list 的被过滤:剩 pods/deployments/replicasets,按 group 再 resource 排序
	// (core "" 组排在 "apps" 前 → pods,然后 apps: deployments, replicasets)。
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3: %+v", len(got), got)
	}
	if got[0].Resource != "pods" || got[0].Group != "" {
		t.Fatalf("got[0] = %+v, want pods(core)", got[0])
	}
	if got[1].Resource != "deployments" || got[1].Group != "apps" {
		t.Fatalf("got[1] = %+v, want apps/deployments", got[1])
	}
	if got[2].Resource != "replicasets" {
		t.Fatalf("got[2] = %+v, want replicasets", got[2])
	}
	if !got[1].Builtin {
		t.Fatalf("deployments 应 builtin=true")
	}
	if got[2].Builtin {
		t.Fatalf("replicasets 应 builtin=false")
	}
	if !got[0].Namespaced {
		t.Fatalf("pods 应 namespaced=true")
	}
}
