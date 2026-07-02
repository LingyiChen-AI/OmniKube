package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
)

// metricsListKinds registers every GVR the metrics handlers LIST (the fake
// client panics on an unregistered GVR, so all must be present).
func metricsListKinds() map[schema.GroupVersionResource]string {
	return map[schema.GroupVersionResource]string{
		{Group: "", Version: "v1", Resource: "nodes"}:                    "NodeList",
		{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}: "NodeMetricsList",
		{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}:  "PodMetricsList",
	}
}

// metricsApp wires the metrics routes. failMetrics=true installs a reactor that
// errors on metrics.k8s.io LISTs, simulating an absent metrics-server.
func metricsApp(t *testing.T, failMetrics bool, objs ...runtime.Object) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, _ := crypto.New(resKey())
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), metricsListKinds())
	// Seed via the tracker with explicit GVRs — the fake mis-guesses the resource
	// from the "NodeMetrics"/"PodMetrics" kinds otherwise.
	for _, o := range objs {
		u := o.(*unstructured.Unstructured)
		var gvr schema.GroupVersionResource
		switch u.GetKind() {
		case "NodeMetrics":
			gvr = nodeMetricsGVR
		case "PodMetrics":
			gvr = podMetricsGVR
		case "Node":
			gvr = coreNodesGVR
		}
		if err := dyn.Tracker().Create(gvr, u, u.GetNamespace()); err != nil {
			t.Fatalf("seed %s: %v", u.GetKind(), err)
		}
	}
	if failMetrics {
		dyn.PrependReactor("list", "*", func(action k8stesting.Action) (bool, runtime.Object, error) {
			if action.GetResource().Group == "metrics.k8s.io" {
				return true, nil, errors.New("metrics API not available")
			}
			return false, nil, nil
		})
	}
	pool.Set("c1", &cluster.ClusterClient{Dynamic: dyn})
	h := &Handler{DB: db, Pool: pool}

	r := gin.New()
	api := r.Group("/api/v1")
	api.GET("/metrics/available", h.MetricsAvailable)
	api.GET("/metrics/nodes", h.NodeMetrics)
	api.GET("/metrics/pods", h.PodMetrics)
	return r
}

func metricsReq(r *gin.Engine, path string) *httptest.ResponseRecorder {
	req, _ := http.NewRequest("GET", path, nil)
	req.Header.Set("X-Cluster-ID", "c1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func nodeMetricObj(name, cpu, mem string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "metrics.k8s.io/v1beta1", "kind": "NodeMetrics",
		"metadata": map[string]interface{}{"name": name},
		"usage":    map[string]interface{}{"cpu": cpu, "memory": mem},
	}}
}

func coreNodeObj(name, cpu, mem string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]interface{}{"name": name},
		"status":   map[string]interface{}{"allocatable": map[string]interface{}{"cpu": cpu, "memory": mem}},
	}}
}

func podMetricObj(ns, name string, usages ...[2]string) *unstructured.Unstructured {
	containers := []interface{}{}
	for i, u := range usages {
		containers = append(containers, map[string]interface{}{
			"name":  string(rune('a' + i)),
			"usage": map[string]interface{}{"cpu": u[0], "memory": u[1]},
		})
	}
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "metrics.k8s.io/v1beta1", "kind": "PodMetrics",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"containers": containers,
	}}
}

func TestMetricsAvailable(t *testing.T) {
	on := metricsApp(t, false, nodeMetricObj("n1", "100m", "10Mi"))
	var r1 struct {
		Available bool `json:"available"`
	}
	json.Unmarshal(metricsReq(on, "/api/v1/metrics/available").Body.Bytes(), &r1)
	if !r1.Available {
		t.Fatal("expected available=true when metrics-server present")
	}

	off := metricsApp(t, true)
	var r2 struct {
		Available bool `json:"available"`
	}
	json.Unmarshal(metricsReq(off, "/api/v1/metrics/available").Body.Bytes(), &r2)
	if r2.Available {
		t.Fatal("expected available=false when metrics API absent")
	}
}

func TestNodeMetrics_JoinsCapacity(t *testing.T) {
	app := metricsApp(t, false,
		nodeMetricObj("n1", "500m", "1000Mi"),
		coreNodeObj("n1", "2", "4000Mi"),
	)
	var resp struct {
		Available bool         `json:"available"`
		Nodes     []nodeMetric `json:"nodes"`
	}
	json.Unmarshal(metricsReq(app, "/api/v1/metrics/nodes").Body.Bytes(), &resp)
	if !resp.Available || len(resp.Nodes) != 1 {
		t.Fatalf("unexpected: %+v", resp)
	}
	n := resp.Nodes[0]
	if n.CPU != 500 || n.CPUCapacity != 2000 || n.CPUPct != 25 {
		t.Fatalf("cpu join wrong: %+v", n)
	}
	if n.MemPct != 25 {
		t.Fatalf("mem pct wrong: %+v", n)
	}
}

func TestNodeMetrics_DegradesWhenAbsent(t *testing.T) {
	app := metricsApp(t, true)
	var resp struct {
		Available bool         `json:"available"`
		Nodes     []nodeMetric `json:"nodes"`
	}
	w := metricsReq(app, "/api/v1/metrics/nodes")
	if w.Code != http.StatusOK {
		t.Fatalf("degradation must be 200, got %d", w.Code)
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Available || len(resp.Nodes) != 0 {
		t.Fatalf("expected graceful empty degradation, got %+v", resp)
	}
}

func TestPodMetrics_SumsContainers(t *testing.T) {
	app := metricsApp(t, false,
		podMetricObj("dev", "p1", [2]string{"100m", "50Mi"}, [2]string{"200m", "70Mi"}),
	)
	var resp struct {
		Available bool        `json:"available"`
		Pods      []podMetric `json:"pods"`
	}
	json.Unmarshal(metricsReq(app, "/api/v1/metrics/pods").Body.Bytes(), &resp)
	if len(resp.Pods) != 1 {
		t.Fatalf("expected 1 pod, got %+v", resp)
	}
	p := resp.Pods[0]
	if p.CPU != 300 {
		t.Fatalf("expected summed cpu 300m, got %d", p.CPU)
	}
	if p.Memory != (50+70)*1024*1024 {
		t.Fatalf("expected summed mem 120Mi, got %d", p.Memory)
	}
}
