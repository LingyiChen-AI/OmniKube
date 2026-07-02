package auth

import "golang.org/x/crypto/bcrypt"

// dummyHash 预计算一个 bcrypt 哈希，供用户不存在时执行一次等时比较，
// 消除登录计时侧信道（防用户名枚举）。
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("omnikube-constant-time-dummy"), 12)

func HashPassword(pwd string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pwd), 12)
	return string(b), err
}

func VerifyPassword(hash, pwd string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pwd)) == nil
}

// VerifyPasswordConstant 与 VerifyPassword 相同，但当 hash 为空（用户不存在）时，
// 仍对 dummyHash 执行一次 bcrypt 比较以保持耗时一致，然后返回 false。
// 用于登录路径，避免“用户是否存在”被计时区分。
func VerifyPasswordConstant(hash, pwd string) bool {
	if hash == "" {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(pwd))
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pwd)) == nil
}
