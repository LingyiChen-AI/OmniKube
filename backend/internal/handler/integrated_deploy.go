package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
	"sigs.k8s.io/yaml"

	"omnikube/internal/cluster"
	"omnikube/internal/model"
)

// DeployItem 是工单里的一份 manifest。Kind 为复数小写资源名(与 rbac/resolveGVR 对齐)。
type DeployItem struct {
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Source       string `json:"source"`
	ManifestYAML string `json:"manifest_yaml"`
	SortIndex    int    `json:"sort_index"`
}

// ItemResult 是一次发布中某条资源的结果。
type ItemResult struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Phase   string `json:"phase"`
	Message string `json:"message"`
}

// deployKindGroup: 允许进入工单的资源 → 发布组序(1 配置 / 2 负载 / 3 暴露)。
var deployKindGroup = map[string]int{
	"secrets": 1, "configmaps": 1, "persistentvolumeclaims": 1,
	"deployments": 2, "statefulsets": 2, "daemonsets": 2, "jobs": 2, "cronjobs": 2,
	"services": 3, "ingresses": 3,
}

// deployAllowedKind 该资源类型是否允许进入工单。
func deployAllowedKind(kind string) bool {
	_, ok := deployKindGroup[kind]
	return ok
}

// sortDeployItems 返回按 (组序, sort_index) 稳定排序后的条目 —— 固定发布顺序。
func sortDeployItems(items []DeployItem) []DeployItem {
	out := append([]DeployItem(nil), items...)
	sort.SliceStable(out, func(i, j int) bool {
		gi, gj := deployKindGroup[out[i].Kind], deployKindGroup[out[j].Kind]
		if gi != gj {
			return gi < gj
		}
		return out[i].SortIndex < out[j].SortIndex
	})
	return out
}

// validateDeployItems 逐条校验:允许的类型、YAML 可解析且有 name、用户对该类型在该 ns
// 有 write 权限。就地把 it.Name 回填为 manifest 的 metadata.name(权威来源)。
// 校验通过返回 ("", 0);否则返回 (中文错误信息, HTTP 状态码)。
func (h *Handler) validateDeployItems(uid uint, clusterID, ns string, items []DeployItem) (string, int) {
	sid := strconv.FormatUint(uint64(uid), 10)
	for i := range items {
		it := &items[i]
		if !deployAllowedKind(it.Kind) {
			return fmt.Sprintf("第%d条: 不支持的资源类型 %q", i+1, it.Kind), http.StatusBadRequest
		}
		var m map[string]interface{}
		if err := yaml.Unmarshal([]byte(it.ManifestYAML), &m); err != nil || m == nil {
			return fmt.Sprintf("第%d条(%s): YAML 解析失败", i+1, it.Kind), http.StatusBadRequest
		}
		obj := &unstructured.Unstructured{Object: m}
		if obj.GetName() == "" {
			return fmt.Sprintf("第%d条(%s): manifest 缺少 metadata.name", i+1, it.Kind), http.StatusBadRequest
		}
		it.Name = obj.GetName()
		ok, _, err := h.RBAC.Authorize(sid, clusterID, ns, it.Kind, "write")
		if err != nil || !ok {
			return fmt.Sprintf("第%d条(%s/%s): 无写入权限", i+1, it.Kind, obj.GetName()), http.StatusForbidden
		}
	}
	return "", 0
}

type deployOrderReq struct {
	ClusterID   string       `json:"cluster_id"`
	Namespace   string       `json:"namespace"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Items       []DeployItem `json:"items"`
}

type deployOrderResp struct {
	ID          uint         `json:"id"`
	UserID      uint         `json:"user_id"`
	Username    string       `json:"username"`
	ClusterID   string       `json:"cluster_id"`
	Namespace   string       `json:"namespace"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Items       []DeployItem `json:"items"`
	Status      string       `json:"status"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

func toDeployOrderResp(o model.DeployOrder) deployOrderResp {
	var items []DeployItem
	if o.Items != "" {
		_ = json.Unmarshal([]byte(o.Items), &items)
	}
	if items == nil {
		items = []DeployItem{}
	}
	return deployOrderResp{
		ID: o.ID, UserID: o.UserID, Username: o.Username,
		ClusterID: o.ClusterID, Namespace: o.Namespace,
		Title: o.Title, Description: o.Description, Items: items,
		Status: o.Status, CreatedAt: o.CreatedAt, UpdatedAt: o.UpdatedAt,
	}
}

// currentUsername 查当前请求用户名(冗余展示用),查不到返回空。
func (h *Handler) currentUsername(uid uint) string {
	if uid == 0 {
		return ""
	}
	var u model.User
	if err := h.DB.First(&u, uid).Error; err == nil {
		return u.Username
	}
	return ""
}

// ListDeployOrders GET /integrated-deploy/orders — 可选 cluster_id 过滤,新到旧。
func (h *Handler) ListDeployOrders(c *gin.Context) {
	var orders []model.DeployOrder
	q := h.DB.Order("updated_at desc")
	if cid := c.Query("cluster_id"); cid != "" {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	out := make([]deployOrderResp, 0, len(orders))
	for _, o := range orders {
		out = append(out, toDeployOrderResp(o))
	}
	c.JSON(http.StatusOK, gin.H{"orders": out})
}

// GetDeployOrder GET /integrated-deploy/orders/:id — 详情 + 发布历史。
func (h *Handler) GetDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var runs []model.DeployOrderRun
	h.DB.Where("order_id = ?", o.ID).Order("created_at desc").Find(&runs)
	runOut := make([]gin.H, 0, len(runs))
	for _, r := range runs {
		var results []ItemResult
		if r.Results != "" {
			_ = json.Unmarshal([]byte(r.Results), &results)
		}
		runOut = append(runOut, gin.H{
			"id": r.ID, "user_id": r.UserID, "username": r.Username,
			"status": r.Status, "results": results, "created_at": r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"order": toDeployOrderResp(o), "runs": runOut})
}

// CreateDeployOrder POST /integrated-deploy/orders。
func (h *Handler) CreateDeployOrder(c *gin.Context) {
	var req deployOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "请求体格式错误"})
		return
	}
	if req.ClusterID == "" || req.Namespace == "" || req.Title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群、命名空间、标题必填"})
		return
	}
	uid := c.GetUint("user_id")
	if msg, code := h.validateDeployItems(uid, req.ClusterID, req.Namespace, req.Items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	itemsJSON, _ := json.Marshal(req.Items)
	o := model.DeployOrder{
		UserID: uid, Username: h.currentUsername(uid),
		ClusterID: req.ClusterID, Namespace: req.Namespace,
		Title: req.Title, Description: req.Description,
		Items: string(itemsJSON), Status: "draft",
	}
	if err := h.DB.Create(&o).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(o))
}

// UpdateDeployOrder PUT /integrated-deploy/orders/:id。
func (h *Handler) UpdateDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var req deployOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": "请求体格式错误"})
		return
	}
	if req.Title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"message": "标题必填"})
		return
	}
	uid := c.GetUint("user_id")
	// 集群/命名空间锁定:以工单原值为准做权限校验(前端也禁改)。
	if msg, code := h.validateDeployItems(uid, o.ClusterID, o.Namespace, req.Items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	itemsJSON, _ := json.Marshal(req.Items)
	o.Title = req.Title
	o.Description = req.Description
	o.Items = string(itemsJSON)
	if err := h.DB.Save(&o).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(o))
}

// DeleteDeployOrder DELETE /integrated-deploy/orders/:id(连带删发布历史)。
func (h *Handler) DeleteDeployOrder(c *gin.Context) {
	id := c.Param("id")
	if err := h.DB.Delete(&model.DeployOrder{}, id).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	h.DB.Where("order_id = ?", id).Delete(&model.DeployOrderRun{})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// CopyDeployOrder POST /integrated-deploy/orders/:id/copy — 复制为 draft(复用 create 权限)。
func (h *Handler) CopyDeployOrder(c *gin.Context) {
	var src model.DeployOrder
	if err := h.DB.First(&src, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	uid := c.GetUint("user_id")
	dup := model.DeployOrder{
		UserID: uid, Username: h.currentUsername(uid),
		ClusterID: src.ClusterID, Namespace: src.Namespace,
		Title: src.Title + " (副本)", Description: src.Description,
		Items: src.Items, Status: "draft",
	}
	if err := h.DB.Create(&dup).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toDeployOrderResp(dup))
}

// ListSelectable GET /integrated-deploy/selectable?cluster_id=&ns=&kind=
// 返回该 ns 下用户对该 kind 有 write 权限时的对象名单;无权限返回空名单。
func (h *Handler) ListSelectable(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	ns := c.Query("ns")
	kind := c.Query("kind")
	if clusterID == "" || ns == "" || !deployAllowedKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"message": "参数缺失或资源类型不支持"})
		return
	}
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	ok, _, err := h.RBAC.Authorize(sid, clusterID, ns, kind, "write")
	if err != nil || !ok {
		c.JSON(http.StatusOK, gin.H{"names": []string{}})
		return
	}
	cc, found := h.Pool.Get(clusterID)
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群不可用"})
		return
	}
	gvr, namespaced, gerr := resolveGVR(cc, kind)
	if gerr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"message": gerr.Error()})
		return
	}
	ri := cc.Dynamic.Resource(gvr)
	ctx := c.Request.Context()
	var list *unstructured.UnstructuredList
	if namespaced {
		list, err = ri.Namespace(ns).List(ctx, metav1.ListOptions{})
	} else {
		list, err = ri.List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	names := make([]string, 0, len(list.Items))
	for i := range list.Items {
		names = append(names, list.Items[i].GetName())
	}
	c.JSON(http.StatusOK, gin.H{"names": names})
}

// applyDeployItem 对一条资源做 upsert(存在则 Update 回填 resourceVersion,不存在则 Create)。
// 返回 phase(created|updated|failed)+ message。
func applyDeployItem(ctx context.Context, cc *cluster.ClusterClient, ns string, it DeployItem) (string, string) {
	gvr, namespaced, gerr := resolveGVR(cc, it.Kind)
	if gerr != nil {
		return "failed", gerr.Error()
	}
	var m map[string]interface{}
	if err := yaml.Unmarshal([]byte(it.ManifestYAML), &m); err != nil {
		return "failed", "YAML 解析失败: " + err.Error()
	}
	obj := &unstructured.Unstructured{Object: m}
	obj.SetName(it.Name)
	ri := cc.Dynamic.Resource(gvr)
	var dri dynamic.ResourceInterface = ri
	if namespaced {
		obj.SetNamespace(ns) // 强制覆盖 manifest 自带 namespace,封堵越权。
		dri = ri.Namespace(ns)
	}
	current, gerr := dri.Get(ctx, it.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(gerr) {
		if _, err := dri.Create(ctx, obj, metav1.CreateOptions{}); err != nil {
			return "failed", err.Error()
		}
		return "created", ""
	}
	if gerr != nil {
		return "failed", gerr.Error()
	}
	obj.SetResourceVersion(current.GetResourceVersion())
	if _, err := dri.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		return "failed", err.Error()
	}
	return "updated", ""
}

// PublishDeployOrder POST /integrated-deploy/orders/:id/publish
// 按固定顺序 upsert;遇错即停,余下标 skipped;写一条发布历史;回写工单 status。
func (h *Handler) PublishDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	var items []DeployItem
	if o.Items != "" {
		_ = json.Unmarshal([]byte(o.Items), &items)
	}
	if len(items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"message": "工单没有任何资源条目"})
		return
	}
	uid := c.GetUint("user_id")
	// 发布前二次权限校验(权限期间可能被收回)。
	if msg, code := h.validateDeployItems(uid, o.ClusterID, o.Namespace, items); code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	cc, found := h.Pool.Get(o.ClusterID)
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"message": "集群不可用"})
		return
	}
	ordered := sortDeployItems(items)
	results := make([]ItemResult, 0, len(ordered))
	runStatus := "succeeded"
	stopped := false
	for _, it := range ordered {
		if stopped {
			results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: "skipped"})
			continue
		}
		phase, msg := applyDeployItem(c.Request.Context(), cc, o.Namespace, it)
		results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: phase, Message: msg})
		if phase == "failed" {
			runStatus = "failed"
			stopped = true // 遇错即停。
		}
	}
	resultsJSON, _ := json.Marshal(results)
	run := model.DeployOrderRun{
		OrderID: o.ID, UserID: uid, Username: h.currentUsername(uid),
		Status: runStatus, Results: string(resultsJSON),
	}
	h.DB.Create(&run)
	o.Status = runStatus
	h.DB.Save(&o)
	c.JSON(http.StatusOK, gin.H{
		"run": gin.H{
			"id": run.ID, "status": run.Status, "results": results,
			"created_at": run.CreatedAt, "username": run.Username,
		},
	})
}
