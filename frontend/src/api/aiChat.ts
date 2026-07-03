import { wsBase } from './ws';
import { getToken } from '../store/auth';

/**
 * A single staged (pending-confirmation) write action, mirroring the backend
 * `ai.StagedAction` (`internal/ai/write_tools.go`, lowercase JSON tags). Carried
 * by the `confirm_required` frame and previewed in the confirmation card.
 *   - `action`   — verb: `create` / `update` / `delete`.
 *   - `resource` — canonical plural name, e.g. `deployments`.
 *   - `namespace`— namespace for namespaced resources; empty for cluster-scoped.
 *   - `name`     — resource name (for create, extracted from the manifest).
 *   - `manifest` — full resource object for create/update; absent for delete.
 */
export interface StagedAction {
  action: string;
  resource: string;
  namespace?: string;
  name?: string;
  manifest?: Record<string, unknown>;
}

/**
 * A single server → client frame from the `/ai/chat` WebSocket.
 *
 * The backend (`internal/ai` `Event`) serializes with lowercase JSON tags, so the
 * wire fields are `type/text/tool/args/result/actions`:
 *   - `token`            — incremental assistant text (append to the current bubble).
 *   - `tool_call`        — the model invoked a tool (`tool` = name, `args` = JSON input).
 *   - `tool_result`      — a tool returned (`result` = JSON result, `tool` = name).
 *   - `done`             — the turn ended (`text` = full answer).
 *   - `error`            — the turn failed (`text` = error message); also ends the turn.
 *   - `confirm_required` — the turn staged write actions needing confirmation
 *                          (`text` = assistant answer, `actions` = staged preview);
 *                          does NOT end the turn — the composer stays disabled until
 *                          the user confirms/cancels.
 */
export interface AiChatEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'confirm_required';
  text?: string;
  tool?: string;
  args?: string;
  result?: string;
  actions?: StagedAction[];
}

/** Client → server frame: a user message on an already-created conversation. */
export interface AiUserMessage {
  type: 'user_message';
  conversation_id: number;
  text: string;
}

/** Client → server frame: confirm (or cancel) the pending staged write actions. */
export interface AiConfirmMessage {
  type: 'confirm';
  conversation_id: number;
  approved: boolean;
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
