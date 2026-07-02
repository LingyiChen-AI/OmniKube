package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"omnikube/internal/cluster"
)

// clusterClientFromHeader 取 X-Cluster-ID 头对应的客户端。
func (h *Handler) clusterClientFromHeader(c *gin.Context) (*cluster.ClusterClient, bool) {
	return h.Pool.Get(c.GetHeader("X-Cluster-ID"))
}

// resolveGVR 经 RESTMapper 把规范资源名解析为完整 GVR，并返回是否命名空间型。
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

// ListResource GET 列表：命名空间型按 auth_namespace 或 visible_ns 聚合，集群型全量。
func (h *Handler) ListResource(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	resource := c.GetString("auth_resource")
	namespaced := c.GetBool("auth_namespaced")
	ns := c.GetString("auth_namespace")

	gvr, _, err := resolveGVR(cc, resource)
	if err != nil {
		writeK8sError(c, err)
		return
	}
	ctx := c.Request.Context()
	ri := cc.Dynamic.Resource(gvr)

	// 集群型资源：全量 list。
	if !namespaced {
		list, err := ri.List(ctx, metav1.ListOptions{})
		if err != nil {
			writeK8sError(c, err)
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}

	// 命名空间型且指定了 namespace：单 NS list。
	if ns != "" {
		list, err := ri.Namespace(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			writeK8sError(c, err)
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}

	// 命名空间型且 namespace 为空（集群级聚合）。
	if v, exists := c.Get("visible_ns"); exists {
		// 受控集群级只读（PRD 修复 #2）：只遍历可见 NS 合并，绝不全集群 list。
		visible, _ := v.([]string)
		merged := &unstructured.UnstructuredList{}
		for _, n := range visible {
			list, err := ri.Namespace(n).List(ctx, metav1.ListOptions{})
			if err != nil {
				writeK8sError(c, err)
				return
			}
			if merged.Object == nil {
				merged.Object = map[string]interface{}{
					"apiVersion": list.GetAPIVersion(),
					"kind":       list.GetKind(),
				}
			}
			merged.Items = append(merged.Items, list.Items...)
		}
		c.JSON(http.StatusOK, merged)
		return
	}

	// 无 visible_ns（系统 admin 或集群级角色）→ 正常全量 list。
	list, err := ri.List(ctx, metav1.ListOptions{})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, list)
}

// GetResource GET 详情。
func (h *Handler) GetResource(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	gvr, namespaced, err := resolveGVR(cc, c.GetString("auth_resource"))
	if err != nil {
		writeK8sError(c, err)
		return
	}
	name := c.Param("name")
	ns := c.GetString("auth_namespace")
	ctx := c.Request.Context()

	var obj *unstructured.Unstructured
	if namespaced {
		obj, err = cc.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	} else {
		obj, err = cc.Dynamic.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, obj)
}

// CreateResource POST 创建：下发前强制覆盖 namespace（PRD 修复 #1）。
func (h *Handler) CreateResource(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	gvr, namespaced, err := resolveGVR(cc, c.GetString("auth_resource"))
	if err != nil {
		writeK8sError(c, err)
		return
	}
	obj, err := decodeUnstructured(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "请求体解析失败"})
		return
	}
	ns := c.GetString("auth_namespace")
	ctx := c.Request.Context()

	var created *unstructured.Unstructured
	if namespaced {
		obj.SetNamespace(ns) // 强制覆盖 body 自带 namespace，封堵参数混淆越权。
		created, err = cc.Dynamic.Resource(gvr).Namespace(ns).Create(ctx, obj, metav1.CreateOptions{})
	} else {
		created, err = cc.Dynamic.Resource(gvr).Create(ctx, obj, metav1.CreateOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusCreated, created)
}

// UpdateResource PUT 更新：下发前强制覆盖 namespace 与 name。
func (h *Handler) UpdateResource(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	gvr, namespaced, err := resolveGVR(cc, c.GetString("auth_resource"))
	if err != nil {
		writeK8sError(c, err)
		return
	}
	obj, err := decodeUnstructured(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "请求体解析失败"})
		return
	}
	obj.SetName(c.Param("name")) // path 段 :name 为权威来源。
	ns := c.GetString("auth_namespace")
	ctx := c.Request.Context()
	resource := c.GetString("auth_resource")

	// 发布记录捕获：工作负载(Deployment/StatefulSet/DaemonSet)的容器镜像 tag 变更需
	// 必填发布说明并落审计。下发前先取旧对象比较镜像集合。
	var (
		recordRelease       bool
		imgBefore, imgAfter string
		releaseComment      string
	)
	if isReleaseWorkload(resource) {
		var existing *unstructured.Unstructured
		if namespaced {
			existing, err = cc.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, obj.GetName(), metav1.GetOptions{})
		} else {
			existing, err = cc.Dynamic.Resource(gvr).Get(ctx, obj.GetName(), metav1.GetOptions{})
		}
		if err != nil {
			writeK8sError(c, err)
			return
		}
		imgBefore = formatImages(containerImages(existing))
		imgAfter = formatImages(containerImages(obj))
		if imgBefore != imgAfter {
			releaseComment = strings.TrimSpace(c.Query("release_comment"))
			if releaseComment == "" {
				releaseComment = strings.TrimSpace(c.GetHeader("X-Release-Comment"))
			}
			if releaseComment == "" {
				c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "发布说明必填"})
				return
			}
			recordRelease = true
		}
	}

	var updated *unstructured.Unstructured
	if namespaced {
		obj.SetNamespace(ns) // 强制覆盖 body 自带 namespace。
		updated, err = cc.Dynamic.Resource(gvr).Namespace(ns).Update(ctx, obj, metav1.UpdateOptions{})
	} else {
		updated, err = cc.Dynamic.Resource(gvr).Update(ctx, obj, metav1.UpdateOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	if recordRelease {
		h.recordRelease(c, ns, resource, obj.GetName(), imgBefore, imgAfter, releaseComment)
	}
	c.JSON(http.StatusOK, updated)
}

// DeleteResource DELETE 删除。
func (h *Handler) DeleteResource(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	gvr, namespaced, err := resolveGVR(cc, c.GetString("auth_resource"))
	if err != nil {
		writeK8sError(c, err)
		return
	}
	name := c.Param("name")
	ns := c.GetString("auth_namespace")
	ctx := c.Request.Context()

	if namespaced {
		err = cc.Dynamic.Resource(gvr).Namespace(ns).Delete(ctx, name, metav1.DeleteOptions{})
	} else {
		err = cc.Dynamic.Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
	}
	if err != nil {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "已删除"})
}

// decodeUnstructured 把请求体解析为 unstructured.Unstructured。
func decodeUnstructured(c *gin.Context) (*unstructured.Unstructured, error) {
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, err
	}
	m := map[string]interface{}{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if len(m) == 0 {
		return nil, errors.New("空请求体")
	}
	return &unstructured.Unstructured{Object: m}, nil
}

// writeK8sError 把 K8S API 错误透传为合理 HTTP 码 + {code,message}。
func writeK8sError(c *gin.Context, err error) {
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		code := int(status.Status().Code)
		if code == 0 {
			code = http.StatusInternalServerError
		}
		c.JSON(code, gin.H{"code": code, "message": status.Status().Message})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": err.Error()})
}
