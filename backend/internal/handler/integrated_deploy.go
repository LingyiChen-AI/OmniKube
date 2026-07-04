package handler

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"
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
