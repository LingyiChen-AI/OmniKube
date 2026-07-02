package rbac

import "testing"

func TestDomMatch(t *testing.T) {
	cases := []struct {
		name           string
		reqDom, polDom string
		want           bool
	}{
		// 通配域：cluster:"*" 规则覆盖任意请求域（所有集群/命名空间）
		{"wildcard covers cluster req", "cluster_f", "*", true},
		{"wildcard covers ns req", "cluster_f:dev", "*", true},
		// 精确相等
		{"exact cluster", "cluster_f", "cluster_f", true},
		{"exact ns", "cluster_f:dev", "cluster_f:dev", true},
		// 集群级绑定覆盖该集群所有 NS
		{"cluster covers cluster-level req", "cluster_f", "cluster_f", true},
		{"cluster covers ns req", "cluster_f:dev", "cluster_f", true},
		{"cluster covers any ns req", "cluster_f:anything", "cluster_f", true},
		// NS 级绑定不向上覆盖集群级，不旁路其他 NS
		{"ns does not cover sibling ns", "cluster_g:dev-ns", "cluster_g:test-ns", false},
		{"ns does not cover cluster level", "cluster_g", "cluster_g:test-ns", false},
		// 跨集群不串
		{"no cross cluster", "cluster_g", "cluster_f", false},
		{"no cross cluster ns", "cluster_g:dev", "cluster_f", false},
		// 前缀不串：要求冒号分隔
		{"no prefix bleed", "cluster_foo", "cluster_f", false},
		{"no prefix bleed ns", "cluster_foo:dev", "cluster_f", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := domMatch(c.reqDom, c.polDom); got != c.want {
				t.Fatalf("domMatch(%q,%q)=%v want %v", c.reqDom, c.polDom, got, c.want)
			}
		})
	}
}

func TestResMatch(t *testing.T) {
	cases := []struct {
		reqObj, polObj string
		want           bool
	}{
		{"pods", "*", true},
		{"pods", "pods", true},
		{"pods", "workloads", true},
		{"deployments", "workloads", true},
		{"replicasets", "workloads", true},
		{"services", "network", true},
		{"secrets", "config", true},
		{"persistentvolumeclaims", "config", true},
		{"nodes", "cluster", true},
		// 反例：资源不在组里
		{"pods", "network", false},
		{"services", "workloads", false},
		{"nodes", "workloads", false},
		// 反例：未知组名
		{"pods", "nope", false},
	}
	for _, c := range cases {
		if got := resMatch(c.reqObj, c.polObj); got != c.want {
			t.Fatalf("resMatch(%q,%q)=%v want %v", c.reqObj, c.polObj, got, c.want)
		}
	}
}

func TestResMatchFunc(t *testing.T) {
	out, err := resMatchFunc("pods", "workloads")
	if err != nil || out != true {
		t.Fatalf("resMatchFunc pods/workloads = %v,%v", out, err)
	}
	if _, err := resMatchFunc("only-one"); err == nil {
		t.Fatal("expected arity error")
	}
	if _, err := resMatchFunc(1, 2); err == nil {
		t.Fatal("expected type error")
	}
}

func TestIsAggregatableReadAndClusterScope(t *testing.T) {
	for _, r := range []string{"pods", "deployments", "services", "secrets", "persistentvolumeclaims"} {
		if !isAggregatableRead(r) {
			t.Fatalf("%s should be aggregatable", r)
		}
	}
	for _, r := range []string{"nodes", "persistentvolumes", "customresourcedefinitions", "namespaces"} {
		if isAggregatableRead(r) {
			t.Fatalf("%s should NOT be aggregatable", r)
		}
	}
	if !isClusterScope("") {
		t.Fatal("empty namespace is cluster scope")
	}
	if isClusterScope("dev") {
		t.Fatal("dev namespace is not cluster scope")
	}
}
