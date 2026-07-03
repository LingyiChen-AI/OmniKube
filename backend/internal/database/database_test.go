package database

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/model"
)

func memDB(t *testing.T) *gorm.DB {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestBootstrapAdmin_CreatesOnEmpty(t *testing.T) {
	db := memDB(t)
	if err := BootstrapAdmin(db, "admin"); err != nil {
		t.Fatal(err)
	}
	var u model.User
	if err := db.Where("username = ?", "admin").First(&u).Error; err != nil {
		t.Fatalf("admin not created: %v", err)
	}
	if !u.IsAdmin || !u.MustReset {
		t.Fatalf("admin flags wrong: %+v", u)
	}
	if u.Password == "" {
		t.Fatal("admin password hash empty")
	}
}

func TestBootstrapAdmin_SkipsWhenUsersExist(t *testing.T) {
	db := memDB(t)
	if err := BootstrapAdmin(db, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := BootstrapAdmin(db, "admin"); err != nil { // 第二次不应再建
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.User{}).Count(&count)
	if count != 1 {
		t.Fatalf("expected exactly 1 user, got %d", count)
	}
}

func TestMigrateCreatesAITables(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if !db.Migrator().HasTable(&model.AIConfig{}) {
		t.Error("ok_ai_config table missing")
	}
	if !db.Migrator().HasTable(&model.AIGrant{}) {
		t.Error("ok_ai_grants table missing")
	}
}
