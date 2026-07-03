package ai

import (
	"context"
	"testing"
)

func TestBuildChatModel(t *testing.T) {
	cm, err := BuildChatModel(context.Background(), Config{
		BaseURL:     "https://api.x/v1",
		APIKey:      "k",
		ModelID:     "m",
		Temperature: 0.3,
	})
	if err != nil {
		t.Fatalf("BuildChatModel err: %v", err)
	}
	if cm == nil {
		t.Fatal("expected non-nil ToolCallingChatModel")
	}
}
