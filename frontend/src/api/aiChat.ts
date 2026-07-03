import { wsBase } from './ws';
import { getToken } from '../store/auth';

/**
 * A single server → client frame from the `/ai/chat` WebSocket.
 *
 * The backend (`internal/ai` `Event`) serializes with lowercase JSON tags, so the
 * wire fields are `type/text/tool/args/result`:
 *   - `token`       — incremental assistant text (append to the current bubble).
 *   - `tool_call`   — the model invoked a tool (`tool` = name, `args` = JSON input).
 *   - `tool_result` — a tool returned (`result` = JSON result, `tool` = name).
 *   - `done`        — the turn ended (`text` = full answer).
 *   - `error`       — the turn failed (`text` = error message); also ends the turn.
 */
export interface AiChatEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  tool?: string;
  args?: string;
  result?: string;
}

/** Client → server frame: a user message on an already-created conversation. */
export interface AiUserMessage {
  type: 'user_message';
  conversation_id: number;
  text: string;
}

/**
 * Build the `/ai/chat` WebSocket URL. Browsers can't set headers on a WS handshake,
 * so the JWT rides in the query string (same pattern as exec/logs); `cluster_id` is
 * validated by the backend before the upgrade.
 */
export function aiChatUrl(clusterId: string): string {
  const q = new URLSearchParams({
    token: getToken() || '',
    cluster_id: clusterId,
  });
  return `${wsBase()}/ai/chat?${q.toString()}`;
}
