package cluster

import (
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"omnikube/internal/crypto"
	"omnikube/internal/model"
)

var (
	// ErrDuplicateID 集群标识已存在（handler 映射为 409）。
	ErrDuplicateID = errors.New("集群标识已存在")
	// ErrNotFound 集群不存在（handler 映射为 404）。
	ErrNotFound = errors.New("集群不存在")
)

// ClusterPool 线程安全的多集群连接池。
type ClusterPool struct {
	mu      sync.RWMutex
	clients map[string]*ClusterClient
	build   ClientBuilder // 可注入，便于单测
	cipher  *crypto.Cipher
	db      *gorm.DB

	// OnDelete 可选的级联清理回调，在 DeleteCluster 删 DB 行的同一事务内调用。
	// main 装配时设为 rbac.Service.RemoveClusterPolicies，避免 cluster 包反向依赖 rbac（循环依赖）。
	OnDelete func(clusterID string) error
}

func NewPool(db *gorm.DB, cipher *crypto.Cipher, build ClientBuilder) *ClusterPool {
	return &ClusterPool{
		clients: make(map[string]*ClusterClient),
		build:   build,
		cipher:  cipher,
		db:      db,
	}
}

func (p *ClusterPool) Get(id string) (*ClusterClient, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	c, ok := p.clients[id]
	return c, ok
}

func (p *ClusterPool) Set(id string, c *ClusterClient) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.clients[id] = c
}

func (p *ClusterPool) Remove(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.clients, id)
}

// IDs 返回池中集群 ID 的快照（读锁）。
func (p *ClusterPool) IDs() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	ids := make([]string, 0, len(p.clients))
	for id := range p.clients {
		ids = append(ids, id)
	}
	return ids
}

// Rebuild 启动时从 DB 全量重建：解密 kubeconfig → build → 入池。
// 单个集群失败不致命，记录日志并把该集群 Status 置 Unreachable。
func (p *ClusterPool) Rebuild() error {
	var clusters []model.Cluster
	if err := p.db.Find(&clusters).Error; err != nil {
		return err
	}
	for _, cl := range clusters {
		plain, err := p.cipher.Decrypt(cl.Kubeconfig)
		if err != nil {
			log.Printf("集群 %s 解密失败: %v", cl.ID, err)
			p.markUnreachable(cl.ID)
			continue
		}
		client, err := p.build(plain)
		if err != nil {
			log.Printf("集群 %s 构建客户端失败: %v", cl.ID, err)
			p.markUnreachable(cl.ID)
			continue
		}
		p.Set(cl.ID, client)
	}
	return nil
}

func (p *ClusterPool) markUnreachable(id string) {
	p.db.Model(&model.Cluster{}).Where("id = ?", id).Updates(map[string]any{
		"status":     "Unreachable",
		"last_check": time.Now(),
	})
}

// AddCluster 添加流程：build(明文) → Ping 自检 → 加密落库 → 入池（事务）。
// 失败时不落库、不入池。重复 ID 返回 ErrDuplicateID。
func (p *ClusterPool) AddCluster(id, name, kubeconfig string) error {
	// 重复检查
	var count int64
	if err := p.db.Model(&model.Cluster{}).Where("id = ?", id).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrDuplicateID
	}

	// build + Ping 自检（明文，不落库）
	client, err := p.build(kubeconfig)
	if err != nil {
		return fmt.Errorf("集群连接失败: %w", err)
	}
	if err := client.Ping(); err != nil {
		return fmt.Errorf("集群连接失败: %w", err)
	}

	// 加密落库
	enc, err := p.cipher.Encrypt(kubeconfig)
	if err != nil {
		return err
	}
	row := model.Cluster{
		ID:         id,
		Name:       name,
		Kubeconfig: enc,
		Status:     "Healthy",
		LastCheck:  time.Now(),
	}
	if err := p.db.Transaction(func(tx *gorm.DB) error {
		return tx.Create(&row).Error
	}); err != nil {
		return err
	}

	p.Set(id, client)
	return nil
}

// TestConnection 仅 build + Ping 自检，不落库、不入池。
func (p *ClusterPool) TestConnection(kubeconfig string) error {
	client, err := p.build(kubeconfig)
	if err != nil {
		return fmt.Errorf("集群连接失败: %w", err)
	}
	if err := client.Ping(); err != nil {
		return fmt.Errorf("集群连接失败: %w", err)
	}
	return nil
}

// UpdateCluster 更新集群 name/kubeconfig。
// 传入非空 kubeconfig 时重建客户端（build → Ping 自检 → 加密落库 → 换池）；
// 仅改名时不触碰客户端。集群不存在返回 ErrNotFound。
func (p *ClusterPool) UpdateCluster(id, name, kubeconfig string) error {
	var cl model.Cluster
	if err := p.db.First(&cl, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		return err
	}

	updates := map[string]any{}
	if name != "" {
		updates["name"] = name
	}

	var newClient *ClusterClient
	if kubeconfig != "" {
		client, err := p.build(kubeconfig)
		if err != nil {
			return fmt.Errorf("集群连接失败: %w", err)
		}
		if err := client.Ping(); err != nil {
			return fmt.Errorf("集群连接失败: %w", err)
		}
		enc, err := p.cipher.Encrypt(kubeconfig)
		if err != nil {
			return err
		}
		newClient = client
		updates["kubeconfig"] = enc
		updates["status"] = "Healthy"
		updates["last_check"] = time.Now()
	}

	if len(updates) == 0 {
		return nil
	}
	if err := p.db.Model(&model.Cluster{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		return err
	}
	if newClient != nil {
		p.Set(id, newClient)
	}
	return nil
}

// DeleteCluster：删 DB + 摘除池（事务）。
func (p *ClusterPool) DeleteCluster(id string) error {
	var cl model.Cluster
	if err := p.db.First(&cl, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		return err
	}
	if err := p.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.Cluster{}, "id = ?", id).Error; err != nil {
			return err
		}
		// 级联清理该集群相关的 Casbin g 绑定（回调注入，见 OnDelete 字段说明）。
		if p.OnDelete != nil {
			if err := p.OnDelete(id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	p.Remove(id)
	return nil
}
