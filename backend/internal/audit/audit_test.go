package audit

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/database"
	"omnikube/internal/model"
)

func TestLog_WritesRow(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	Log(db, Entry{
		UserID: "7", ClusterID: "cluster_f", Namespace: "dev",
		Resource: "pods", Action: "exec", Target: "pod-1", Result: "allow", SourceIP: "1.2.3.4",
	})
	var got model.AuditLog
	if err := db.First(&got).Error; err != nil {
		t.Fatalf("expected audit row: %v", err)
	}
	if got.UserID != "7" || got.Resource != "pods" || got.Result != "allow" {
		t.Fatalf("unexpected row: %+v", got)
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("expected CreatedAt set")
	}
}

func TestLog_NonBlockingOnError(t *testing.T) {
	// DB without the table migrated → Create fails, but Log must not panic.
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	Log(db, Entry{UserID: "1", Action: "read"}) // must return without panicking
}
