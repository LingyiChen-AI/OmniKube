package ai

import "testing"

// stubAuthorizer 是可注入的 rbac 桩：固定返回 allow 值。
type stubAuthorizer struct {
	allow bool
}

func (s stubAuthorizer) Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error) {
	return s.allow, nil, nil
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
