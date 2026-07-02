package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

func secretObj(ns, name string, data map[string][]byte) *corev1.Secret {
	return &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Data:       data,
	}
}

// Invariant #3: reveal authorizes action="reveal" and writes an audit row every time.
func TestRevealSecret_AllowDecodesAndAudits(t *testing.T) {
	cc := typedCC(secretObj("dev", "db", map[string][]byte{"password": []byte("s3cr3t")}))
	app, db, h := resApp(t, cc)
	// NS-Editor has config(reveal) which includes secrets.
	_ = h.RBAC.AddGrant("5", rbac.RoleNSEditor, "c1:dev")

	w := resReq(app, "POST", "/api/v1/namespaces/dev/resources/secrets/db/reveal", "5", false, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Data map[string]string `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Data["password"] != "s3cr3t" {
		t.Fatalf("expected decoded plaintext, got %v", resp.Data)
	}
	var allow int64
	db.Model(&model.AuditLog{}).Where("action = ? AND result = ? AND target = ?", "reveal", "allow", "secret/db").Count(&allow)
	if allow != 1 {
		t.Fatalf("expected 1 reveal allow audit, got %d", allow)
	}
}

func TestRevealSecret_DenyAudits(t *testing.T) {
	cc := typedCC(secretObj("dev", "db", map[string][]byte{"password": []byte("s3cr3t")}))
	app, db, h := resApp(t, cc)
	// NS-Viewer only reads, no reveal.
	_ = h.RBAC.AddGrant("8", rbac.RoleNSViewer, "c1:dev")

	w := resReq(app, "POST", "/api/v1/namespaces/dev/resources/secrets/db/reveal", "8", false, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d (%s)", w.Code, w.Body.String())
	}
	var deny int64
	db.Model(&model.AuditLog{}).Where("action = ? AND result = ?", "reveal", "deny").Count(&deny)
	if deny != 1 {
		t.Fatalf("expected 1 reveal deny audit, got %d", deny)
	}
}

func TestRevealSecret_AdminBypassAudits(t *testing.T) {
	cc := typedCC(secretObj("dev", "db", map[string][]byte{"k": []byte("v")}))
	app, db, _ := resApp(t, cc)

	w := resReq(app, "POST", "/api/v1/namespaces/dev/resources/secrets/db/reveal", "1", true, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin reveal expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var allow int64
	db.Model(&model.AuditLog{}).Where("action = ? AND result = ?", "reveal", "allow").Count(&allow)
	if allow != 1 {
		t.Fatalf("expected 1 reveal allow audit for admin, got %d", allow)
	}
}
