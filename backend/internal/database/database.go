package database

import (
	"crypto/rand"
	"log"
	"math/big"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/model"
)

func Connect(dsn string) (*gorm.DB, error) {
	return gorm.Open(postgres.Open(dsn), &gorm.Config{})
}

func Migrate(db *gorm.DB) error {
	return db.AutoMigrate(
		&model.User{},
		&model.Cluster{},
		&model.AuditLog{},
		&model.CasbinRule{},
		&model.Role{},
		&model.RoleRule{},
		&model.UserRole{},
		&model.ReleaseRecord{},
	)
}

// BootstrapAdmin 在 ok_users 为空时创建一个随机密码的管理员，
// 明文密码仅打印到启动日志一次。
func BootstrapAdmin(db *gorm.DB, username string) error {
	var count int64
	if err := db.Model(&model.User{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	pwd, err := generatePassword(16)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(pwd)
	if err != nil {
		return err
	}
	admin := model.User{Username: username, Password: hash, IsAdmin: true, MustReset: true}
	if err := db.Create(&admin).Error; err != nil {
		return err
	}
	log.Printf("==== OmniKube 初始管理员已创建 ====")
	log.Printf("用户名: %s", username)
	log.Printf("初始密码(仅显示一次, 请立即登录修改): %s", pwd)
	log.Printf("===================================")
	return nil
}

func generatePassword(n int) (string, error) {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%"
	b := make([]byte, n)
	max := big.NewInt(int64(len(charset)))
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = charset[idx.Int64()]
	}
	return string(b), nil
}
