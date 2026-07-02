package cluster

import (
	"time"

	"gorm.io/gorm"

	"omnikube/internal/model"
)

// checkOnce 遍历池一遍，Ping 成功→Healthy 失败→Unreachable，更新 DB 状态。
func checkOnce(p *ClusterPool, db *gorm.DB) {
	for _, id := range p.IDs() {
		client, ok := p.Get(id)
		if !ok {
			continue
		}
		status := "Healthy"
		if err := client.Ping(); err != nil {
			status = "Unreachable"
		}
		db.Model(&model.Cluster{}).Where("id = ?", id).Updates(map[string]any{
			"status":     status,
			"last_check": time.Now(),
		})
	}
}

// StartHealthChecker 启动后台 goroutine，每 interval 遍历池更新健康状态。
// 返回 stop func（供测试/优雅关停）。
func StartHealthChecker(p *ClusterPool, db *gorm.DB, interval time.Duration) (stop func()) {
	done := make(chan struct{})
	ticker := time.NewTicker(interval)
	go func() {
		for {
			select {
			case <-ticker.C:
				checkOnce(p, db)
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()
	return func() {
		close(done)
	}
}
