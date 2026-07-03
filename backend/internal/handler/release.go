package handler

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"omnikube/internal/model"
	"omnikube/internal/notify"
)

// workloadKind 把工作负载资源复数名映射到 K8S Kind；同时作为「需记发布」的资源白名单。
var workloadKind = map[string]string{
	"deployments":  "Deployment",
	"statefulsets": "StatefulSet",
	"daemonsets":   "DaemonSet",
	"jobs":         "Job",
	"cronjobs":     "CronJob",
}

// isReleaseWorkload 判断资源是否属于「发布记录」捕获范围。
func isReleaseWorkload(resource string) bool {
	_, ok := workloadKind[resource]
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

// recordRelease 追加一条发布记录（best-effort, 落库失败不影响已成功的更新）。
func (h *Handler) recordRelease(c *gin.Context, ns, resource, name, before, after, comment string) {
	uid := c.GetUint("user_id")
	var username string
	if uid != 0 {
		var u model.User
		if err := h.DB.First(&u, uid).Error; err == nil {
			username = u.Username
		}
	}
	clusterID := c.GetHeader("X-Cluster-ID")
	rec := model.ReleaseRecord{
		UserID:      uid,
		Username:    username,
		ClusterID:   clusterID,
		Namespace:   ns,
		Kind:        workloadKind[resource],
		Name:        name,
		ImageBefore: before,
		ImageAfter:  after,
		Comment:     comment,
	}
	h.DB.Create(&rec)
	h.notifyRelease(clusterID, rec)
}

// notifyRelease pushes the release to the cluster's configured webhooks (best-effort, async).
func (h *Handler) notifyRelease(clusterID string, rec model.ReleaseRecord) {
	if clusterID == "" {
		return
	}
	var cl model.Cluster
	if err := h.DB.First(&cl, "id = ?", clusterID).Error; err != nil {
		return
	}
	hooks := notify.ParseWebhooks(cl.Webhooks)
	if len(hooks) == 0 {
		return
	}
	notify.SendRelease(hooks, notify.Release{
		ClusterName: cl.Name,
		ClusterID:   cl.ID,
		Namespace:   rec.Namespace,
		Kind:        rec.Kind,
		Name:        rec.Name,
		Releaser:    rec.Username,
		ImageBefore: rec.ImageBefore,
		ImageAfter:  rec.ImageAfter,
		Comment:     rec.Comment,
		Time:        rec.CreatedAt,
	})
}

// ListReleases GET /api/v1/releases?cluster_id=&namespace=&limit= —— 发布记录列表（时间倒序）。
// 鉴权：由路由层 RequireGlobalPerm("releases","view") 门控；admin 在中间件旁路。
func (h *Handler) ListReleases(c *gin.Context) {
	q := h.DB.Model(&model.ReleaseRecord{})
	if cid := c.Query("cluster_id"); cid != "" {
		q = q.Where("cluster_id = ?", cid)
	}
	if ns := c.Query("namespace"); ns != "" {
		q = q.Where("namespace = ?", ns)
	}
	limit := 200
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	records := []model.ReleaseRecord{}
	q.Order("created_at desc").Limit(limit).Find(&records)
	c.JSON(http.StatusOK, gin.H{"releases": records})
}
