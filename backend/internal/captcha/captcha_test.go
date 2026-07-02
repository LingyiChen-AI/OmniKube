package captcha

import (
	"bytes"
	"image/png"
	"testing"
	"time"
)

func TestGenerate_ProducesPNGAndVerifies(t *testing.T) {
	s := NewStore()
	id, pngBytes, err := s.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		t.Fatal("expected non-empty id")
	}
	if _, err := png.Decode(bytes.NewReader(pngBytes)); err != nil {
		t.Fatalf("output is not a valid PNG: %v", err)
	}
	// Grab the stored code to verify the happy path.
	s.mu.Lock()
	code := s.m[id].code
	s.mu.Unlock()
	if len(code) != codeLen {
		t.Fatalf("code length = %d, want %d", len(code), codeLen)
	}
	if !s.Verify(id, code) {
		t.Fatal("correct code must verify")
	}
	// One-time: second verify with same id fails.
	if s.Verify(id, code) {
		t.Fatal("captcha must be one-time (consumed on verify)")
	}
}

func TestVerify_WrongCode(t *testing.T) {
	s := NewStore()
	id, _, _ := s.Generate()
	if s.Verify(id, "zzzz") {
		t.Fatal("wrong code must not verify")
	}
	// Wrong attempt also consumes the id (anti-bruteforce).
	s.mu.Lock()
	_, exists := s.m[id]
	s.mu.Unlock()
	if exists {
		t.Fatal("id must be consumed even on wrong code")
	}
}

func TestVerify_Expired(t *testing.T) {
	s := NewStore()
	id, _, _ := s.Generate()
	s.mu.Lock()
	e := s.m[id]
	e.exp = time.Now().Add(-time.Second)
	s.m[id] = e
	code := e.code
	s.mu.Unlock()
	if s.Verify(id, code) {
		t.Fatal("expired captcha must not verify")
	}
}

func TestVerify_UnknownID(t *testing.T) {
	s := NewStore()
	if s.Verify("nope", "1234") {
		t.Fatal("unknown id must not verify")
	}
}
