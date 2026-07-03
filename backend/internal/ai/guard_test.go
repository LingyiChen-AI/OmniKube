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

func TestGuardAllow(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	store := NewStore(db, cipher)
	// AI 授予：c1 集群下 deployments 允许 view。
	if err := store.SaveGrant("c1", map[string][]string{"deployments": {"view"}}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		rbacYes  bool
		resource string
		action   string
		want     bool
	}{
		{"grant yes + rbac yes", true, "deployments", "view", true},
		{"grant yes + rbac no", false, "deployments", "view", false},
		{"grant no + rbac yes", true, "pods", "view", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := &Guard{store: store, rbac: stubAuthorizer{allow: tc.rbacYes}}
			got := g.Allow(1, "c1", "dev", tc.resource, tc.action)
			if got != tc.want {
				t.Fatalf("Allow(%s/%s) = %v, want %v", tc.resource, tc.action, got, tc.want)
			}
		})
	}
}

// TestGuardAllowRead 覆盖 AllowRead 的双闸门与可见 NS 透传（含 fail-closed 分支）。
func TestGuardAllowRead(t *testing.T) {
	newStore := func(t *testing.T) *Store {
		s := NewStore(testDB(t), testCipher(t))
		if err := s.SaveGrant("c1", map[string][]string{"deployments": {"view"}}); err != nil {
			t.Fatal(err)
		}
		return s
	}

	t.Run("grant+rbac yes → allow, visibleNS passthrough", func(t *testing.T) {
		g := &Guard{store: newStore(t), rbac: stubAuthorizer{allow: true, visibleNS: []string{"dev"}}}
		allowed, ns := g.AllowRead(1, "c1", "", "deployments")
		if !allowed || len(ns) != 1 || ns[0] != "dev" {
			t.Fatalf("got (%v, %v), want (true, [dev])", allowed, ns)
		}
	})

	t.Run("grant missing view → fail-closed", func(t *testing.T) {
		g := &Guard{store: newStore(t), rbac: stubAuthorizer{allow: true}}
		if allowed, ns := g.AllowRead(1, "c1", "dev", "pods"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})

	t.Run("rbac deny → fail-closed", func(t *testing.T) {
		g := &Guard{store: newStore(t), rbac: stubAuthorizer{allow: false}}
		if allowed, ns := g.AllowRead(1, "c1", "dev", "deployments"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})

	t.Run("authorizer error → fail-closed (deny)", func(t *testing.T) {
		g := &Guard{store: newStore(t), rbac: stubAuthorizer{allow: true, visibleNS: []string{"dev"}, err: errors.New("boom")}}
		if allowed, ns := g.AllowRead(1, "c1", "dev", "deployments"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})

	t.Run("LoadGrant error → fail-closed (deny)", func(t *testing.T) {
		store := newStore(t)
		// 关闭底层连接，令 LoadGrant 的 First() 报错，验证闸门 1 fail-closed。
		sqlDB, err := store.db.DB()
		if err != nil {
			t.Fatal(err)
		}
		sqlDB.Close()
		g := &Guard{store: store, rbac: stubAuthorizer{allow: true}}
		if allowed, ns := g.AllowRead(1, "c1", "dev", "deployments"); allowed || ns != nil {
			t.Fatalf("got (%v, %v), want (false, nil)", allowed, ns)
		}
	})
}
