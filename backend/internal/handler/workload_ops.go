package handler

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"omnikube/internal/cluster"
	"omnikube/internal/model"
)

// scalableWorkloads 支持副本伸缩的资源(有 spec.replicas)。
var scalableWorkloads = map[string]bool{"deployments": true, "statefulsets": true, "replicasets": true}

// restartableWorkloads 支持滚动重启的资源(有 spec.template)。
var restartableWorkloads = map[string]bool{"deployments": true, "statefulsets": true, "daemonsets": true}

// dynRes 解析规范资源名并返回其可命名空间的 dynamic 客户端。
func dynRes(cc *cluster.ClusterClient, resource string) (dynamic.NamespaceableResourceInterface, error) {
	gvr, _, err := resolveGVR(cc, resource)
	if err != nil {
		return nil, err
	}
	return cc.Dynamic.Resource(gvr), nil
}

// ScaleWorkload PUT /namespaces/:namespace/resources/:resource/:name/scale —— 调整副本数。
func (h *Handler) ScaleWorkload(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	resource := c.GetString("auth_resource")
	if !scalableWorkloads[resource] {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "该资源不支持伸缩"})
		return
	}
	var req struct {
		Replicas *int `json:"replicas"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Replicas == nil || *req.Replicas < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "副本数无效"})
		return
	}
	ri, err := dynRes(cc, resource)
	if err != nil {
		writeK8sError(c, err)
		return
	}
	ns, name := c.GetString("auth_namespace"), c.Param("name")
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, *req.Replicas))
	if _, err := ri.Namespace(ns).Patch(c.Request.Context(), name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已伸缩", "replicas": *req.Replicas})
}

// RestartWorkload PUT /namespaces/:namespace/resources/:resource/:name/restart —— 滚动重启。
func (h *Handler) RestartWorkload(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	resource := c.GetString("auth_resource")
	if !restartableWorkloads[resource] {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "该资源不支持重启"})
		return
	}
	ri, err := dynRes(cc, resource)
	if err != nil {
		writeK8sError(c, err)
		return
	}
	ns, name := c.GetString("auth_namespace"), c.Param("name")
	now := time.Now().UTC().Format(time.RFC3339)
	// JSON merge patch 递归合并, 只增设 restartedAt 注解, 保留其它注解。
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`, now))
	if _, err := ri.Namespace(ns).Patch(c.Request.Context(), name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已触发滚动重启", "restartedAt": now})
}

// TriggerCronJob PUT /namespaces/:namespace/resources/:resource/:name/trigger
// 手动触发定时任务:用 CronJob 的 jobTemplate 立即创建一个 Job(等价
// kubectl create job --from=cronjob/<name>),返回新 Job 名以便前端实时看 Pod。
func (h *Handler) TriggerCronJob(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	if c.GetString("auth_resource") != "cronjobs" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "仅定时任务支持触发"})
		return
	}
	ns, name := c.GetString("auth_namespace"), c.Param("name")
	ctx := c.Request.Context()

	cjRi, err := dynRes(cc, "cronjobs")
	if err != nil {
		writeK8sError(c, err)
		return
	}
	cj, err := cjRi.Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	jobTemplate, found, _ := unstructured.NestedMap(cj.Object, "spec", "jobTemplate")
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "该定时任务缺少 jobTemplate"})
		return
	}
	jobSpec, hasSpec, _ := unstructured.NestedMap(jobTemplate, "spec")
	if !hasSpec {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "jobTemplate 缺少 spec"})
		return
	}

	// Job 名:<cronjob>-manual-<unix>,截断确保 ≤63 字符。
	suffix := "-manual-" + strconv.FormatInt(time.Now().Unix(), 10)
	base := name
	if max := 63 - len(suffix); len(base) > max {
		base = base[:max]
	}
	jobName := base + suffix

	meta := map[string]interface{}{
		"name":        jobName,
		"namespace":   ns,
		"annotations": map[string]interface{}{"cronjob.kubernetes.io/instantiate": "manual"},
		"ownerReferences": []interface{}{map[string]interface{}{
			"apiVersion": cj.GetAPIVersion(), "kind": cj.GetKind(),
			"name": cj.GetName(), "uid": string(cj.GetUID()),
		}},
	}
	if labels, ok, _ := unstructured.NestedMap(jobTemplate, "metadata", "labels"); ok && len(labels) > 0 {
		meta["labels"] = labels
	}
	job := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": meta, "spec": jobSpec,
	}}

	jobsRi, err := dynRes(cc, "jobs")
	if err != nil {
		writeK8sError(c, err)
		return
	}
	created, err := jobsRi.Namespace(ns).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已触发", "job": created.GetName()})
}

// revisionInfo 是一条历史版本(用于版本历史列表)。
type revisionInfo struct {
	Revision  int64  `json:"revision"`
	CreatedAt string `json:"created_at"`
	Images    string `json:"images"`  // "name=image;..."
	Changer   string `json:"changer"` // 变更人(按镜像匹配发布记录, 缺失为空)
	Current   bool   `json:"current"`
}

// ListRevisions GET /namespaces/:namespace/resources/:resource/:name/revisions —— 版本历史(倒序)。
func (h *Handler) ListRevisions(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	resource := c.GetString("auth_resource")
	ns, name := c.GetString("auth_namespace"), c.Param("name")

	var (
		revs []revisionInfo
		err  error
	)
	switch resource {
	case "deployments":
		revs, err = deploymentRevisions(c, cc, ns, name)
	case "statefulsets", "daemonsets":
		revs, err = controllerRevisions(c, cc, ns, name, resource)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "该资源不支持版本历史"})
		return
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	// 变更人：按镜像匹配该工作负载的发布记录(发布流程会记录用户名+镜像)。
	changers := h.revisionChangers(c.GetHeader("X-Cluster-ID"), ns, workloadKind[resource], name)
	for i := range revs {
		revs[i].Changer = changers[revs[i].Images]
	}
	sort.Slice(revs, func(i, j int) bool { return revs[i].Revision > revs[j].Revision })
	c.JSON(http.StatusOK, gin.H{"revisions": revs})
}

// revisionChangers 建立「镜像组合 → 变更人」映射(取该镜像最近一次发布的用户名)。
func (h *Handler) revisionChangers(clusterID, ns, kind, name string) map[string]string {
	out := map[string]string{}
	if clusterID == "" || kind == "" {
		return out
	}
	var recs []model.ReleaseRecord
	h.DB.Where("cluster_id = ? AND namespace = ? AND kind = ? AND name = ?", clusterID, ns, kind, name).
		Order("created_at asc").Find(&recs)
	for _, r := range recs {
		if r.ImageAfter != "" && r.Username != "" {
			out[r.ImageAfter] = r.Username // asc 顺序, 后者覆盖 → 最近一次
		}
	}
	return out
}

// deploymentRevisions 聚合 Deployment 的 ReplicaSet 历史。
func deploymentRevisions(c *gin.Context, cc *cluster.ClusterClient, ns, name string) ([]revisionInfo, error) {
	depRi, err := dynRes(cc, "deployments")
	if err != nil {
		return nil, err
	}
	dep, err := depRi.Namespace(ns).Get(c.Request.Context(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	curRev := revisionAnnotation(dep)
	rsRi, err := dynRes(cc, "replicasets")
	if err != nil {
		return nil, err
	}
	list, err := rsRi.Namespace(ns).List(c.Request.Context(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := []revisionInfo{}
	for i := range list.Items {
		rs := &list.Items[i]
		if !ownedBy(rs, "Deployment", name) {
			continue
		}
		rev := revisionAnnotation(rs)
		out = append(out, revisionInfo{
			Revision:  rev,
			CreatedAt: rs.GetCreationTimestamp().UTC().Format(time.RFC3339),
			Images:    formatImages(containerImages(rs)),
			Current:   rev != 0 && rev == curRev,
		})
	}
	return out, nil
}

// controllerRevisions 聚合 StatefulSet/DaemonSet 的 ControllerRevision 历史。
func controllerRevisions(c *gin.Context, cc *cluster.ClusterClient, ns, name, kind string) ([]revisionInfo, error) {
	crRi, err := dynRes(cc, "controllerrevisions")
	if err != nil {
		return nil, err
	}
	list, err := crRi.Namespace(ns).List(c.Request.Context(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	ownerKind := "StatefulSet"
	if kind == "daemonsets" {
		ownerKind = "DaemonSet"
	}
	out := []revisionInfo{}
	var maxRev int64
	for i := range list.Items {
		cr := &list.Items[i]
		if !ownedBy(cr, ownerKind, name) {
			continue
		}
		rev, _, _ := unstructured.NestedInt64(cr.Object, "revision")
		if rev > maxRev {
			maxRev = rev
		}
		out = append(out, revisionInfo{
			Revision:  rev,
			CreatedAt: cr.GetCreationTimestamp().UTC().Format(time.RFC3339),
			Images:    formatImages(templateImages(cr)),
		})
	}
	for i := range out {
		out[i].Current = out[i].Revision == maxRev
	}
	return out, nil
}

// RollbackWorkload PUT /namespaces/:namespace/resources/:resource/:name/rollback —— 回滚到指定版本。
func (h *Handler) RollbackWorkload(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	resource := c.GetString("auth_resource")
	ns, name := c.GetString("auth_namespace"), c.Param("name")
	var req struct {
		Revision int64 `json:"revision"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Revision <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "版本号无效"})
		return
	}

	var template map[string]interface{}
	switch resource {
	case "deployments":
		template = templateFromReplicaSet(c, cc, ns, name, req.Revision)
	case "statefulsets", "daemonsets":
		template = templateFromControllerRevision(c, cc, ns, name, resource, req.Revision)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "该资源不支持回滚"})
		return
	}
	if template == nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "找不到该版本"})
		return
	}
	// pod-template-hash 由控制器管理, 回滚时剥离, 避免污染新模板。
	if labels, found, _ := unstructured.NestedMap(template, "metadata", "labels"); found {
		delete(labels, "pod-template-hash")
		_ = unstructured.SetNestedMap(template, labels, "metadata", "labels")
	}

	ri, err := dynRes(cc, resource)
	if err != nil {
		writeK8sError(c, err)
		return
	}
	obj, err := ri.Namespace(ns).Get(c.Request.Context(), name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	if err := unstructured.SetNestedMap(obj.Object, template, "spec", "template"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "模板写入失败"})
		return
	}
	if _, err := ri.Namespace(ns).Update(c.Request.Context(), obj, metav1.UpdateOptions{}); err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已回滚", "revision": req.Revision})
}

func templateFromReplicaSet(c *gin.Context, cc *cluster.ClusterClient, ns, name string, rev int64) map[string]interface{} {
	ri, err := dynRes(cc, "replicasets")
	if err != nil {
		return nil
	}
	list, err := ri.Namespace(ns).List(c.Request.Context(), metav1.ListOptions{})
	if err != nil {
		return nil
	}
	for i := range list.Items {
		rs := &list.Items[i]
		if ownedBy(rs, "Deployment", name) && revisionAnnotation(rs) == rev {
			tpl, _, _ := unstructured.NestedMap(rs.Object, "spec", "template")
			return tpl
		}
	}
	return nil
}

func templateFromControllerRevision(c *gin.Context, cc *cluster.ClusterClient, ns, name, kind string, rev int64) map[string]interface{} {
	ri, err := dynRes(cc, "controllerrevisions")
	if err != nil {
		return nil
	}
	list, err := ri.Namespace(ns).List(c.Request.Context(), metav1.ListOptions{})
	if err != nil {
		return nil
	}
	ownerKind := "StatefulSet"
	if kind == "daemonsets" {
		ownerKind = "DaemonSet"
	}
	for i := range list.Items {
		cr := &list.Items[i]
		crRev, _, _ := unstructured.NestedInt64(cr.Object, "revision")
		if ownedBy(cr, ownerKind, name) && crRev == rev {
			tpl, _, _ := unstructured.NestedMap(cr.Object, "data", "spec", "template")
			return tpl
		}
	}
	return nil
}

// eventInfo 是一条精简的 k8s 事件。
type eventInfo struct {
	Type     string `json:"type"`
	Reason   string `json:"reason"`
	Message  string `json:"message"`
	Count    int64  `json:"count"`
	LastSeen string `json:"last_seen"`
	Source   string `json:"source"`
}

// ResourceEvents GET /namespaces/:namespace/resources/:resource/:name/events —— 该对象事件(倒序)。
func (h *Handler) ResourceEvents(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	ri, err := dynRes(cc, "events")
	if err != nil {
		writeK8sError(c, err)
		return
	}
	ns, name := c.GetString("auth_namespace"), c.Param("name")
	list, err := ri.Namespace(ns).List(c.Request.Context(), metav1.ListOptions{
		FieldSelector: "involvedObject.name=" + name,
	})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	out := []eventInfo{}
	for i := range list.Items {
		e := list.Items[i].Object
		typ, _, _ := unstructured.NestedString(e, "type")
		reason, _, _ := unstructured.NestedString(e, "reason")
		msg, _, _ := unstructured.NestedString(e, "message")
		count, _, _ := unstructured.NestedInt64(e, "count")
		last, _, _ := unstructured.NestedString(e, "lastTimestamp")
		src, _, _ := unstructured.NestedString(e, "source", "component")
		out = append(out, eventInfo{Type: typ, Reason: reason, Message: msg, Count: count, LastSeen: last, Source: src})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen > out[j].LastSeen })
	c.JSON(http.StatusOK, gin.H{"events": out})
}

// --- small unstructured helpers -----------------------------------------

// revisionAnnotation 读取 deployment.kubernetes.io/revision 注解为 int64(缺失=0)。
func revisionAnnotation(o *unstructured.Unstructured) int64 {
	if v, ok := o.GetAnnotations()["deployment.kubernetes.io/revision"]; ok {
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
}

// ownedBy 判断对象的 ownerReferences 是否包含指定 kind+name。
func ownedBy(o *unstructured.Unstructured, kind, name string) bool {
	for _, ref := range o.GetOwnerReferences() {
		if ref.Kind == kind && ref.Name == name {
			return true
		}
	}
	return false
}

// templateImages 从 ControllerRevision.data.spec.template 抽取容器镜像。
func templateImages(cr *unstructured.Unstructured) map[string]string {
	out := map[string]string{}
	containers, found, _ := unstructured.NestedSlice(cr.Object, "data", "spec", "template", "spec", "containers")
	if !found {
		return out
	}
	for _, ci := range containers {
		m, ok := ci.(map[string]interface{})
		if !ok {
			continue
		}
		n, _ := m["name"].(string)
		img, _ := m["image"].(string)
		if n != "" {
			out[n] = img
		}
	}
	return out
}
