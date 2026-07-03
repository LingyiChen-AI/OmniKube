# OmniKube AI Assistant — Phase 2 Plan (Read-only agent + streaming chat)

> **For agentic workers:** implement task-by-task with TDD, commit per task. Steps use `- [ ]`.

**Goal:** Make the OmniKube assistant actually work for **read/query** operations: a ReAct agent (Eino) that, given a user message, queries the currently-selected cluster's resources via gated read tools and streams its reasoning + answer back over WebSocket. No write operations yet (Phase 3).

**Architecture:** `internal/ai` gains a chat-model builder, a permission guard (AI grant ∩ user RBAC), read tools over the existing `ClusterPool` dynamic client, a ReAct agent, a streaming runner, and conversation persistence. A WebSocket endpoint `/ai/chat` (query-token auth like exec/logs) runs the runner and relays events. The frontend `AiAssistant` panel opens the WS, streams tokens, and shows a tool-step trace + conversation list.

**Verified Eino API (pinned versions):**
- `github.com/cloudwego/eino@v0.9.12`
- `github.com/cloudwego/eino-ext/components/model/openai@v0.1.13`
- ChatModel: `openai.NewChatModel(ctx, &openai.ChatModelConfig{APIKey, BaseURL, Model string; Temperature *float32})` → `*openai.ChatModel` (implements `model.ToolCallingChatModel`).
- ReAct agent: `react.NewAgent(ctx, &react.AgentConfig{ToolCallingModel model.ToolCallingChatModel, ToolsConfig compose.ToolsNodeConfig, MessageModifier react.MessageModifier, MaxStep int})` → `*react.Agent`.
  - Persona/system prompt: `react.NewPersonaModifier(systemPrompt)` → `MessageModifier`.
  - Run: `agent.Generate(ctx, []*schema.Message) (*schema.Message, error)` and `agent.Stream(ctx, []*schema.Message) (*schema.StreamReader[*schema.Message], error)` — **implementers: `go doc` the exact `Stream` signature and `schema.StreamReader.Recv()` before use.**
- Tools live in `compose.ToolsNodeConfig{Tools []tool.BaseTool}`. Build a custom tool from a Go function with `github.com/cloudwego/eino/components/tool/utils` — **implementers: `go doc github.com/cloudwego/eino/components/tool/utils` to pick `InferTool` / `NewTool` and confirm its signature (name, desc, func(ctx, *Params)(Result,error)).**
- Message shape: `schema.Message{Role schema.RoleType, Content string, ToolCalls []schema.ToolCall, ToolCallID string}` — `go doc github.com/cloudwego/eino/schema.Message` to confirm.

> **Rule for every task that touches Eino:** run the relevant `go doc` first to confirm exact leaf signatures against the pinned module, then write code. Do NOT run `go mod tidy` until eino is actually imported (Task 1 pins it).

Spec: `docs/superpowers/specs/2026-07-03-ai-assistant-design.md` (§4 double gate, §5 flow, §6 data model, §9 tools).

---

## Task 1: Pin Eino + chat-model builder

**Files:** Create `backend/internal/ai/model.go`; Test `backend/internal/ai/model_test.go`; modify `backend/go.mod`/`go.sum`.

- [ ] Pin deps: `cd backend && go get github.com/cloudwego/eino@v0.9.12 && go get github.com/cloudwego/eino-ext/components/model/openai@v0.1.13`.
- [ ] Write failing test `model_test.go`: `TestBuildChatModel` — `BuildChatModel(context.Background(), Config{BaseURL:"https://api.x/v1", APIKey:"k", ModelID:"m", Temperature:0.3})` returns a non-nil `model.ToolCallingChatModel` and no error (construction must not require network).
- [ ] Run → fail (undefined).
- [ ] Implement `model.go`: `func BuildChatModel(ctx context.Context, cfg Config) (model.ToolCallingChatModel, error)` mapping `Config` → `openai.ChatModelConfig` (BaseURL, APIKey, Model=cfg.ModelID; Temperature pointer if >0) and calling `openai.NewChatModel`. Import `model "github.com/cloudwego/eino/components/model"`.
- [ ] Run → pass. `go build ./... && go test ./internal/ai/`.
- [ ] Commit (include go.mod/go.sum): `feat(ai): eino chat-model builder from config`.

## Task 2: Permission guard (double gate)

**Files:** Create `backend/internal/ai/guard.go`, `guard_test.go`.

- [ ] Failing test: `Guard{Store, RBAC}.Allow(userID, cluster, namespace, resource, action)` returns true only when BOTH the AI grant for `cluster` includes `action` for `resource` AND `rbac.Authorize` allows it. Table: (grant yes + rbac yes → true), (grant no + rbac yes → false), (grant yes + rbac no → false). Use a real in-memory `Store` (Task-4 pattern: sqlite + `SaveGrant`) and a fake/real `rbac.Service`; for the rbac side, either construct a real `rbac.Service` seeded with a policy, or define a small `authorizer` interface `Authorize(userID, cluster, ns, resource, action string) (bool, []string, error)` that `Guard` depends on and stub it in the test. Prefer the interface for isolation.
- [ ] Implement `guard.go`: define `type authorizer interface { Authorize(...) (bool, []string, error) }`; `Guard{ store *Store; rbac authorizer }`; `Allow(...)` maps the tree action to casbin action (view→read, edit/create/delete/exec/reveal as in rbac), checks `store.LoadGrant(cluster)[resource]` membership, then `rbac.Authorize`. Return false on any error.
- [ ] Run → pass. Commit: `feat(ai): permission guard (AI grant ∩ user RBAC)`.

## Task 3: Read tools (list / get) over the cluster

**Files:** Create `backend/internal/ai/tools.go`, `tools_test.go`.

- [ ] `go doc github.com/cloudwego/eino/components/tool/utils` and `.../components/tool` to confirm the tool-builder + `tool.BaseTool` interface.
- [ ] Failing test: build the read tools with a fake dynamic client (reuse the fake-dynamic-client pattern from `internal/handler/resource_test.go` / `release_test.go`) and an always-allow guard; invoking `list_resources{resource:"deployments", namespace:"dev"}` returns the fake deployment names; a denying guard makes the tool return a "permission denied" result (not an error that crashes the agent).
- [ ] Implement `tools.go`: `func ReadTools(pool *cluster.ClusterPool, clusterID string, guard *Guard, userID uint) []tool.BaseTool` returning `list_resources` and `get_resource` tools. Each tool's run: parse params, call `guard.Allow(userID, clusterID, ns, resource, "view")`; if denied return a structured `{"error":"permission denied: ..."}` string result; else resolve GVR via the cluster client and list/get via the dynamic client, returning a compact JSON summary (name, namespace, key status fields — keep small to fit context).
- [ ] Run → pass. Commit: `feat(ai): gated read tools (list/get) for the agent`.

## Task 4: Conversation persistence

**Files:** modify `backend/internal/model/model.go` (+`AIConversation`, `AIMessage`), `backend/internal/database/database.go` (Migrate); create `backend/internal/ai/conversation.go`, `conversation_test.go`.

- [ ] Failing test (migrate + store): tables `ok_ai_conversations`/`ok_ai_messages` exist; `ConvStore.Create(userID, cluster, title)` returns an id; `AppendMessage(convID, role, content, toolCalls)` persists; `Messages(convID)` returns them in order; `List(userID)` returns the user's conversations newest-first.
- [ ] Implement models (`AIConversation{ID, UserID, ClusterID, Title, CreatedAt, UpdatedAt}`, `AIMessage{ID, ConversationID, Role, Content, ToolCalls string(JSON), CreatedAt}`) + migration + `conversation.go` store.
- [ ] Run → pass. Commit: `feat(ai): conversation + message persistence`.

## Task 5: ReAct agent + streaming runner

**Files:** Create `backend/internal/ai/agent.go`, `runner.go`, `runner_test.go`.

- [ ] `go doc` `react.Agent.Stream`, `schema.StreamReader`, `schema.Message` for exact signatures.
- [ ] `agent.go`: `func BuildAgent(ctx, cm model.ToolCallingChatModel, tools []tool.BaseTool, systemPrompt string, maxStep int) (*react.Agent, error)` → `react.NewAgent` with `ToolCallingModel`, `ToolsConfig: compose.ToolsNodeConfig{Tools: tools}`, `MessageModifier: react.NewPersonaModifier(systemPrompt)` (only if systemPrompt != ""), `MaxStep`.
- [ ] `runner.go`: `type Event struct { Type string; Text string; Tool string; Args string; Result string }` and `func (r *Runner) Stream(ctx, userID uint, clusterID, convID string, userText string, emit func(Event)) error` — loads history from ConvStore, appends the user message, builds model+tools+agent, calls `agent.Stream`, drains the StreamReader emitting `token` events for content deltas and (from the final/tool messages) `tool_call`/`tool_result` events, emits a final `done` event, and persists the assistant message. Keep the event mapping simple; if fine-grained tool events aren't available from the stream, at minimum emit streamed `token`s + a final `done`.
- [ ] Test with a **stub ChatModel** (implement a tiny `model.ToolCallingChatModel` that returns a canned message, injected into `BuildAgent`) so the runner is testable without network: assert `emit` receives tokens and a terminal `done`, and that user+assistant messages are persisted. (If stubbing the eino model interface is impractical, test `runner` logic via a seam that takes a pre-built agent or a fake `streamFunc`.)
- [ ] Run → pass. Commit: `feat(ai): react agent + streaming runner`.

## Task 6: WebSocket `/ai/chat` + conversation REST

**Files:** Create `backend/internal/ai/ws.go` (or `internal/handler/ai_chat.go`); modify `backend/internal/handler/ai.go` (conversation handlers) + `backend/internal/router/router.go`.

- [ ] `go doc`/read `internal/ws/*.go` (exec/logs) for the query-token upgrade + auth pattern and the gorilla/websocket usage; reuse it.
- [ ] WS `GET /ai/chat`: authenticate via `token` query param (verify JWT → userID), read the required `cluster_id` (query or first message), then loop: read `{type:"user_message", conversation_id, text}` → call `Runner.Stream(...)` with an `emit` that writes each `Event` as a JSON frame → on completion write the `done` frame. Guard the AI status (enabled) before running; if disabled, send an error frame and close.
- [ ] REST conversation handlers on `internal/handler/ai.go`: `ListConversations` (GET `/ai/conversations`), `CreateConversation` (POST), `GetConversation` (GET `/ai/conversations/:id`, owner-only), using `ConvStore`.
- [ ] Routes: WS `api.GET("/ai/chat", ...)` registered like exec/logs (NOT under the header-auth `authed` group); REST conversation routes under `authed`.
- [ ] Tests: a handler test for the conversation REST round-trip (create → list → get, owner isolation). (WS end-to-end is hard to unit test; a light framing test of the `emit`→frame encoder is enough.)
- [ ] Run → `go build ./... && go test ./...` green. Commit: `feat(ai): /ai/chat websocket + conversation REST`.

## Task 7: Frontend — streaming chat panel

**Files:** modify `frontend/src/components/AiAssistant.tsx`; create `frontend/src/api/aiChat.ts` (WS url + event types) and conversation calls in `frontend/src/api/ai.ts`; test `frontend/src/test/aiAssistant.test.tsx` (extend).

- [ ] `aiChat.ts`: build the WS URL (reuse `wsBase()` from `src/api/ws.ts`) `/ai/chat?token=...`; typed events (`token|tool_call|tool_result|done|error`). Add `listConversations/createConversation/getConversation` to `ai.ts`.
- [ ] `AiAssistant.tsx` (ready state): real chat panel — message list rendering streamed assistant text, a collapsible **tool-step trace** (tool_call/tool_result), an input that (on send) opens/uses the WS and streams the reply into the last assistant bubble; a conversation list/new-chat control; operate on `useCtxStore().currentCluster` (prompt to pick a cluster if none). Keep the ⚠️ not-configured state from Phase 1.
- [ ] Tests: with a mocked WebSocket, sending a message renders streamed tokens into the panel; the ⚠️ path still works. Use `userEvent.setup({ delay: null })`.
- [ ] `npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build` green. Commit: `feat(ai): streaming chat panel (read-only agent)`.

## Acceptance

- Backend `go build ./... && go test ./...` green.
- Frontend tsc/eslint/vitest/build green.
- Manual (against a real OpenAI-compatible endpoint configured in AI 配置, enabled, with read grants on a cluster + the user having RBAC read): open the OmniKube launcher, ask "列出 default 命名空间的部署", and see the agent stream a tool call + an answer. A user without the AI read grant OR without their own RBAC read gets a graceful "no permission" answer.

## Notes / risks

- Eino `agent.Stream` event granularity: if per-tool-call streaming events aren't cleanly exposed, Phase 2 still delivers streamed **text** + a final answer; the tool-step trace can be reconstructed from the returned message's tool calls. Don't block on perfect tool-event streaming.
- Keep tool result payloads small (names + key status) to protect the model context window.
- No writes in Phase 2 — register only read tools. Phase 3 adds write tools + interrupt/resume + audit.
