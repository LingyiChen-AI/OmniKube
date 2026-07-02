package rbac

import "testing"

// contains 判断字符串切片是否含目标值（测试辅助）。
func contains(s []string, val string) bool {
	for _, v := range s {
		if v == val {
			return true
		}
	}
	return false
}

func TestVisibleSubmenus(t *testing.T) {
	// 两条规则：deployments view; secrets view+reveal; pods 只有 exec(无 view) → 不算可见子菜单。
	ops := []string{
		`{"deployments":["view"],"pods":["exec"]}`,
		`{"secrets":["view","reveal"]}`,
	}
	got := VisibleSubmenus(ops)
	if len(got) != 2 || !contains(got, "deployments") || !contains(got, "secrets") {
		t.Fatalf("got %v", got)
	}
	if contains(got, "pods") {
		t.Fatal("pods has no view → not visible")
	}
}
