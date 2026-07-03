package ai

import (
	"errors"
	"testing"
)

// stubAuthorizer 是可注入的 rbac 桩：固定返回 allow / visibleNS / err。
type stubAuthorizer struct {
	allow     bool
	visibleNS []string // 非 nil 时模拟「受控集群级只读」的可见 NS 子集。
	err       error
}

func (s stubAuthorizer) Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error) {
	return s.allow, s.visibleNS, s.err
}

// TestGuardAllow 覆盖单闸门（跟随用户 RBAC）的放行/拒绝/出错分支。
func TestGuardAllow(t *testing.T) {
	cases := []struct {
		name    string
		rbacYes bool
		rbacErr error
		want    bool
	}{
		{"rbac yes → allow", true, nil, true},
		{"rbac no → deny", false, nil, false},
		{"rbac error → fail-closed deny", true, errors.New("boom"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := NewGuard(stubAuthorizer{allow: tc.rbacYes, err: tc.rbacErr})
			if got := g.Allow(1, "c1", "dev", "deployments", "view"); got != tc.want {
				t.Fatalf("Allow() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestGuardAllowRead 覆盖 AllowRead 的放行、可见 NS 透传与 fail-closed 分支。
func TestGuardAllowRead(t *testing.T) {
	t.Run("rbac yes → allow, visibleNS passthrough", func(t *testing.T) {
		g := NewGuard(stubAuthorizer{allow: true, visibleNS: []string{"dev"}})
		allowed, ns := g.AllowRead(1, "c1", "", "deployments")
		if !allowed || len(ns) != 1 || ns[0] != "dev" {
			t.Fatalf("got (%v, %v), want (true, [dev])", allowed, ns)
		}
	})

	t.Run("rbac yes, no NS constraint → allow with nil (full-cluster)", func(t *testing.T) {
		g := NewGuard(stubAuthorizer{allow: true})
		allowed, ns := g.AllowRead(1, "c1", "", "deployments")
		if !allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (true, nil)", allowed, ns)
		}
	})

	t.Run("rbac deny → fail-closed", func(t *testing.T) {
		g := NewGuard(stubAuthorizer{allow: false})
		if allowed, ns := g.AllowRead(1, "c1", "dev", "deployments"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})

	t.Run("authorizer error → fail-closed (deny)", func(t *testing.T) {
		g := NewGuard(stubAuthorizer{allow: true, visibleNS: []string{"dev"}, err: errors.New("boom")})
		if allowed, ns := g.AllowRead(1, "c1", "dev", "deployments"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})
}
