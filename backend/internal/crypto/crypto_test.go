package crypto

import "testing"

func key32() []byte { return make([]byte, 32) }

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	c, err := New(key32())
	if err != nil {
		t.Fatal(err)
	}
	plain := "kubeconfig-secret-content"
	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("round trip mismatch: got %q want %q", got, plain)
	}
}

func TestEncrypt_NonceUnique(t *testing.T) {
	c, _ := New(key32())
	a, _ := c.Encrypt("same")
	b, _ := c.Encrypt("same")
	if a == b {
		t.Fatal("two encryptions of same plaintext must differ (random nonce)")
	}
}

func TestDecrypt_WrongKeyFails(t *testing.T) {
	c1, _ := New(key32())
	enc, _ := c1.Encrypt("data")
	other := make([]byte, 32)
	other[0] = 1
	c2, _ := New(other)
	if _, err := c2.Decrypt(enc); err == nil {
		t.Fatal("expected decryption with wrong key to fail")
	}
}
