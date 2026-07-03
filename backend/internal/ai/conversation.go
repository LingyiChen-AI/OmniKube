package ai

import (
	"encoding/json"
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

// AppendAssistant 追加一条助手消息，并携带待确认的暂存写操作（pendingAction 为
// []StagedAction 的 JSON，空串表示无待确认动作）。除 pending_action 外与 AppendMessage
// 等价（顺带刷新会话 updated_at）。
func (s *ConvStore) AppendAssistant(convID uint, content, toolCalls, pendingAction string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		msg := model.AIMessage{
			ConversationID: convID, Role: "assistant",
			Content: content, ToolCalls: toolCalls, PendingAction: pendingAction,
		}
		if err := tx.Create(&msg).Error; err != nil {
			return err
		}
		return tx.Model(&model.AIConversation{}).Where("id = ?", convID).
			Update("updated_at", time.Now()).Error
	})
}

// LatestPending 返回会话内「最近一条仍带待确认写操作」的消息 id 与解析后的动作列表。
// ok==false 表示无待确认动作（或解析失败——按无处理，避免误执行残缺动作）。
func (s *ConvStore) LatestPending(convID uint) (msgID uint, actions []StagedAction, ok bool) {
	var msg model.AIMessage
	err := s.db.Where("conversation_id = ? AND pending_action != ''", convID).
		Order("id desc").First(&msg).Error
	if err != nil {
		return 0, nil, false
	}
	if err := json.Unmarshal([]byte(msg.PendingAction), &actions); err != nil || len(actions) == 0 {
		return 0, nil, false
	}
	return msg.ID, actions, true
}

// ClearPending 清空某条消息的待确认写操作（确认执行或取消后调用，防止二次确认）。
func (s *ConvStore) ClearPending(msgID uint) error {
	return s.db.Model(&model.AIMessage{}).Where("id = ?", msgID).
		Update("pending_action", "").Error
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
