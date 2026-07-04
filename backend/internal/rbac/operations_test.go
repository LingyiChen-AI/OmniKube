package rbac

import (
	"reflect"
	"testing"
)

// customresources 有 view 也不应进导航子菜单(它没有对应的资源专页)。
func TestVisibleSubmenusSkipsCustomResources(t *testing.T) {
	raw := `{"deployments":["view"],"customresources":["view","edit"]}`
	got := VisibleSubmenus([]string{raw})
	want := []string{"deployments"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("VisibleSubmenus = %v, want %v", got, want)
	}
}
