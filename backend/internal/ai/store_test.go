package ai

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/database"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func testCipher(t *testing.T) *crypto.Cipher {
	t.Helper()
	c, err := crypto.New(make([]byte, 32)) // 32-byte zero key is fine for tests
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConfigRoundTripEncryptsKey(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	s := NewStore(db, cipher)

	if err := s.SaveConfig(ConfigInput{Enabled: true, BaseURL: "https://api.x/v1", APIKey: "secret-key", ModelID: "gpt-x"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.BaseURL != "https://api.x/v1" || got.ModelID != "gpt-x" {
		t.Fatalf("config not persisted: %+v", got)
	}
	if got.APIKey != "secret-key" {
		t.Fatalf("api key not decrypted, got %q", got.APIKey)
	}
	if !got.HasKey {
		t.Fatal("HasKey should be true")
	}
}

func TestSaveConfigBlankKeyKeepsExisting(t *testing.T) {
	db, cipher := testDB(t), testCipher(t)
	s := NewStore(db, cipher)
	_ = s.SaveConfig(ConfigInput{BaseURL: "u", APIKey: "k1", ModelID: "m"})
	// Second save with empty APIKey must keep k1.
	_ = s.SaveConfig(ConfigInput{BaseURL: "u2", APIKey: "", ModelID: "m"})
	got, _ := s.LoadConfig()
	if got.APIKey != "k1" {
		t.Fatalf("blank key should keep existing, got %q", got.APIKey)
	}
	if got.BaseURL != "u2" {
		t.Fatalf("other fields should update, got %q", got.BaseURL)
	}
}
