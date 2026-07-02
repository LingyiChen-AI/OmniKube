package rbac

import (
	"testing"

	"omnikube/internal/model"
)

// TestUserGlobalPerms_Union verifies that a user's global perms are the union
// of all their roles' GlobalPerms, filtered to valid areas/actions.
func TestUserGlobalPerms_Union(t *testing.T) {
	s, db := newServiceWithNS(t, "")
	r1 := model.Role{Name: "a", GlobalPerms: `{"users":["view"],"releases":["view"]}`}
	if err := db.Create(&r1).Error; err != nil {
		t.Fatal(err)
	}
	r2 := model.Role{Name: "b", GlobalPerms: `{"users":["view","create"],"roles":["view"]}`}
	if err := db.Create(&r2).Error; err != nil {
		t.Fatal(err)
	}
	bindUserRole(t, s, 11, r1.ID)
	bindUserRole(t, s, 11, r2.ID)

	g, err := s.UserGlobalPerms(11)
	if err != nil {
		t.Fatal(err)
	}
	if !g["users"]["view"] || !g["users"]["create"] {
		t.Fatal("users union")
	}
	if !g["roles"]["view"] {
		t.Fatal("roles")
	}
	if !g["releases"]["view"] {
		t.Fatal("releases")
	}
	if g["clusters"]["view"] {
		t.Fatal("clusters none")
	}
}

// TestUserGlobalPerms_FiltersInvalid drops unknown areas/actions.
func TestUserGlobalPerms_FiltersInvalid(t *testing.T) {
	s, db := newServiceWithNS(t, "")
	r := model.Role{Name: "x", GlobalPerms: `{"bogus":["view"],"users":["view","bogusact"],"releases":["delete"]}`}
	if err := db.Create(&r).Error; err != nil {
		t.Fatal(err)
	}
	bindUserRole(t, s, 12, r.ID)

	g, err := s.UserGlobalPerms(12)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := g["bogus"]; ok {
		t.Fatal("bogus area must be dropped")
	}
	if g["users"]["bogusact"] {
		t.Fatal("bogus action must be dropped")
	}
	if !g["users"]["view"] {
		t.Fatal("users view kept")
	}
	// releases:delete is a valid global action token, but releases only allows view
	// at the area level per AllGlobalPerms; the filter is by IsValidGlobalAction so
	// delete is retained here (area-level restriction is enforced at write/seed time).
	if !g["releases"]["delete"] {
		t.Fatal("releases delete is a valid global action token")
	}
}

func TestAllGlobalPerms(t *testing.T) {
	all := AllGlobalPerms()
	full := map[string]bool{"view": true, "create": true, "edit": true, "delete": true}
	for _, area := range []string{"clusters", "users", "roles"} {
		if len(all[area]) != 4 {
			t.Fatalf("%s expected 4 actions, got %v", area, all[area])
		}
		for _, a := range all[area] {
			if !full[a] {
				t.Fatalf("%s unexpected action %s", area, a)
			}
		}
	}
	if len(all["releases"]) != 1 || all["releases"][0] != "view" {
		t.Fatalf("releases expected [view], got %v", all["releases"])
	}
}
