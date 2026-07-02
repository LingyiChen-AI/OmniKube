package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"omnikube/internal/cluster"
)

// opsMapper registers all workload + history GVKs used by the ops handlers.
func opsMapper() meta.RESTMapper {
	m := meta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "apps", Version: "v1"}})
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "StatefulSet"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "DaemonSet"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "ReplicaSet"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "ControllerRevision"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "", Version: "v1", Kind: "Event"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: "CronJob"}, meta.RESTScopeNamespace)
	m.Add(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: "Job"}, meta.RESTScopeNamespace)
	return m
}

func opsScheme() (*runtime.Scheme, map[schema.GroupVersionResource]string) {
	return runtime.NewScheme(), map[schema.GroupVersionResource]string{
		{Group: "apps", Version: "v1", Resource: "deployments"}:         "DeploymentList",
		{Group: "apps", Version: "v1", Resource: "statefulsets"}:        "StatefulSetList",
		{Group: "apps", Version: "v1", Resource: "daemonsets"}:          "DaemonSetList",
		{Group: "apps", Version: "v1", Resource: "replicasets"}:         "ReplicaSetList",
		{Group: "apps", Version: "v1", Resource: "controllerrevisions"}: "ControllerRevisionList",
		{Group: "", Version: "v1", Resource: "events"}:                  "EventList",
		{Group: "batch", Version: "v1", Resource: "cronjobs"}:           "CronJobList",
		{Group: "batch", Version: "v1", Resource: "jobs"}:               "JobList",
	}
}

// opsApp wires the workload-ops routes (registered in resApp) against a fake client.
func opsApp(t *testing.T, cc *cluster.ClusterClient) *gin.Engine {
	t.Helper()
	app, _, _ := resApp(t, cc)
	return app
}

func depGVRv() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
}

func depWithRev(ns, name, image, rev string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]interface{}{
			"name": name, "namespace": ns,
			"annotations": map[string]interface{}{"deployment.kubernetes.io/revision": rev},
		},
		"spec": map[string]interface{}{
			"replicas": int64(2),
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{"labels": map[string]interface{}{"app": name}},
				"spec": map[string]interface{}{
					"containers": []interface{}{map[string]interface{}{"name": "app", "image": image}},
				},
			},
		},
	}}
}

func replicaSet(ns, name, owner, image, rev string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1", "kind": "ReplicaSet",
		"metadata": map[string]interface{}{
			"name": name, "namespace": ns,
			"annotations": map[string]interface{}{"deployment.kubernetes.io/revision": rev},
			"ownerReferences": []interface{}{
				map[string]interface{}{"kind": "Deployment", "name": owner, "uid": "u1", "apiVersion": "apps/v1"},
			},
		},
		"spec": map[string]interface{}{
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{
					"labels": map[string]interface{}{"app": owner, "pod-template-hash": "abc" + rev},
				},
				"spec": map[string]interface{}{
					"containers": []interface{}{map[string]interface{}{"name": "app", "image": image}},
				},
			},
		},
	}}
}

func newOpsCC(objs ...runtime.Object) *cluster.ClusterClient {
	scheme, gvrToList := opsScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToList, objs...)
	return &cluster.ClusterClient{Dynamic: dyn, RESTMapper: opsMapper()}
}

func TestScale_Deployment(t *testing.T) {
	cc := newOpsCC(depWithRev("dev", "web", "nginx:1", "1"))
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web/scale", "1", true, map[string]int{"replicas": 5})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got, _ := cc.Dynamic.Resource(depGVRv()).Namespace("dev").Get(t.Context(), "web", metav1.GetOptions{})
	n, _, _ := unstructured.NestedInt64(got.Object, "spec", "replicas")
	if n != 5 {
		t.Fatalf("expected replicas=5, got %d", n)
	}
}

func TestScale_DaemonSetRejected(t *testing.T) {
	ds := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1", "kind": "DaemonSet",
		"metadata": map[string]interface{}{"name": "fluentd", "namespace": "dev"},
		"spec":     map[string]interface{}{"template": map[string]interface{}{}},
	}}
	cc := newOpsCC(ds)
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/daemonsets/fluentd/scale", "1", true, map[string]int{"replicas": 3})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("daemonset scale must be 400, got %d", w.Code)
	}
}

func TestRestart_Deployment(t *testing.T) {
	cc := newOpsCC(depWithRev("dev", "web", "nginx:1", "1"))
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web/restart", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got, _ := cc.Dynamic.Resource(depGVRv()).Namespace("dev").Get(t.Context(), "web", metav1.GetOptions{})
	ann, _, _ := unstructured.NestedStringMap(got.Object, "spec", "template", "metadata", "annotations")
	if ann["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Fatalf("expected restartedAt annotation, got %v", ann)
	}
}

func TestRevisions_Deployment(t *testing.T) {
	cc := newOpsCC(
		depWithRev("dev", "web", "nginx:2", "2"),
		replicaSet("dev", "web-1", "web", "nginx:1", "1"),
		replicaSet("dev", "web-2", "web", "nginx:2", "2"),
		replicaSet("dev", "other-1", "other", "redis:1", "1"), // owned by a different deploy → excluded
	)
	app := opsApp(t, cc)
	w := resReq(app, "GET", "/api/v1/namespaces/dev/resources/deployments/web/revisions", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Revisions []revisionInfo `json:"revisions"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Revisions) != 2 {
		t.Fatalf("expected 2 revisions, got %d: %+v", len(resp.Revisions), resp.Revisions)
	}
	if resp.Revisions[0].Revision != 2 || !resp.Revisions[0].Current {
		t.Fatalf("newest should be rev2 current: %+v", resp.Revisions[0])
	}
	if resp.Revisions[0].Images != "app=nginx:2" {
		t.Fatalf("rev2 images: %q", resp.Revisions[0].Images)
	}
}

func TestRollback_Deployment(t *testing.T) {
	cc := newOpsCC(
		depWithRev("dev", "web", "nginx:2", "2"),
		replicaSet("dev", "web-1", "web", "nginx:1", "1"),
	)
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web/rollback", "1", true, map[string]int{"revision": 1})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	got, _ := cc.Dynamic.Resource(depGVRv()).Namespace("dev").Get(t.Context(), "web", metav1.GetOptions{})
	if containerImages(got)["app"] != "nginx:1" {
		t.Fatalf("rollback should restore nginx:1, got %s", containerImages(got)["app"])
	}
	// pod-template-hash must be stripped from the restored template labels.
	labels, _, _ := unstructured.NestedStringMap(got.Object, "spec", "template", "metadata", "labels")
	if _, ok := labels["pod-template-hash"]; ok {
		t.Fatalf("pod-template-hash must be stripped, got %v", labels)
	}
}

func cronJob(ns, name, image string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "batch/v1", "kind": "CronJob",
		"metadata": map[string]interface{}{"name": name, "namespace": ns, "uid": "cj-uid-1"},
		"spec": map[string]interface{}{
			"schedule": "*/5 * * * *",
			"jobTemplate": map[string]interface{}{
				"metadata": map[string]interface{}{"labels": map[string]interface{}{"app": name}},
				"spec": map[string]interface{}{
					"template": map[string]interface{}{
						"spec": map[string]interface{}{
							"containers": []interface{}{map[string]interface{}{"name": "job", "image": image}},
						},
					},
				},
			},
		},
	}}
}

func TestTriggerCronJob(t *testing.T) {
	cc := newOpsCC(cronJob("dev", "backup", "busybox:1"))
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/cronjobs/backup/trigger", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Job string `json:"job"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Job == "" || !strings.HasPrefix(resp.Job, "backup-manual-") {
		t.Fatalf("unexpected job name: %q", resp.Job)
	}
	// a Job was created in the same namespace from the jobTemplate
	jobsGVR := schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}
	job, err := cc.Dynamic.Resource(jobsGVR).Namespace("dev").Get(t.Context(), resp.Job, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("job not created: %v", err)
	}
	containers, _, _ := unstructured.NestedSlice(job.Object, "spec", "template", "spec", "containers")
	if len(containers) != 1 {
		t.Fatalf("job spec did not carry the jobTemplate container: %+v", job.Object["spec"])
	}
	// owner reference points back at the cronjob
	if len(job.GetOwnerReferences()) != 1 || job.GetOwnerReferences()[0].Kind != "CronJob" {
		t.Fatalf("expected CronJob owner ref, got %+v", job.GetOwnerReferences())
	}
}

func TestTriggerCronJob_WrongResource(t *testing.T) {
	cc := newOpsCC(depWithRev("dev", "web", "nginx:1", "1"))
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web/trigger", "1", true, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("trigger on non-cronjob must be 400, got %d", w.Code)
	}
}

func TestRollback_NotFound(t *testing.T) {
	cc := newOpsCC(
		depWithRev("dev", "web", "nginx:2", "2"),
		replicaSet("dev", "web-1", "web", "nginx:1", "1"),
	)
	app := opsApp(t, cc)
	w := resReq(app, "PUT", "/api/v1/namespaces/dev/resources/deployments/web/rollback", "1", true, map[string]int{"revision": 9})
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing revision, got %d", w.Code)
	}
}
