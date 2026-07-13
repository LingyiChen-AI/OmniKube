package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
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
	// ResourceVersion 是快照时刻集群对象的 resourceVersion。发布时据此走乐观锁,
	// 使过期快照无法静默覆盖并发改动。历史条目/手写条目为空。
	ResourceVersion string `json:"resource_version,omitempty"`
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

// deployOrderFilter 按 query 参数构造过滤后的 *gorm.DB（不含分页/排序）。
func deployOrderFilter(db *gorm.DB, c *gin.Context) *gorm.DB {
	q := db.Model(&model.DeployOrder{})
	if cid := c.Query("cluster_id"); cid != "" {
		q = q.Where("cluster_id = ?", cid)
	}
	return q
}

// ListDeployOrders GET /integrated-deploy/orders?cluster_id=&limit=&offset= — 可选
// cluster_id 过滤,新到旧;无 limit 返回全部(兼容既有调用方),有 limit 则分页并带 total。
func (h *Handler) ListDeployOrders(c *gin.Context) {
	var total int64
	deployOrderFilter(h.DB, c).Count(&total)

	limit, offset, paged := pageParams(c)

	var orders []model.DeployOrder
	q := deployOrderFilter(h.DB, c).Order("updated_at desc")
	if paged {
		q = q.Limit(limit).Offset(offset)
	}
	if err := q.Find(&orders).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": err.Error()})
		return
	}
	out := make([]deployOrderResp, 0, len(orders))
	for _, o := range orders {
		out = append(out, toDeployOrderResp(o))
	}
	c.JSON(http.StatusOK, gin.H{"orders": out, "total": total})
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
	if o.Status != "draft" {
		c.JSON(http.StatusForbidden, gin.H{"message": "已发布的工单不可修改,请复制后再编辑"})
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
	var o model.DeployOrder
	if err := h.DB.First(&o, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	if o.Status != "draft" {
		c.JSON(http.StatusForbidden, gin.H{"message": "已发布的工单不可删除"})
		return
	}
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

// ListDeployNamespaces GET /integrated-deploy/namespaces?cluster_id=
// 工单编辑器的命名空间下拉数据,按「指定集群」返回(不依赖全局 X-Cluster-ID 头),
// 可见性规则与 ListNamespaces 一致:admin → 该集群全部 NS;否则 → 用户可见 NS。
func (h *Handler) ListDeployNamespaces(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	cc, ok := h.Pool.Get(clusterID)
	if clusterID == "" || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"message": "缺少或无效的集群"})
		return
	}
	if c.GetBool("is_admin") {
		list, err := cc.Typed.CoreV1().Namespaces().List(c.Request.Context(), metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"message": "命名空间列举失败"})
			return
		}
		names := make([]string, 0, len(list.Items))
		for i := range list.Items {
			names = append(names, list.Items[i].Name)
		}
		sort.Strings(names)
		c.JSON(http.StatusOK, gin.H{"namespaces": names})
		return
	}
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	names, err := h.RBAC.ListVisibleNamespaces(sid, clusterID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": "命名空间列举失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"namespaces": names})
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

// SnapshotResource GET /integrated-deploy/snapshot?cluster_id=&ns=&kind=&name=
// 按工单选定的 cluster_id(而非全局 X-Cluster-ID)取回资源当前 YAML,剥离服务端噪声字段。
// 修复:编辑器"从集群选取"此前用 resourceApi.get 走全局当前集群,与工单所属集群不一致时
// 会 404 或抓错集群的 manifest。
func (h *Handler) SnapshotResource(c *gin.Context) {
	clusterID := c.Query("cluster_id")
	ns := c.Query("ns")
	kind := c.Query("kind")
	name := c.Query("name")
	if clusterID == "" || ns == "" || name == "" || !deployAllowedKind(kind) {
		c.JSON(http.StatusBadRequest, gin.H{"message": "参数缺失或资源类型不支持"})
		return
	}
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	ok, _, err := h.RBAC.Authorize(sid, clusterID, ns, kind, "write")
	if err != nil || !ok {
		c.JSON(http.StatusForbidden, gin.H{"message": "无该资源写入权限"})
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
	var obj *unstructured.Unstructured
	if namespaced {
		obj, err = ri.Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	// 捕获 resourceVersion 供发布时乐观锁使用(仍从 YAML 正文里剥掉,保持可读/可编辑)。
	rv := obj.GetResourceVersion()
	unstructured.RemoveNestedField(obj.Object, "metadata", "managedFields")
	unstructured.RemoveNestedField(obj.Object, "metadata", "creationTimestamp")
	unstructured.RemoveNestedField(obj.Object, "metadata", "resourceVersion")
	unstructured.RemoveNestedField(obj.Object, "metadata", "uid")
	unstructured.RemoveNestedField(obj.Object, "metadata", "generation")
	unstructured.RemoveNestedField(obj.Object, "status")
	out, merr := yaml.Marshal(obj.Object)
	if merr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"message": merr.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"manifest_yaml": string(out), "resource_version": rv})
}

// applyDeployItem 对一条资源做 upsert(不存在则 Create,存在则 Update)。
// 更新时:若条目带有快照时刻的 resourceVersion,则原样发送以走乐观锁——
// 集群对象自快照后被并发改动会被 apiserver 以 409 Conflict 拒绝,避免旧快照静默
// 覆盖他人改动;历史/手写条目(无 RV)回退为回填当前 RV 的旧行为(保持兼容)。
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
	if it.ResourceVersion != "" {
		// 乐观锁:发送快照时刻的 RV,过期即 409。
		obj.SetResourceVersion(it.ResourceVersion)
	} else {
		// 兼容无 RV 的历史/手写条目:回填当前 RV(旧行为)。
		obj.SetResourceVersion(current.GetResourceVersion())
	}
	if _, err := dri.Update(ctx, obj, metav1.UpdateOptions{}); err != nil {
		if apierrors.IsConflict(err) {
			return "failed", "集群中的该资源自快照后已被改动(版本冲突),请在工单里重新拉取对比后再发布"
		}
		return "failed", err.Error()
	}
	return "updated", ""
}

// publishEvent 是发布过程中下发的一帧进度事件(WS 用;REST 同步发布调用方传 no-op emit)。
type publishEvent struct {
	Type    string `json:"type"` // "item" | "done" | "error"
	Index   int    `json:"index,omitempty"`
	Total   int    `json:"total,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Name    string `json:"name,omitempty"`
	Phase   string `json:"phase,omitempty"` // running|created|updated|failed|skipped
	Message string `json:"message,omitempty"`
	Status  string `json:"status,omitempty"` // done: succeeded|failed
}

// executePublish 是发布核心逻辑,被同步 REST 与流式 WS 共用。
// 前置校验(条目非空、工单必须是 draft、逐条权限、集群可用)失败时返回 (msg, httpCode)
// 且不会调用 emit;调用方据此原样回 JSON 错误(REST)或包一层 error 帧(WS)。
// 前置校验通过后,按固定顺序逐条 apply:每条 apply 前 emit 一帧 running,apply 后 emit
// 一帧结果(created|updated|failed);一旦失败,后续条目直接标 skipped 并各 emit 一帧。
// 最终持久化 DeployOrderRun + 回写 o.Status + 写一条 ReleaseRecord,返回 run。
func (h *Handler) executePublish(ctx context.Context, o model.DeployOrder, uid uint, emit func(publishEvent)) (model.DeployOrderRun, string, int) {
	var items []DeployItem
	if o.Items != "" {
		_ = json.Unmarshal([]byte(o.Items), &items)
	}
	if len(items) == 0 {
		return model.DeployOrderRun{}, "工单没有任何资源条目", http.StatusBadRequest
	}
	if o.Status != "draft" {
		return model.DeployOrderRun{}, "已发布的工单不可重复发布,请复制后再发布", http.StatusForbidden
	}
	// 发布前二次权限校验(权限期间可能被收回)。
	if msg, code := h.validateDeployItems(uid, o.ClusterID, o.Namespace, items); code != 0 {
		return model.DeployOrderRun{}, msg, code
	}
	cc, found := h.Pool.Get(o.ClusterID)
	if !found {
		return model.DeployOrderRun{}, "集群不可用", http.StatusBadRequest
	}
	ordered := sortDeployItems(items)
	total := len(ordered)
	results := make([]ItemResult, 0, total)
	runStatus := "succeeded"
	stopped := false
	for i, it := range ordered {
		if stopped {
			results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: "skipped"})
			emit(publishEvent{Type: "item", Index: i, Total: total, Kind: it.Kind, Name: it.Name, Phase: "skipped"})
			continue
		}
		emit(publishEvent{Type: "item", Index: i, Total: total, Kind: it.Kind, Name: it.Name, Phase: "running"})
		phase, msg := applyDeployItem(ctx, cc, o.Namespace, it)
		results = append(results, ItemResult{Kind: it.Kind, Name: it.Name, Phase: phase, Message: msg})
		emit(publishEvent{Type: "item", Index: i, Total: total, Kind: it.Kind, Name: it.Name, Phase: phase, Message: msg})
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
	// 集群变更已发生:即便历史/状态持久化失败,也要让调用方看到逐条结果,
	// 但不能静默吞掉错误——落日志以便排查(否则 run.ID=0,发布历史丢失且无从追溯)。
	if err := h.DB.Create(&run).Error; err != nil {
		log.Printf("publish run 持久化失败: cluster changes applied but history not recorded (order=%d): %v", o.ID, err)
	}
	o.Status = runStatus
	if err := h.DB.Save(&o).Error; err != nil {
		log.Printf("publish order 状态回写失败 (order=%d, status=%s): %v", o.ID, runStatus, err)
	}
	// 一次发布只写一条发布记录(审计用),而非逐资源一条。best-effort:失败不影响响应。
	names := make([]string, 0, len(ordered))
	for _, it := range ordered {
		names = append(names, it.Kind+"/"+it.Name)
	}
	// Release-note text is a locale-neutral audit string → English (mirrors the
	// English "Release note" column header and stays stable across UI languages).
	statusText := "succeeded"
	if runStatus == "failed" {
		statusText = "failed"
	}
	rel := model.ReleaseRecord{
		UserID: uid, Username: h.currentUsername(uid),
		ClusterID: o.ClusterID, Namespace: o.Namespace,
		Kind: "DeployOrder", Name: o.Title,
		Comment: fmt.Sprintf("Integrated deploy %q · %d resource(s) (%s) · %s", o.Title, len(ordered), strings.Join(names, ", "), statusText),
		Source:  "integrated_deploy",
	}
	if err := h.DB.Create(&rel).Error; err != nil {
		log.Printf("release record for deploy order %d failed: %v", o.ID, err)
	}
	return run, "", 0
}

// PublishDeployOrder POST /integrated-deploy/orders/:id/publish
// 同步发布(REST 兜底路径):委托 executePublish,不消费逐条进度事件。
func (h *Handler) PublishDeployOrder(c *gin.Context) {
	var o model.DeployOrder
	if err := h.DB.First(&o, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"message": "工单不存在"})
		return
	}
	uid := c.GetUint("user_id")
	run, msg, code := h.executePublish(c.Request.Context(), o, uid, func(publishEvent) {})
	if code != 0 {
		c.JSON(code, gin.H{"message": msg})
		return
	}
	var results []ItemResult
	if run.Results != "" {
		_ = json.Unmarshal([]byte(run.Results), &results)
	}
	c.JSON(http.StatusOK, gin.H{
		"run": gin.H{
			"id": run.ID, "status": run.Status, "results": results,
			"created_at": run.CreatedAt, "username": run.Username,
		},
	})
}
