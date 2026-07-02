package cluster

import (
	"errors"
	"testing"
	"time"

	"omnikube/internal/model"
)

func TestHealthChecker_UpdatesStatuses(t *testing.T) {
	p, db, _ := newTestPool(t, fakeBuilder(nil))
	// seed two DB rows so the checker can update them
	db.Create(&model.Cluster{ID: "good", Name: "good", Kubeconfig: "x", Status: "Unknown"})
	db.Create(&model.Cluster{ID: "bad", Name: "bad", Kubeconfig: "x", Status: "Unknown"})

	// inject clients with controlled Ping outcomes
	p.Set("good", &ClusterClient{Discovery: newStubDiscovery(nil)})
	p.Set("bad", &ClusterClient{Discovery: newStubDiscovery(errors.New("down"))})

	// run a single sweep synchronously
	checkOnce(p, db)

	var good, bad model.Cluster
	db.First(&good, "id = ?", "good")
	db.First(&bad, "id = ?", "bad")
	if good.Status != "Healthy" {
		t.Fatalf("expected good Healthy, got %q", good.Status)
	}
	if bad.Status != "Unreachable" {
		t.Fatalf("expected bad Unreachable, got %q", bad.Status)
	}
	if good.LastCheck.IsZero() || bad.LastCheck.IsZero() {
		t.Fatal("expected LastCheck updated")
	}
}

func TestStartHealthChecker_StopsCleanly(t *testing.T) {
	p, db, _ := newTestPool(t, fakeBuilder(nil))
	db.Create(&model.Cluster{ID: "good", Name: "good", Kubeconfig: "x", Status: "Unknown"})
	p.Set("good", &ClusterClient{Discovery: newStubDiscovery(nil)})

	stop := StartHealthChecker(p, db, 10*time.Millisecond)
	// give it a couple of ticks
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var c model.Cluster
		db.First(&c, "id = ?", "good")
		if c.Status == "Healthy" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	var c model.Cluster
	db.First(&c, "id = ?", "good")
	if c.Status != "Healthy" {
		t.Fatalf("expected Healthy after ticks, got %q", c.Status)
	}
}
