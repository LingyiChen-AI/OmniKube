package ai

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"omnikube/internal/cluster"
)

func toolsMapper() meta.RESTMapper {
	m := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "apps", Version: "v1"}})
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, meta.RESTScopeNamespace)
	return m
}

func deploy(ns, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"status":     map[string]interface{}{"readyReplicas": int64(1), "replicas": int64(2)},
	}}
}

// fakeToolsCluster 组装一个装有两个 deployment 的 fake 动态客户端连接池。
func fakeToolsCluster(t *testing.T) *cluster.ClusterPool {
	t.Helper()
	scheme := runtime.NewScheme()
	gvrToList := map[schema.GroupVersionResource]string{
		{Group: "apps", Version: "v1", Resource: "deployments"}: "DeploymentList",
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList,
		deploy("dev", "web"), deploy("dev", "api"))
	cc := &cluster.ClusterClient{Dynamic: dyn, RESTMapper: toolsMapper()}
	pool := cluster.NewPool(nil, nil, nil)
	pool.Set("c1", cc)
	return pool
}

func findTool(t *testing.T, tools []tool.BaseTool, name string) tool.InvokableTool {
	t.Helper()
	for _, tl := range tools {
		info, err := tl.Info(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if info.Name == name {
			it, ok := tl.(tool.InvokableTool)
			if !ok {
				t.Fatalf("%s is not invokable", name)
			}
			return it
		}
	}
	t.Fatalf("tool %s not found", name)
	return nil
}

func allowGuard(t *testing.T, allow bool) *Guard {
	t.Helper()
	store := NewStore(testDB(t), testCipher(t))
	if err := store.SaveGrant("c1", map[string][]string{"deployments": {"view"}}); err != nil {
		t.Fatal(err)
	}
	return &Guard{store: store, rbac: stubAuthorizer{allow: allow}}
}

func TestReadTools_ListReturnsNames(t *testing.T) {
	pool := fakeToolsCluster(t)
	tools := ReadTools(pool, "c1", allowGuard(t, true), 1)
	lt := findTool(t, tools, "list_resources")

	out, err := lt.InvokableRun(context.Background(), `{"resource":"deployments","namespace":"dev"}`)
	if err != nil {
		t.Fatalf("InvokableRun err: %v", err)
	}
	var res struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	names := map[string]bool{}
	for _, it := range res.Items {
		names[it.Name] = true
	}
	if !names["web"] || !names["api"] {
		t.Fatalf("expected web+api, got %q", out)
	}
}

func TestReadTools_DenyReturnsStructuredResult(t *testing.T) {
	pool := fakeToolsCluster(t)
	// rbac 拒绝 → 双闸门不通过。
	tools := ReadTools(pool, "c1", allowGuard(t, false), 1)
	lt := findTool(t, tools, "list_resources")

	out, err := lt.InvokableRun(context.Background(), `{"resource":"deployments","namespace":"dev"}`)
	if err != nil {
		t.Fatalf("denial must NOT be an error, got: %v", err)
	}
	var res struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Error == "" {
		t.Fatalf("expected permission denied error field, got %q", out)
	}
}

func TestReadTools_Get(t *testing.T) {
	pool := fakeToolsCluster(t)
	tools := ReadTools(pool, "c1", allowGuard(t, true), 1)
	gt := findTool(t, tools, "get_resource")

	out, err := gt.InvokableRun(context.Background(), `{"resource":"deployments","namespace":"dev","name":"web"}`)
	if err != nil {
		t.Fatalf("InvokableRun err: %v", err)
	}
	var res struct {
		Name  string `json:"name"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("bad json %q: %v", out, err)
	}
	if res.Name != "web" {
		t.Fatalf("expected name web, got %q", out)
	}
}
