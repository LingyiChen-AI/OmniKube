package ai

import (
	"testing"

	"omnikube/internal/model"
)

func TestConversationStore(t *testing.T) {
	db := testDB(t)

	// 迁移应已建好两张表。
	if !db.Migrator().HasTable(&model.AIConversation{}) {
		t.Fatal("ok_ai_conversations table missing")
	}
	if !db.Migrator().HasTable(&model.AIMessage{}) {
		t.Fatal("ok_ai_messages table missing")
	}

	cs := NewConvStore(db)

	id, err := cs.Create(1, "c1", "第一次对话")
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("expected non-zero conversation id")
	}

	if err := cs.AppendMessage(id, "user", "列出 dev 的部署", ""); err != nil {
		t.Fatal(err)
	}
	if err := cs.AppendMessage(id, "assistant", "好的", `[{"name":"list_resources"}]`); err != nil {
		t.Fatal(err)
	}

	msgs, err := cs.Messages(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("messages out of order: %+v", msgs)
	}
	if msgs[1].ToolCalls == "" {
		t.Fatal("tool calls not persisted")
	}

	// List：newest-first，且按 user 隔离。
	id2, _ := cs.Create(1, "c1", "第二次对话")
	_, _ = cs.Create(2, "c1", "别人的对话")

	list, err := cs.List(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 conversations for user 1, got %d", len(list))
	}
	if list[0].ID != id2 {
		t.Fatalf("expected newest-first (id %d) got %d", id2, list[0].ID)
	}
}
