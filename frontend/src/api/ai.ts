import client from './client';
import type { Operations } from './role';
import type { AiChatEvent } from './aiChat';

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
}

export interface AiConfig {
  enabled: boolean;
  base_url: string;
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
  has_key: boolean;
}

export interface AiConfigInput {
  enabled: boolean;
  base_url: string;
  api_key?: string; // omit/empty = keep existing
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
}

export interface AiConversation {
  id: number;
  user_id: number;
  cluster_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AiMessage {
  id: number;
  conversation_id: number;
  role: string; // user / assistant / tool
  content: string;
  tool_calls: string; // JSON trace, may be empty
  created_at: string;
}

export const aiApi = {
  status: () => client.get<AiStatus>('/ai/status').then((r) => r.data),
  getConfig: () => client.get<AiConfig>('/ai/config').then((r) => r.data),
  putConfig: (body: AiConfigInput) => client.put('/ai/config', body).then((r) => r.data),
  getGrants: (clusterId: string) =>
    client
      .get<{ cluster_id: string; operations: Operations }>('/ai/grants', { params: { cluster_id: clusterId } })
      .then((r) => r.data.operations ?? {}),
  putGrants: (clusterId: string, operations: Operations) =>
    client.put('/ai/grants', { operations }, { params: { cluster_id: clusterId } }).then((r) => r.data),

  // ---- Conversations (current user; newest-first) ----
  listConversations: () =>
    client.get<{ conversations: AiConversation[] }>('/ai/conversations').then((r) => r.data.conversations ?? []),
  createConversation: (clusterId: string, title: string) =>
    client
      .post<{ id: number; cluster_id: string; title: string }>('/ai/conversations', {
        cluster_id: clusterId,
        title,
      })
      .then((r) => r.data),
  getConversation: (id: number) =>
    client
      .get<{ conversation: AiConversation; messages: AiMessage[] }>(`/ai/conversations/${id}`)
      .then((r) => r.data),
  // REST fallback for confirming staged writes when the WS is not open; the backend
  // replays the confirm result as a batch of Events (`POST /ai/conversations/:id/confirm`).
  confirmConversation: (id: number, approved: boolean) =>
    client
      .post<{ events: AiChatEvent[] }>(`/ai/conversations/${id}/confirm`, { approved })
      .then((r) => r.data.events ?? []),
};
