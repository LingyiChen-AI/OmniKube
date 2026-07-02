// Package audit 提供非阻断的审计日志助手，写入 ok_audit_logs。
package audit

import (
	"log"

	"gorm.io/gorm"

	"omnikube/internal/model"
)

// Entry 是一条审计记录的输入。
type Entry struct {
	UserID    string
	ClusterID string
	Namespace string
	Resource  string
	Action    string
	Target    string
	Result    string
	SourceIP  string
}

// Log 把一条审计记录写入 ok_audit_logs。写失败仅记日志，绝不阻断主流程。
func Log(db *gorm.DB, e Entry) {
	row := model.AuditLog{
		UserID:    e.UserID,
		ClusterID: e.ClusterID,
		Namespace: e.Namespace,
		Resource:  e.Resource,
		Action:    e.Action,
		Target:    e.Target,
		Result:    e.Result,
		SourceIP:  e.SourceIP,
	}
	if err := db.Create(&row).Error; err != nil {
		log.Printf("审计日志写入失败: %v", err)
	}
}
