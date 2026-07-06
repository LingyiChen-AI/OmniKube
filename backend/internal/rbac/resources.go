package rbac

// resourceGroups 把资源组名映射到其成员资源集合（可配置化）。
// resMatch 用它把策略里写的资源组（如 "workloads"）展开成具体资源。
var resourceGroups = map[string]map[string]bool{
	"workloads": setOf("deployments", "statefulsets", "daemonsets", "pods", "jobs", "cronjobs", "replicasets"),
	"network":   setOf("services", "ingresses", "endpoints"),
	"config":    setOf("configmaps", "secrets", "persistentvolumeclaims", "persistentvolumes"),
	"cluster":   setOf("nodes", "namespaces", "customresourcedefinitions"),
}

// aggregatableReads 是「受控集群级只读」可聚合的命名空间型资源白名单。
// nodes/persistentvolumes/customresourcedefinitions 等真集群级资源不在内。
var aggregatableReads = setOf(
	"pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs", "replicasets",
	"services", "ingresses", "configmaps", "secrets", "persistentvolumeclaims",
)

func setOf(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, it := range items {
		m[it] = true
	}
	return m
}

// isAggregatableRead 判断资源是否可在集群级按命名空间聚合只读。
func isAggregatableRead(resource string) bool {
	return aggregatableReads[resource]
}

// isClusterScope 判断请求是否为集群级（无命名空间）。
func isClusterScope(namespace string) bool {
	return namespace == ""
}

// moduleResources 模块(一级菜单) → 其子菜单(具体资源)，顺序固定，驱动前端树与 nav 校验。
var moduleResources = map[string][]string{
	"workloads":  {"deployments", "statefulsets", "daemonsets", "pods", "jobs", "cronjobs"},
	"networking": {"services", "ingresses"},
	"storage":    {"configmaps", "secrets", "persistentvolumeclaims", "persistentvolumes"},
	"nodes":      {"nodes"},
}

var resourceModule = func() map[string]string {
	m := map[string]string{}
	for mod, rs := range moduleResources {
		for _, r := range rs {
			m[r] = mod
		}
	}
	return m
}()

// AllResources 所有可授权的资源子菜单（用于 admin 全量、校验）。
var AllResources = func() []string {
	out := []string{}
	for _, rs := range moduleResources {
		out = append(out, rs...)
	}
	return out
}()

// CustomResource 是承载「所有非内置资源」(CRD 及未纳入的内置资源)权限的粗粒度伪资源。
// 它合法(可授予、可鉴权),但不进 moduleResources/AllResources(不生成导航子菜单)。
const CustomResource = "customresources"

var validResources = func() map[string]bool {
	m := setOf(AllResources...)
	m[CustomResource] = true
	return m
}()
var validResourceActions = setOf("view", "create", "edit", "delete", "exec", "reveal")
var validGlobalAreas = setOf("clusters", "users", "roles", "releases", "audit", "ai", "integrated_deploy")
var validGlobalActions = setOf("view", "create", "edit", "delete", "publish")

func ModuleOf(resource string) string     { return resourceModule[resource] }
func IsValidResource(r string) bool       { return validResources[r] }
func IsValidResourceAction(a string) bool { return validResourceActions[a] }
func IsValidGlobalArea(a string) bool     { return validGlobalAreas[a] }
func IsValidGlobalAction(a string) bool   { return validGlobalActions[a] }

// ResourceActionApplies 该资源是否适用某动作（exec 仅 pods；reveal 仅 secrets）。
func ResourceActionApplies(resource, action string) bool {
	switch action {
	case "exec":
		return resource == "pods"
	case "reveal":
		return resource == "secrets"
	case "view", "create", "edit", "delete":
		return validResources[resource]
	}
	return false
}

// actionToCasbin 把树动作映射为 Casbin 动作（view→read，edit→write，其余同名）。
func actionToCasbin(a string) string {
	switch a {
	case "view":
		return "read"
	case "edit":
		return "write"
	default:
		return a // create/delete/exec/reveal
	}
}
