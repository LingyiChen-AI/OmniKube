package model

import "time"

type User struct {
	ID        uint   `gorm:"primaryKey"`
	Username  string `gorm:"unique;not null;size:50"`
	Password  string `gorm:"not null;size:100"` // bcrypt 哈希
	IsAdmin   bool   `gorm:"default:false"`
	MustReset bool   `gorm:"default:false"`
	Disabled  bool   `gorm:"default:false"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (User) TableName() string { return "ok_users" }

type Cluster struct {
	ID         string `gorm:"primaryKey;size:50"`
	Name       string `gorm:"not null;size:100"`
	Kubeconfig string `gorm:"type:text;not null"` // AES-256-GCM 密文
	Status     string `gorm:"size:20;default:'Unknown'"`
	LastCheck  time.Time
	// 发布通知机器人（可选）。JSON 数组 [{"type":"dingtalk|feishu|wecom","url":"..."}]。
	// 配置后, 该集群产生发布记录时同步推送消息到每个 webhook。
	Webhooks  string `gorm:"type:text" json:"-"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (Cluster) TableName() string { return "ok_clusters" }

type AuditLog struct {
	ID        uint      `gorm:"primaryKey"`
	UserID    string    `gorm:"index;size:50"`
	ClusterID string    `gorm:"index;size:50"`
	Namespace string    `gorm:"size:100"`
	Resource  string    `gorm:"size:100"`
	Action    string    `gorm:"size:20"`
	Target    string    `gorm:"size:200"`
	Result    string    `gorm:"size:20"`
	SourceIP  string    `gorm:"size:50"`
	CreatedAt time.Time `gorm:"index"`
}

func (AuditLog) TableName() string { return "ok_audit_logs" }

// CasbinRule 与 casbin gorm-adapter 默认 schema 对齐，A 阶段仅建表，
// 子项目 C 接入真正的 adapter 时复用同一张表。
type CasbinRule struct {
	ID    uint   `gorm:"primaryKey;autoIncrement"`
	Ptype string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V0    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V1    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V2    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V3    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V4    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
	V5    string `gorm:"size:100;uniqueIndex:idx_casbin_rule"`
}

func (CasbinRule) TableName() string { return "casbin_rule" }

// Role 是 admin 创建的命名权限模板（子项目 G/H）。内含若干 RoleRule。
type Role struct {
	ID          uint   `gorm:"primaryKey"`
	Name        string `gorm:"unique;not null;size:100"`
	Description string `gorm:"size:255"`
	Key         string `gorm:"size:50"`          // 预设角色稳定标识(如 "cluster-admin"), 前端据此 i18n; 自定义角色为空
	System      bool   `gorm:"default:false"`    // 预设角色, 不可删除(可编辑)
	Pages       string `gorm:"type:text"`         // 弃用, 保留列忽略
	GlobalPerms string `gorm:"type:text" json:"-"` // JSON: area→actions, e.g. {"clusters":["view"],"users":["view"],"roles":[],"releases":["view"]}
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func (Role) TableName() string { return "ok_roles" }

// RoleRule 每条规则绑定到单个集群（ClusterID="*" 表示所有集群, 仅 scope=cluster 允许）。
// 操作权限 = 资源组×动作, 存为 JSON map[group][]action（子项目 H）。
type RoleRule struct {
	ID         uint   `gorm:"primaryKey"`
	RoleID     uint   `gorm:"index;not null"`
	ClusterID  string `gorm:"size:50;not null"` // 单个集群 ID 或 "*"
	Scope      string `gorm:"size:20;not null"` // cluster | namespace
	Namespaces string `gorm:"type:text"`        // JSON 数组字符串, 仅 scope=namespace
	Operations string `gorm:"type:text"`        // JSON map[group][]action
}

func (RoleRule) TableName() string { return "ok_role_rules" }

// UserRole 用户↔角色 多对多关联。
type UserRole struct {
	UserID uint `gorm:"primaryKey"`
	RoleID uint `gorm:"primaryKey"`
}

func (UserRole) TableName() string { return "ok_user_roles" }

// ReleaseRecord 是一条「发布记录」审计行：当工作负载(Deployment/StatefulSet/DaemonSet)
// 的容器镜像 tag 发生变更并保存成功时追加一条，记录发布人、前后镜像与发布说明。
// 追加型审计，不可改不可删。
type ReleaseRecord struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	UserID      uint      `gorm:"index" json:"user_id"`
	Username    string    `gorm:"size:50" json:"username"` // 发布人(冗余, 便于展示)
	ClusterID   string    `gorm:"size:50;index" json:"cluster_id"`
	Namespace   string    `gorm:"size:100" json:"namespace"`
	Kind        string    `gorm:"size:30" json:"kind"` // Deployment/StatefulSet/DaemonSet
	Name        string    `gorm:"size:200" json:"name"`
	ImageBefore string    `gorm:"type:text" json:"image_before"` // "container=image;..." 拼接(多容器)
	ImageAfter  string    `gorm:"type:text" json:"image_after"`
	Comment     string    `gorm:"type:text" json:"comment"` // 发布说明(必填)
	CreatedAt   time.Time `gorm:"index" json:"created_at"`
}

func (ReleaseRecord) TableName() string { return "ok_release_records" }

// AIConfig 是全局唯一的 AI 助手模型配置（单行，id 恒为 1）。
type AIConfig struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Enabled      bool      `json:"enabled"`
	BaseURL      string    `gorm:"type:text" json:"base_url"`
	APIKeyEnc    string    `gorm:"type:text" json:"-"` // crypto.Cipher 加密后的 api_key
	ModelID      string    `gorm:"size:200" json:"model_id"`
	Temperature  float64   `json:"temperature"`
	SystemPrompt string    `gorm:"type:text" json:"system_prompt"`
	MaxSteps     int       `json:"max_steps"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (AIConfig) TableName() string { return "ok_ai_config" }

// AIGrant 是某集群下 AI 助手被授予的「资源 × 操作」范围（每集群一行）。
// Operations 与 RoleRule.Operations 同格式：JSON map[resource][]action。
type AIGrant struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	ClusterID  string    `gorm:"size:50;uniqueIndex;not null" json:"cluster_id"`
	Operations string    `gorm:"type:text" json:"operations"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func (AIGrant) TableName() string { return "ok_ai_grants" }

// AIConversation 是一次 AI 助手会话（隶属某用户、针对某集群）。
type AIConversation struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index;not null" json:"user_id"`
	ClusterID string    `gorm:"size:50" json:"cluster_id"`
	Title     string    `gorm:"size:200" json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `gorm:"index" json:"updated_at"`
}

func (AIConversation) TableName() string { return "ok_ai_conversations" }

// AIMessage 是会话中的一条消息。ToolCalls 存 JSON（工具调用轨迹，可空）。
type AIMessage struct {
	ID             uint      `gorm:"primaryKey" json:"id"`
	ConversationID uint      `gorm:"index;not null" json:"conversation_id"`
	Role           string    `gorm:"size:20;not null" json:"role"` // user/assistant/tool
	Content        string    `gorm:"type:text" json:"content"`
	ToolCalls      string    `gorm:"type:text" json:"tool_calls"` // JSON，可空
	CreatedAt      time.Time `gorm:"index" json:"created_at"`
}

func (AIMessage) TableName() string { return "ok_ai_messages" }
