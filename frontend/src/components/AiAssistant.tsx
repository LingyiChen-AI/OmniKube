import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Collapse, Input, Select, Tooltip, Typography, theme as antdTheme } from 'antd';
import {
  CloseOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltFilled,
  WarningFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { aiApi, type AiConversation, type AiMessage } from '../api/ai';
import { aiChatUrl, type AiChatEvent, type StagedAction } from '../api/aiChat';
import { useCtxStore } from '../store/ctx';

interface ToolStep {
  tool: string;
  args?: string;
  result?: string;
}

/** Pending write actions awaiting the user's confirmation, attached to an assistant bubble. */
interface PendingConfirm {
  actions: StagedAction[];
  resolved: boolean; // true once the user clicked confirm/cancel (disables the buttons)
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tools: ToolStep[];
  confirm?: PendingConfirm;
}

const WIN_W = 404;
const WIN_H = 616;
const FAB = 56;

interface Pos {
  x: number;
  y: number;
}

/** Clamp a top-left position so a w×h box stays fully within the viewport. */
function clampPos(p: Pos, w: number, h: number): Pos {
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return { x: Math.min(Math.max(8, p.x), maxX), y: Math.min(Math.max(8, p.y), maxY) };
}

/**
 * Pointer-driven dragging with viewport clamping and localStorage persistence.
 * `movedRef` distinguishes a drag from a click (so the launcher opens only when
 * it wasn't dragged). Compares against the drag-start point to avoid stale state.
 */
function useDrag(w: number, h: number, storageKey: string, initial: () => Pos) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return clampPos(JSON.parse(raw) as Pos, w, h);
    } catch {
      /* ignore */
    }
    return clampPos(initial(), w, h);
  });
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const movedRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y };
    movedRef.current = false;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) movedRef.current = true;
    setPos(clampPos({ x: d.bx + (e.clientX - d.sx), y: d.by + (e.clientY - d.sy) }, w, h));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setPos((p) => {
      const c = clampPos(p, w, h);
      try {
        localStorage.setItem(storageKey, JSON.stringify(c));
      } catch {
        /* ignore */
      }
      return c;
    });
  };

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p, w, h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [w, h]);

  return { pos, movedRef, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

/** Parse the persisted eino tool-call trace (JSON `[]schema.ToolCall`) into UI steps. */
function parseToolCalls(raw: string): ToolStep[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ function?: { name?: string; arguments?: string } }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((tc) => ({ tool: tc.function?.name ?? '', args: tc.function?.arguments }));
  } catch {
    return [];
  }
}

/** Parse the persisted `pending_action` JSON (`[]StagedAction`) into staged actions. */
function parseStagedActions(raw?: string): StagedAction[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as StagedAction[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Map persisted messages (user/assistant only) into renderable chat bubbles.
 * An assistant message with a non-empty `pending_action` rebuilds its confirmation
 * card (unresolved) so a reloaded conversation can still confirm/cancel the write.
 */
function toChatMessages(msgs: AiMessage[]): ChatMessage[] {
  return msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const staged = m.role === 'assistant' ? parseStagedActions(m.pending_action) : [];
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
        tools: m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [],
        confirm: staged.length > 0 ? { actions: staged, resolved: false } : undefined,
      };
    });
}

/** Derive a short conversation title from the first user message. */
function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

export default function AiAssistant() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { token } = antdTheme.useToken();
  const currentCluster = useCtxStore((s) => s.currentCluster);

  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConv, setActiveConv] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  // Guards for async callbacks that may fire after unmount / after a turn ends.
  const mountedRef = useRef(true);
  const streamingRef = useRef(false);
  // IME guard: true while an input-method composition is in progress (so Enter
  // that only confirms a Chinese candidate never sends the message).
  const composingRef = useRef(false);

  const fab = useDrag(FAB, FAB, 'ok-ai-fab-pos', () => ({
    x: window.innerWidth - FAB - 24,
    y: window.innerHeight - FAB - 28,
  }));
  const win = useDrag(WIN_W, WIN_H, 'ok-ai-win-pos', () => ({
    x: window.innerWidth - WIN_W - 24,
    y: window.innerHeight - WIN_H - 24,
  }));

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // ---- launcher readiness ----
  // Fetch once on mount, and re-fetch when the tab regains focus so that saving
  // the config on the settings page clears the ⚠️ without a full page reload
  // (this component lives in the persistent layout and never remounts).
  const refreshStatus = useCallback(
    () =>
      aiApi
        .status()
        .then((s) => {
          if (mountedRef.current) setReady(s.enabled && s.configured);
          return s.enabled && s.configured;
        })
        .catch(() => {
          if (mountedRef.current) setReady(false);
          return false;
        }),
    [],
  );

  useEffect(() => {
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshStatus]);

  const closeSocket = useCallback(() => {
    const ws = socketRef.current;
    socketRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeSocket();
    };
  }, [closeSocket]);

  // Changing cluster invalidates the current (cluster-scoped) session.
  useEffect(() => {
    closeSocket();
    setActiveConv(null);
    setMessages([]);
    setStreaming(false);
  }, [currentCluster, closeSocket]);

  // Load the conversation list whenever the panel opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    aiApi
      .listConversations()
      .then((list) => {
        if (active) setConversations(list);
      })
      .catch(() => {
        /* ignore — empty list is a fine fallback */
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages]);

  const onActivate = async () => {
    if (ready) {
      setOpen(true);
      return;
    }
    // Stale-state guard: our cached readiness may predate an admin just enabling
    // AI. Re-check before refusing, so a fresh config opens the panel immediately.
    if (await refreshStatus()) {
      setOpen(true);
    } else {
      message.warning(t('ai.notConfigured'));
    }
  };

  // ---- streaming helpers (functional updates so stale closures are safe) ----
  const updateLastAssistant = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    if (!mountedRef.current) return;
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const idx = prev.length - 1;
      if (prev[idx].role !== 'assistant') return prev;
      const copy = prev.slice();
      copy[idx] = fn(prev[idx]);
      return copy;
    });
  }, []);

  const handleFrame = useCallback(
    (raw: string) => {
      if (!mountedRef.current) return;
      let frame: AiChatEvent;
      try {
        frame = JSON.parse(raw) as AiChatEvent;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'token':
          updateLastAssistant((m) => ({ ...m, content: m.content + (frame.text ?? '') }));
          break;
        case 'tool_call':
          updateLastAssistant((m) => ({
            ...m,
            tools: [...m.tools, { tool: frame.tool ?? '', args: frame.args }],
          }));
          break;
        case 'tool_result':
          updateLastAssistant((m) => {
            const tools = m.tools.slice();
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].tool === frame.tool && tools[i].result === undefined) {
                tools[i] = { ...tools[i], result: frame.result };
                return { ...m, tools };
              }
            }
            return { ...m, tools: [...tools, { tool: frame.tool ?? '', result: frame.result }] };
          });
          break;
        case 'confirm_required':
          updateLastAssistant((m) => ({
            ...m,
            content: m.content || (frame.text ?? ''),
            confirm: { actions: frame.actions ?? [], resolved: false },
          }));
          break;
        case 'error':
          updateLastAssistant((m) => ({
            ...m,
            content: m.content ? `${m.content}\n\n${frame.text ?? ''}` : (frame.text ?? t('ai.error')),
          }));
          setStreaming(false);
          break;
        case 'done':
          setStreaming(false);
          break;
      }
    },
    [updateLastAssistant, t],
  );

  /** Ensure an OPEN socket for the current cluster, resolving once ready. */
  const ensureSocket = useCallback(
    (cluster: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const existing = socketRef.current;
        if (existing && existing.readyState === WebSocket.OPEN) {
          resolve(existing);
          return;
        }
        if (existing) {
          try {
            existing.close();
          } catch {
            /* ignore */
          }
        }
        const ws = new WebSocket(aiChatUrl(cluster));
        socketRef.current = ws;
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error('ws error'));
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') handleFrame(ev.data);
        };
        ws.onclose = () => {
          if (socketRef.current !== ws) return;
          socketRef.current = null;
          if (!mountedRef.current) return;
          if (streamingRef.current) {
            setStreaming(false);
            updateLastAssistant((m) => ({
              ...m,
              content: m.content ? `${m.content}\n\n${t('ai.disconnected')}` : t('ai.disconnected'),
            }));
          }
        };
      }),
    [handleFrame, updateLastAssistant, t],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !currentCluster) return;
    try {
      let convId = activeConv;
      if (!convId) {
        const conv = await aiApi.createConversation(currentCluster, titleFrom(text));
        convId = conv.id;
        setActiveConv(convId);
        aiApi.listConversations().then(setConversations).catch(() => {});
      }
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text, tools: [] },
        { role: 'assistant', content: '', tools: [] },
      ]);
      setStreaming(true);
      const ws = await ensureSocket(currentCluster);
      ws.send(JSON.stringify({ type: 'user_message', conversation_id: convId, text }));
      setInput('');
    } catch {
      setInput(text);
      setStreaming(false);
      message.error(t('ai.error'));
    }
  };

  const newChat = () => {
    closeSocket();
    setActiveConv(null);
    setMessages([]);
    setStreaming(false);
  };

  const selectConversation = async (id: number) => {
    if (id === activeConv) return;
    closeSocket();
    setStreaming(false);
    try {
      const { messages: msgs } = await aiApi.getConversation(id);
      setActiveConv(id);
      setMessages(toChatMessages(msgs));
    } catch {
      message.error(t('ai.error'));
    }
  };

  const resolveConfirm = useCallback(
    async (approved: boolean) => {
      if (!activeConv) return;
      updateLastAssistant((m) => (m.confirm ? { ...m, confirm: { ...m.confirm, resolved: true } } : m));
      const ws = socketRef.current;
      const payload = { type: 'confirm' as const, conversation_id: activeConv, approved };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return;
      }
      try {
        const events = await aiApi.confirmConversation(activeConv, approved);
        events.forEach((e) => handleFrame(JSON.stringify(e)));
      } catch {
        setStreaming(false);
        message.error(t('ai.error'));
      }
    },
    [activeConv, updateLastAssistant, handleFrame, message, t],
  );

  // A reloaded (or just-staged) conversation may hold an unresolved write card;
  // block new input until it's confirmed/cancelled — matching the live flow.
  const last = messages[messages.length - 1];
  const pendingConfirm = last?.role === 'assistant' && !!last.confirm && !last.confirm.resolved;
  const clusterConversations = currentCluster
    ? conversations.filter((c) => c.cluster_id === currentCluster)
    : [];
  const composerDisabled = !currentCluster || streaming || pendingConfirm;

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Skip the Enter that only commits an IME (Chinese/Japanese/…) candidate.
    const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
    if (composingRef.current || native.isComposing || native.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  // Theme-tracking CSS variables shared by the FAB and the window.
  const vars = {
    '--ok-ai-bg': token.colorBgElevated,
    '--ok-ai-canvas': token.colorBgLayout,
    '--ok-ai-bar': token.colorFillQuaternary,
    '--ok-ai-border': token.colorBorderSecondary,
    '--ok-ai-fg': token.colorText,
    '--ok-ai-muted': token.colorTextTertiary,
    '--ok-ai-warn-bg': token.colorWarningBg,
    '--ok-ai-warn-border': token.colorWarningBorderHover,
    '--ok-ai-warn-fg': token.colorWarningText,
  } as React.CSSProperties;

  return (
    <>
      {!open && (
        <Tooltip title="OmniKube" placement="left">
          <button
            aria-label="OmniKube assistant"
            className="ok-ai-fab"
            style={{ ...vars, left: fab.pos.x, top: fab.pos.y }}
            {...fab.handlers}
            onPointerUp={(e) => {
              fab.handlers.onPointerUp(e);
              if (!fab.movedRef.current) void onActivate();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void onActivate();
              }
            }}
          >
            <span className="ok-ai-fab__spark" />
            <RobotOutlined />
            {!ready && (
              <span className="ok-ai-fab__badge">
                <WarningFilled />
              </span>
            )}
          </button>
        </Tooltip>
      )}

      {open && (
        <div
          className="ok-ai-window"
          style={{ ...vars, left: win.pos.x, top: win.pos.y, width: WIN_W, height: WIN_H }}
        >
          {/* Header — drag handle (grip) + action buttons kept out of the grip. */}
          <div className="ok-ai-head">
            <div
              className="ok-ai-head__grip"
              style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}
              {...win.handlers}
            >
              <span className="ok-ai-head__avatar">
                <RobotOutlined />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="ok-ai-head__title">OmniKube</div>
                <div className="ok-ai-head__sub">
                  <span className="ok-ai-dot" style={{ background: currentCluster ? '#4ade80' : '#fbbf24' }} />
                  {currentCluster || t('ai.noCluster')}
                </div>
              </div>
            </div>
            <div className="ok-ai-head__btns">
              <Tooltip title={t('ai.newChat')}>
                <Button type="text" size="small" icon={<PlusOutlined />} onClick={newChat} />
              </Tooltip>
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setOpen(false)} />
            </div>
          </div>

          {/* Conversation switcher */}
          <div className="ok-ai-toolbar">
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder={t('ai.conversations')}
              value={activeConv ?? undefined}
              onChange={selectConversation}
              options={clusterConversations.map((c) => ({ value: c.id, label: c.title || `#${c.id}` }))}
              notFoundContent={t('ai.noConversations')}
            />
          </div>

          {/* Messages */}
          <div className="ok-ai-body">
            {messages.length === 0 ? (
              <div className="ok-ai-empty">
                <div className="ok-ai-empty__icon">
                  <ThunderboltFilled />
                </div>
                <div>{t('ai.emptyChat')}</div>
              </div>
            ) : (
              messages.map((m, i) => (
                <MessageBubble
                  key={i}
                  msg={m}
                  streaming={streaming && i === messages.length - 1}
                  onConfirm={(approved) => void resolveConfirm(approved)}
                />
              ))
            )}
            <div ref={listEndRef} />
          </div>

          {/* Composer */}
          <div className="ok-ai-composer">
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Input.TextArea
                autoSize={{ minRows: 1, maxRows: 5 }}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={currentCluster ? t('ai.askPlaceholder') : t('ai.selectClusterFirst')}
                disabled={composerDisabled}
                onCompositionStart={() => (composingRef.current = true)}
                onCompositionEnd={() => (composingRef.current = false)}
                onKeyDown={onComposerKeyDown}
                style={{ borderRadius: 12, resize: 'none' }}
              />
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined />}
                loading={streaming}
                disabled={composerDisabled || !input.trim()}
                onClick={() => void send()}
                aria-label={t('ai.send')}
              />
            </div>
            <div className="ok-ai-composer__hint">{t('ai.enterHint')}</div>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({
  msg,
  streaming,
  onConfirm,
}: {
  msg: ChatMessage;
  streaming: boolean;
  onConfirm?: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  const isUser = msg.role === 'user';
  const showThinking = !isUser && streaming && !msg.content && msg.tools.length === 0 && !msg.confirm;

  return (
    <div className={`ok-ai-row ${isUser ? 'ok-ai-row--user' : ''}`}>
      <span className={`ok-ai-ava ${isUser ? 'ok-ai-ava--user' : 'ok-ai-ava--ai'}`}>
        {isUser ? '🧑' : <RobotOutlined />}
      </span>
      <div className={`ok-ai-bubble ${isUser ? 'ok-ai-bubble--user' : 'ok-ai-bubble--ai'}`}>
        {msg.tools.length > 0 && (
          <Collapse
            size="small"
            ghost
            style={{ marginBottom: msg.content ? 6 : 0 }}
            items={[
              {
                key: 'tools',
                label: (
                  <Typography.Text style={{ fontSize: 12 }} type="secondary">
                    {t('ai.toolSteps')} · {msg.tools.length}
                  </Typography.Text>
                ),
                children: (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {msg.tools.map((step, i) => (
                      <div key={i}>
                        <Typography.Text strong style={{ fontSize: 12 }}>
                          {step.tool}
                        </Typography.Text>
                        {step.args && (
                          <pre style={preStyle}>
                            {t('ai.toolArgs')}: {step.args}
                          </pre>
                        )}
                        {step.result !== undefined && (
                          <pre style={preStyle}>
                            {t('ai.toolResult')}: {step.result}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        )}
        {showThinking ? (
          <span className="ok-ai-thinking">
            <span />
            <span />
            <span />
          </span>
        ) : (
          msg.content
        )}
        {msg.confirm && <ConfirmCard confirm={msg.confirm} onConfirm={onConfirm} />}
      </div>
    </div>
  );
}

/** Inline card listing the staged write actions with confirm/cancel buttons. */
function ConfirmCard({ confirm, onConfirm }: { confirm: PendingConfirm; onConfirm?: (approved: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="ok-ai-confirm">
      <div className="ok-ai-confirm__head">
        <WarningFilled />
        {t('ai.confirmTitle')}
      </div>
      <div className="ok-ai-confirm__body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {confirm.actions.map((a, i) => (
            <div key={i}>
              <div className="ok-ai-actline">
                <span className={`ok-ai-tag ok-ai-tag--${a.action}`}>{a.action}</span> {a.resource}
                {(a.namespace || a.name) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {' '}
                    {a.namespace ? `${a.namespace}/` : ''}
                    {a.name ?? ''}
                  </Typography.Text>
                )}
              </div>
              {a.manifest && (
                <Collapse
                  size="small"
                  ghost
                  items={[
                    {
                      key: 'manifest',
                      label: (
                        <Typography.Text style={{ fontSize: 12 }} type="secondary">
                          {t('ai.confirmManifest')}
                        </Typography.Text>
                      ),
                      children: <pre style={manifestPreStyle}>{JSON.stringify(a.manifest, null, 2)}</pre>,
                    },
                  ]}
                />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Button type="primary" size="small" disabled={confirm.resolved} onClick={() => onConfirm?.(true)}>
            {t('ai.confirmRun')}
          </Button>
          <Button size="small" disabled={confirm.resolved} onClick={() => onConfirm?.(false)}>
            {t('ai.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: '4px 0 0',
  padding: 6,
  background: 'rgba(127,127,127,0.12)',
  borderRadius: 6,
  fontSize: 11.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const manifestPreStyle: React.CSSProperties = {
  ...preStyle,
  maxHeight: 160,
  overflow: 'auto',
};
