package auth

import "testing"

func TestHashAndVerify(t *testing.T) {
	hash, err := HashPassword("s3cret-pw")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "s3cret-pw" {
		t.Fatal("hash must not equal plaintext")
	}
	if !VerifyPassword(hash, "s3cret-pw") {
		t.Fatal("correct password should verify")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("wrong password should not verify")
	}
}

func TestVerifyPasswordConstant(t *testing.T) {
	hash, _ := HashPassword("s3cret-pw")
	if !VerifyPasswordConstant(hash, "s3cret-pw") {
		t.Fatal("correct password should verify")
	}
	if VerifyPasswordConstant(hash, "wrong") {
		t.Fatal("wrong password should not verify")
	}
	// 用户不存在(空 hash)：必须返回 false，且不 panic
	if VerifyPasswordConstant("", "anything") {
		t.Fatal("empty hash (user not found) must return false")
	}
}
