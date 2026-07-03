# OmniKube AI Assistant — Phase 3 Plan (Write operations with confirmation + audit)

> **For agentic workers:** implement task-by-task with TDD, commit per task.

**Goal:** Let the OmniKube assistant perform **write** operations (create / update / delete) on the selected cluster — but only after the user explicitly confirms, and only within the double gate (AI grant ∩ user RBAC). Every AI-executed write is audited.

**Architecture decision (important):** Eino v0.9.12's high-level `react` agent does NOT expose the `compose` interrupt/resume/checkpoint API (that lives on the low-level graph; `InterruptAndRerun` is deprecated). So Phase 3 uses an equivalent, more robust **two-phase (stage → confirm → execute)** design implemented at OUR runner/tool level — NOT Eino graph interrupts. Product behavior matches spec §5 (writes require confirmation); the mechanism differs:

1. **Stage:** write tools registered with the agent do NOT mutate the cluster. On call they (a) resolve GVR + gate via `Guard.Allow(userID, cluster, ns, resource, <write action>)`; (b) if allowed, append the proposed action to a per-run collector and return an observation like "已暂存待确认:将 create deployments/foo,等待确认"; (c) never touch the cluster.
2. **Confirm:** after the agent turn, if any actions were staged, the Runner emits a `confirm_required` frame (with previews), persists them as `pending_action` on the assistant message, and returns WITHOUT executing.
3. **Execute:** on user confirm (`{type:"confirm",approved}` over WS, or the REST fallback), the Runner **re-gates each action** and executes it via the dynamic client, writes an audit row per action, and emits `tool_result` + `done`. On reject it discards and emits a note.

Known limitation (acceptable for Phase 3): the agent cannot observe a write's result mid-turn (no write→read→write chaining within one turn). Writes are proposed at end-of-turn and executed after confirmation.

**Verified Eino/stack facts:** `eino v0.9.12` + `eino-ext/components/model/openai v0.1.13` already pinned (Phase 2). Write tools use `tool/utils.InferTool` (same as read tools). Cluster writes via `cluster.ClusterPool` dynamic client (`Create`/`Update`/`Delete`) — mirror `internal/handler/resource.go`. Audit rows via the existing `ok_audit_logs` model (see `internal/model` + how `internal/middleware/audit.go` writes rows).

Spec: `docs/superpowers/specs/2026-07-03-ai-assistant-design.md` (§4 gate, §5 flow, §9 tools, §10 audit).

Existing Phase-2 code to build on: `internal/ai/{guard,tools,runner,agent,conversation,model,store}.go`, `internal/ws/ai_chat.go`, `internal/handler/ai.go`.

---

## Task 1: Write tools that STAGE (don't execute)

**Files:** create `backend/internal/ai/write_tools.go`, `write_tools_test.go`.

- [ ] Define `type StagedAction struct { Action, Resource, Namespace, Name string; Manifest map[string]any }` and a collector `type Stager struct { mu sync.Mutex; actions []StagedAction }` with `Add(StagedAction)` and `Actions() []StagedAction`.
- [ ] `func WriteTools(pool *cluster.ClusterPool, clusterID string, guard *Guard, userID uint, stager *Stager) []tool.BaseTool` returning `create_resource`, `update_resource`, `delete_resource` as `tool.BaseTool` (via `utils.InferTool`). Param structs:
  - create: `{resource string; namespace string; manifest map[string]any}`
  - update: `{resource string; namespace string; name string; manifest map[string]any}`
  - delete: `{resource string; namespace string; name string}`
- [ ] Each tool's run: resolve GVR (canonical resource); map to the write action (`create`→create, `update`→edit, `delete`→delete); `guard.Allow(userID, clusterID, namespace, canonicalResource, action)`; if denied return structured `{"error":"permission denied: ..."}`; if allowed, `stager.Add(...)` and return `{"staged": true, "summary": "将 <action> <resource>/<name>..."}` — **do NOT call the dynamic client**.
- [ ] Failing test → implement → pass: with an always-allow guard, calling `create_resource` stages exactly one action and does NOT mutate the fake dynamic client (the fake client's tracker shows no create); with a denying guard it returns permission-denied and stages nothing.
- [ ] `go test ./internal/ai/`. Commit: `feat(ai): staging write tools (create/update/delete)`.

## Task 2: Executor — apply staged actions + audit

**Files:** create `backend/internal/ai/executor.go`, `executor_test.go`.

- [ ] `func (e *Executor) Apply(ctx, userID uint, username, clusterID string, a StagedAction) error` — re-gate `guard.Allow(userID, cluster, a.Namespace, a.Resource, action(a.Action))` (defence in depth; deny → error), resolve GVR, then `Create`/`Update`/`Delete` via the dynamic client (mirror `resource.go`), and write an audit row: `model.AuditLog{UserID, Username, ClusterID, Namespace, Resource: a.Resource, Name: a.Name, Action: "ai_"+a.Action, ...}` with a note/detail "via OmniKube AI". Confirm the exact `AuditLog` fields by reading `internal/model` + `internal/middleware/audit.go`.
- [ ] Failing test → implement → pass: applying a `create` action calls the fake dynamic client's create and writes one audit row with `action="ai_create"` and the actor; a re-gate denial returns an error and does NOT mutate or audit.
- [ ] Commit: `feat(ai): executor applies confirmed AI writes + audit`.

## Task 3: Runner — stage-aware turn + Confirm

**Files:** modify `backend/internal/ai/runner.go`, `runner_test.go`.

- [ ] In `Runner.Stream`: build the agent with BOTH read tools and write tools (write tools share a fresh `Stager` per call). After the agent stream drains, if `stager.Actions()` is non-empty: emit a `confirm_required` Event carrying a JSON preview of the actions, persist the assistant message WITH a `pending_action` (JSON of the staged actions) — extend `ConvStore.AppendMessage` or add `AppendAssistant(convID, content, toolCalls, pendingAction)` — and RETURN (do not execute). If no staged actions, behave exactly as Phase 2 (`done`).
- [ ] Add `func (r *Runner) Confirm(ctx, userID uint, username, convID string, approved bool, emit func(Event)) error` — load the latest assistant message's `pending_action` for the conversation (owner-checked via `convs.Get`), and: if approved, for each staged action call `Executor.Apply(...)`, emit a `tool_result` per action (ok/err), then `done`; if rejected, emit a `done` with a "已取消" note. Clear the pending action after handling (so it can't be double-confirmed).
- [ ] Data model: add `PendingAction string` (JSON, nullable) to `model.AIMessage` + migration; `ConvStore` gains `LatestPending(convID) (msgID uint, actions []StagedAction, ok bool)` and `ClearPending(msgID)`.
- [ ] Tests (inject a fake Executor + the `newAgent` seam whose canned stream includes a write tool call): a turn that stages emits `confirm_required` and persists `pending_action`, executes nothing; `Confirm(approved=true)` applies each action via the fake executor and emits results + done; `Confirm(approved=false)` executes nothing and emits a cancel note; owner mismatch on Confirm is rejected.
- [ ] Commit: `feat(ai): stage-and-confirm write turns in the runner`.

## Task 4: WS + REST confirm

**Files:** modify `backend/internal/ws/ai_chat.go`; add a REST confirm handler in `internal/handler/ai.go`; routes.

- [ ] WS: accept `{type:"confirm", conversation_id, approved bool}` in the read loop → call `Runner.Confirm(...)` with an `emit` writing frames (reuse the cancel-on-disconnect + terminal-frame plumbing). Owner + config checks as for `user_message`.
- [ ] REST fallback `POST /ai/conversations/:id/confirm` body `{approved bool}` (owner-only) → runs `Runner.Confirm` collecting events into a JSON array response (for reconnect clients that lost the socket). Register under `authed`.
- [ ] Tests: a light handler test for the REST confirm round-trip (stage via a seam, confirm approves → executor called; reject → not).
- [ ] `go build ./... && go test ./...` green. Commit: `feat(ai): confirm staged writes over WS + REST`.

## Task 5: Frontend — confirmation card

**Files:** modify `frontend/src/components/AiAssistant.tsx`, `frontend/src/api/aiChat.ts` (event/message types), test.

- [ ] `aiChat.ts`: extend `AiChatEvent` with the `confirm_required` frame shape (carries the staged actions preview) and add a `confirm` outbound message type `{type:"confirm", conversation_id, approved}`.
- [ ] `AiAssistant.tsx`: on `confirm_required`, render an inline **confirmation card** under the assistant bubble listing the proposed actions (action + resource + namespace/name, and a compact manifest preview for create/update) with **确认执行 / 取消** buttons; the composer stays disabled until resolved. Clicking sends `{type:"confirm", conversation_id, approved}`; render the subsequent `tool_result`/`done`. Handle the case where the socket dropped: fall back to `POST /ai/conversations/:id/confirm`.
- [ ] i18n: `ai.confirmTitle`, `ai.confirmRun`, `ai.cancel`, `ai.willExecute`, etc. in all 7 locales.
- [ ] Tests (mocked WS): a `confirm_required` frame renders the card + buttons; clicking 确认执行 sends the confirm frame and streamed results render; clicking 取消 sends `approved:false`.
- [ ] `npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build` green. Commit: `feat(ai): write-confirmation card in the chat panel`.

## Acceptance

- Backend `go build ./... && go test ./...` green; frontend tsc/eslint/vitest/build green.
- Manual (AI enabled, a cluster with `deployments:create` in BOTH the AI grant and the user's RBAC): ask "在 default 创建一个 nginx 部署" → the assistant proposes the manifest and shows a confirm card → 确认 → the deployment is created AND an `ai_create` audit row appears in 审计日志 with the user as actor. A user lacking `deployments:create` in either gate gets a graceful "no permission" and no confirm card / no write.

## Notes / risks

- **Double-gate at BOTH stage and execute** — never trust the model; re-check on Apply.
- The system prompt should instruct: "when you intend to change the cluster, call the write tool to stage it, then STOP and let the user confirm; never claim a change is done before confirmation." (Update the default system prompt string, or rely on tool observations.)
- Keep manifest previews compact in the UI.
- Multi-write turns: present all staged actions in one confirm card; execute in order; report per-action results.
- No Eino graph interrupts used — if a future Eino release exposes react-agent interrupt/resume cleanly, this can be revisited.
