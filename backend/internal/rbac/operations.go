package rbac

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// 固定枚举（子项目 H §2）。

// validGroups 资源组枚举。
var validGroups = setOf("workloads", "network", "config", "cluster")

// validActions 动作枚举。
var validActions = setOf("read", "create", "write", "delete", "exec", "reveal")

// AllPages 是超级管理员拥有的全部资源页面（顺序固定，驱动前端导航）。
var AllPages = []string{"dashboard", "workloads", "networking", "storage", "cluster"}

// AllFunctionalPages 是全部「功能页面」key（显式授权, 不由操作权限派生）。
// 目前仅「发布记录」(releases)。admin 恒含全部功能页。
var AllFunctionalPages = []string{"releases"}

// validFunctionalPages 功能页 key 枚举（角色 Pages 仅允许这些值, 其它一律剔除）。
var validFunctionalPages = setOf("releases")

// IsValidFunctionalPage 校验功能页 key 是否合法。
func IsValidFunctionalPage(p string) bool { return validFunctionalPages[p] }

// groupReadToPage 把「资源组的 read 授权」映射到其解锁的资源页面。
// cluster 组（节点/持久卷/命名空间/CRD）对应「集群资源」页（节点 + 持久卷）。
var groupReadToPage = map[string]string{
	"workloads": "workloads",
	"network":   "networking",
	"config":    "storage",
	"cluster":   "cluster",
}

// PagesFromOperations 由非管理员用户「所有角色规则的操作并集」派生其有效资源页面：
// dashboard 恒含；workloads 组有 read → workloads 页；network 组有 read → networking 页；
// config 组有 read → storage 页；cluster 组有 read → cluster 页。返回排序去重结果，保持与操作权限一致。
func PagesFromOperations(rawOps []string) []string {
	set := map[string]bool{"dashboard": true}
	for _, raw := range rawOps {
		ops := parseOperations(raw)
		for group, page := range groupReadToPage {
			if hasAction(ops[group], "read") {
				set[page] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// VisibleSubmenus：传入用户所有 RoleRule 的 operations JSON 串，返回有 "view" 的资源子菜单并集(排序)。
func VisibleSubmenus(opsRaws []string) []string {
	set := map[string]bool{}
	for _, raw := range opsRaws {
		if raw == "" {
			continue
		}
		var m map[string][]string
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		for res, acts := range m {
			if !IsValidResource(res) {
				continue
			}
			for _, a := range acts {
				if a == "view" {
					set[res] = true
				}
			}
		}
	}
	out := make([]string, 0, len(set))
	for r := range set {
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

// hasAction 判断动作切片是否含目标动作。
func hasAction(acts []string, want string) bool {
	for _, a := range acts {
		if a == want {
			return true
		}
	}
	return false
}

// IsValidGroup 校验资源组是否合法。
func IsValidGroup(g string) bool { return validGroups[g] }

// IsValidAction 校验动作是否合法。
func IsValidAction(a string) bool { return validActions[a] }

// canonicalString 把 operations 规范化成稳定字符串：组排序，组内动作去重排序。
// 例："config:read,reveal|workloads:read,write"。空操作或空动作组被跳过。
func canonicalString(ops map[string][]string) string {
	groups := make([]string, 0, len(ops))
	for g := range ops {
		groups = append(groups, g)
	}
	sort.Strings(groups)
	var sb strings.Builder
	for _, g := range groups {
		acts := dedupSortedActions(ops[g])
		if len(acts) == 0 {
			continue
		}
		sb.WriteString(g)
		sb.WriteByte(':')
		sb.WriteString(strings.Join(acts, ","))
		sb.WriteByte('|')
	}
	return sb.String()
}

// canonicalSignature 返回 operations 的稳定签名（canonicalString 的 sha256 hex），
// 用作合成角色名后缀以保证去重且不超出 casbin 列宽。
func canonicalSignature(ops map[string][]string) string {
	sum := sha256.Sum256([]byte(canonicalString(ops)))
	return hex.EncodeToString(sum[:])
}

// syntheticRole 返回某操作集合对应的合成角色名 "perm:<sig>"。
func syntheticRole(ops map[string][]string) string {
	return "perm:" + canonicalSignature(ops)
}

// dedupSortedActions 去重并排序动作切片。
func dedupSortedActions(acts []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(acts))
	for _, a := range acts {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// sortedGroups 返回 operations 的有序组名（仅含非空动作组）。
func sortedGroups(ops map[string][]string) []string {
	groups := make([]string, 0, len(ops))
	for g := range ops {
		if len(dedupSortedActions(ops[g])) > 0 {
			groups = append(groups, g)
		}
	}
	sort.Strings(groups)
	return groups
}

// parseOperations 解析 RoleRule.Operations 的 JSON，非法/空返回 nil。
func parseOperations(raw string) map[string][]string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out map[string][]string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}
