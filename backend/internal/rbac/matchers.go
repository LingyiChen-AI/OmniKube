package rbac

import (
	"fmt"
	"strings"
)

// domMatch 是注册到 g 的自定义域匹配函数。
// reqDom = 请求域，polDom = g 绑定里存的域。
// 注册：enforcer.AddNamedDomainMatchingFunc("g", "domMatch", domMatch)。
//
// 域格式：集群级域 = "clusterID"（无冒号）；命名空间级域 = "clusterID:ns"。
func domMatch(reqDom, polDom string) bool {
	// 通配域 "*"：cluster:"*" 规则物化的绑定，匹配任意请求域（所有集群及其命名空间）。
	if polDom == "*" {
		return true
	}
	if reqDom == polDom {
		return true
	}
	// 集群级绑定（无冒号）覆盖该集群下所有命名空间域 "clusterID:ns"。
	// 要求冒号分隔，避免 "cluster_f" 误命中 "cluster_foo"。
	if !strings.Contains(polDom, ":") {
		return strings.HasPrefix(reqDom, polDom+":")
	}
	// NS 级绑定只精确匹配，绝不向上覆盖集群级或旁路其他 NS。
	return false
}

// resMatch 是注册到 m 的自定义资源匹配函数。
// reqObj = 具体资源（如 "pods"），polObj = 策略里的资源或资源组（如 "workloads"/"*"）。
func resMatch(reqObj, polObj string) bool {
	if polObj == "*" || polObj == reqObj {
		return true
	}
	set, ok := resourceGroups[polObj]
	return ok && set[reqObj]
}

// resMatchFunc 把 resMatch 适配成 casbin AddFunction 需要的变参签名。
func resMatchFunc(args ...interface{}) (interface{}, error) {
	if len(args) != 2 {
		return false, fmt.Errorf("resMatch 需要 2 个参数, 实际 %d", len(args))
	}
	reqObj, ok1 := args[0].(string)
	polObj, ok2 := args[1].(string)
	if !ok1 || !ok2 {
		return false, fmt.Errorf("resMatch 参数必须是 string")
	}
	return resMatch(reqObj, polObj), nil
}
