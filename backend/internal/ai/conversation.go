package ai

import (
	"time"

	"gorm.io/gorm"

	"omnikube/internal/model"
)

// ConvStore 负责 AI 会话与消息的持久化。
type ConvStore struct {
	db *gorm.DB
}

// NewConvStore 装配 ConvStore。
func NewConvStore(db *gorm.DB) *ConvStore {
	return &ConvStore{db: db}
}

// Create 新建一次会话，返回其自增 id。
func (s *ConvStore) Create(userID uint, clusterID, title string) (uint, error) {
	row := model.AIConversation{UserID: userID, ClusterID: clusterID, Title: title}
	if err := s.db.Create(&row).Error; err != nil {
		return 0, err
	}
	return row.ID, nil
}

// AppendMessage 追加一条消息，并顺带刷新会话的 updated_at（用于 List 排序）。
func (s *ConvStore) AppendMessage(convID uint, role, content, toolCalls string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		msg := model.AIMessage{ConversationID: convID, Role: role, Content: content, ToolCalls: toolCalls}
		if err := tx.Create(&msg).Error; err != nil {
			return err
		}
		return tx.Model(&model.AIConversation{}).Where("id = ?", convID).
			Update("updated_at", time.Now()).Error
	})
}

// Messages 返回会话内的消息，按 id 升序（即时间顺序）。
func (s *ConvStore) Messages(convID uint) ([]model.AIMessage, error) {
	var msgs []model.AIMessage
	err := s.db.Where("conversation_id = ?", convID).Order("id asc").Find(&msgs).Error
	return msgs, err
}

// List 返回某用户的会话，最新的在前（按 updated_at 倒序，再按 id 倒序兜底）。
func (s *ConvStore) List(userID uint) ([]model.AIConversation, error) {
	var convs []model.AIConversation
	err := s.db.Where("user_id = ?", userID).Order("updated_at desc, id desc").Find(&convs).Error
	return convs, err
}

// Get 返回单个会话（供 handler 做归属校验用）。
func (s *ConvStore) Get(convID uint) (model.AIConversation, error) {
	var conv model.AIConversation
	err := s.db.First(&conv, convID).Error
	return conv, err
}
