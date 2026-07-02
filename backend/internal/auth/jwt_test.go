package auth

import (
	"testing"
	"time"
)

func TestJWT_IssueParse(t *testing.T) {
	m := NewJWTManager("secret", time.Hour)
	tok, err := m.Issue(42, true)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := m.Parse(tok)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || !claims.IsAdmin {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestJWT_Expired(t *testing.T) {
	m := NewJWTManager("secret", -time.Hour) // 已过期
	tok, _ := m.Issue(1, false)
	if _, err := m.Parse(tok); err == nil {
		t.Fatal("expected expired token to fail")
	}
}

func TestJWT_Tampered(t *testing.T) {
	m := NewJWTManager("secret", time.Hour)
	tok, _ := m.Issue(1, false)
	if _, err := m.Parse(tok + "x"); err == nil {
		t.Fatal("expected tampered token to fail")
	}
}

func TestJWT_WrongSecret(t *testing.T) {
	tok, _ := NewJWTManager("secret-a", time.Hour).Issue(1, false)
	if _, err := NewJWTManager("secret-b", time.Hour).Parse(tok); err == nil {
		t.Fatal("expected wrong-secret parse to fail")
	}
}
