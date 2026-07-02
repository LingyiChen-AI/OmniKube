package cluster

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/model"
)

func testKey() []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = byte(i + 1)
	}
	return k
}

func newTestPool(t *testing.T, build ClientBuilder) (*ClusterPool, *gorm.DB, *crypto.Cipher) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(testKey())
	if err != nil {
		t.Fatal(err)
	}
	return NewPool(db, ci, build), db, ci
}

// fakeBuilder returns a stub client whose Ping result is controlled by pingErr.
func fakeBuilder(pingErr error) ClientBuilder {
	return func(kubeconfig string) (*ClusterClient, error) {
		return &ClusterClient{Discovery: stubDiscovery{err: pingErr}}, nil
	}
}

func TestPool_SetGetRemove(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	c := &ClusterClient{}
	p.Set("a", c)
	got, ok := p.Get("a")
	if !ok || got != c {
		t.Fatal("expected to get back the client")
	}
	p.Remove("a")
	if _, ok := p.Get("a"); ok {
		t.Fatal("expected client removed")
	}
}

func TestPool_IDs(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	p.Set("a", &ClusterClient{})
	p.Set("b", &ClusterClient{})
	ids := p.IDs()
	if len(ids) != 2 {
		t.Fatalf("expected 2 ids, got %v", ids)
	}
}

func TestPool_ConcurrentAccess(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("c%d", n%10)
			p.Set(id, &ClusterClient{})
			p.Get(id)
			p.IDs()
			if n%3 == 0 {
				p.Remove(id)
			}
		}(i)
	}
	wg.Wait()
}

func TestPool_AddCluster_Success(t *testing.T) {
	p, db, ci := newTestPool(t, fakeBuilder(nil))
	if err := p.AddCluster("prod", "Prod", "kubeconfig-plain"); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	// in pool
	if _, ok := p.Get("prod"); !ok {
		t.Fatal("expected client in pool")
	}
	// persisted, encrypted, healthy
	var cl model.Cluster
	if err := db.First(&cl, "id = ?", "prod").Error; err != nil {
		t.Fatalf("expected row persisted: %v", err)
	}
	if cl.Status != "Healthy" {
		t.Fatalf("expected Healthy, got %q", cl.Status)
	}
	if cl.LastCheck.IsZero() {
		t.Fatal("expected LastCheck set")
	}
	if cl.Kubeconfig == "kubeconfig-plain" {
		t.Fatal("kubeconfig must be encrypted at rest")
	}
	dec, err := ci.Decrypt(cl.Kubeconfig)
	if err != nil || dec != "kubeconfig-plain" {
		t.Fatalf("expected decrypt to plaintext, got %q err=%v", dec, err)
	}
}

func TestPool_AddCluster_PingFail_NoPersist(t *testing.T) {
	p, db, _ := newTestPool(t, fakeBuilder(errors.New("unreachable")))
	err := p.AddCluster("bad", "Bad", "kc")
	if err == nil {
		t.Fatal("expected AddCluster to fail on Ping error")
	}
	if _, ok := p.Get("bad"); ok {
		t.Fatal("expected nothing in pool")
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 0 {
		t.Fatalf("expected no rows persisted, got %d", n)
	}
}

func TestPool_AddCluster_DuplicateID(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	if err := p.AddCluster("dup", "A", "kc"); err != nil {
		t.Fatal(err)
	}
	err := p.AddCluster("dup", "B", "kc2")
	if !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("expected ErrDuplicateID, got %v", err)
	}
}

func TestPool_DeleteCluster(t *testing.T) {
	p, db, _ := newTestPool(t, fakeBuilder(nil))
	if err := p.AddCluster("gone", "Gone", "kc"); err != nil {
		t.Fatal(err)
	}
	if err := p.DeleteCluster("gone"); err != nil {
		t.Fatalf("expected delete success, got %v", err)
	}
	if _, ok := p.Get("gone"); ok {
		t.Fatal("expected removed from pool")
	}
	var n int64
	db.Model(&model.Cluster{}).Count(&n)
	if n != 0 {
		t.Fatalf("expected row deleted, got %d", n)
	}
}

func TestPool_DeleteCluster_InvokesOnDelete(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	if err := p.AddCluster("gone", "Gone", "kc"); err != nil {
		t.Fatal(err)
	}
	var got string
	p.OnDelete = func(id string) error { got = id; return nil }
	if err := p.DeleteCluster("gone"); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if got != "gone" {
		t.Fatalf("expected OnDelete called with 'gone', got %q", got)
	}
}

func TestPool_DeleteCluster_OnDeleteErrorRollsBack(t *testing.T) {
	p, db, _ := newTestPool(t, fakeBuilder(nil))
	if err := p.AddCluster("keep", "Keep", "kc"); err != nil {
		t.Fatal(err)
	}
	p.OnDelete = func(id string) error { return errors.New("cascade failed") }
	if err := p.DeleteCluster("keep"); err == nil {
		t.Fatal("expected error when OnDelete fails")
	}
	// transaction must roll back: row still present.
	var n int64
	db.Model(&model.Cluster{}).Where("id = ?", "keep").Count(&n)
	if n != 1 {
		t.Fatalf("expected rollback to keep row, got %d", n)
	}
}

func TestPool_DeleteCluster_NotFound(t *testing.T) {
	p, _, _ := newTestPool(t, fakeBuilder(nil))
	if err := p.DeleteCluster("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestPool_Rebuild(t *testing.T) {
	p, db, ci := newTestPool(t, fakeBuilder(nil))
	// seed two encrypted clusters directly
	for _, id := range []string{"x", "y"} {
		enc, _ := ci.Encrypt("kc-" + id)
		db.Create(&model.Cluster{ID: id, Name: id, Kubeconfig: enc, Status: "Unknown"})
	}
	if err := p.Rebuild(); err != nil {
		t.Fatalf("rebuild err: %v", err)
	}
	if _, ok := p.Get("x"); !ok {
		t.Fatal("expected x in pool")
	}
	if _, ok := p.Get("y"); !ok {
		t.Fatal("expected y in pool")
	}
}

func TestPool_Rebuild_BuildFailure_MarksUnreachable(t *testing.T) {
	// builder that always errors
	build := func(kubeconfig string) (*ClusterClient, error) {
		return nil, errors.New("build fail")
	}
	p, db, ci := newTestPool(t, build)
	enc, _ := ci.Encrypt("kc")
	db.Create(&model.Cluster{ID: "z", Name: "z", Kubeconfig: enc, Status: "Healthy"})
	if err := p.Rebuild(); err != nil {
		t.Fatalf("rebuild should not be fatal on single failure: %v", err)
	}
	if _, ok := p.Get("z"); ok {
		t.Fatal("expected z NOT in pool")
	}
	var cl model.Cluster
	db.First(&cl, "id = ?", "z")
	if cl.Status != "Unreachable" {
		t.Fatalf("expected Unreachable, got %q", cl.Status)
	}
}
