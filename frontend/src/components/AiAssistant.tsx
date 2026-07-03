import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Collapse,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, RobotOutlined, SendOutlined, WarningOutlined } from '@ant-design/icons';
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

  // Mirror `streaming` into a ref so socket callbacks (stale closures) can read it.
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

  // Tear the socket down on unmount and stop late setState from callbacks.
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

  // Keep the message list scrolled to the newest content.
  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages]);

  const onClickLauncher = async () => {
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
            // Attach to the most recent matching call still awaiting a result.
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
          // Staged write actions need confirmation: attach a card to the current
          // bubble but keep `streaming` true so the composer stays disabled until
          // the user resolves it (confirm/cancel then drives the follow-up frames).
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
          // Only an *unexpected* drop reaches here still owning socketRef; an
          // intentional teardown (closeSocket / supersede) nulls/replaces it first.
          if (socketRef.current !== ws) return;
          socketRef.current = null;
          if (!mountedRef.current) return;
          // Mid-stream drop: re-enable the composer and note it on the last bubble.
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
        // Refresh the list so the new conversation shows up (best-effort).
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
      // The turn is under way — only now is it safe to clear the composer.
      setInput('');
    } catch {
      // Pre-stream failure (createConversation / ensureSocket reject): restore the
      // typed text and re-enable the composer so the user can retry.
      setInput(text);
      setStreaming(false);
      message.error(t('ai.error'));
    }
  };

  const newChat = () => {
    // Drop any in-flight socket so stale frames can't leak into the fresh chat.
    closeSocket();
    setActiveConv(null);
    setMessages([]);
    setStreaming(false);
  };

  const selectConversation = async (id: number) => {
    if (id === activeConv) return;
    // Close first: in-flight frames for the old conversation must not append onto
    // the history we are about to load.
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

  // Resolve the pending confirmation card: mark it resolved (disables its buttons),
  // then send `{type:"confirm", ...}` over the socket, falling back to the REST
  // endpoint (whose replayed Events we feed through the same frame handler) when the
  // socket is not open. Subsequent tool_result/done frames re-enable the composer.
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
      // Socket dropped — replay via REST and render the returned Events locally.
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
  // block new input until it's confirmed/cancelled — matching the live flow where
  // `confirm_required` keeps `streaming` true.
  const last = messages[messages.length - 1];
  const pendingConfirm = last?.role === 'assistant' && !!last.confirm && !last.confirm.resolved;

  // Sessions are cluster-scoped: only offer conversations belonging to the selected
  // cluster so we never send into a conversation created for a different cluster.
  const clusterConversations = currentCluster
    ? conversations.filter((c) => c.cluster_id === currentCluster)
    : [];

  const composerDisabled = !currentCluster || streaming || pendingConfirm;

  return (
    <>
      {/* Fixed wrapper so nothing (Badge/Tooltip spans) leaks into normal flow
          and adds page height — that caused a white strip under the layout. */}
      <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1000 }}>
        <Tooltip title="OmniKube" placement="left">
          <Badge count={ready ? 0 : <WarningOutlined style={{ color: '#F59E0B' }} />} offset={[-4, 4]}>
            <Button
              aria-label="OmniKube assistant"
              type="primary"
              shape="circle"
              size="large"
              icon={<RobotOutlined />}
              onClick={() => void onClickLauncher()}
            />
          </Badge>
        </Tooltip>
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} width="min(480px, 92vw)" title="OmniKube">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Button icon={<PlusOutlined />} onClick={newChat}>
              {t('ai.newChat')}
            </Button>
            <Select
              style={{ flex: 1 }}
              placeholder={t('ai.conversations')}
              value={activeConv ?? undefined}
              onChange={selectConversation}
              options={clusterConversations.map((c) => ({ value: c.id, label: c.title || `#${c.id}` }))}
              notFoundContent={t('ai.noConversations')}
            />
          </Space.Compact>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {messages.length === 0 ? (
              <Empty description={t('ai.emptyChat')} />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {messages.map((m, i) => (
                  <MessageBubble
                    key={i}
                    msg={m}
                    streaming={streaming && i === messages.length - 1}
                    onConfirm={(approved) => void resolveConfirm(approved)}
                  />
                ))}
                <div ref={listEndRef} />
              </Space>
            )}
          </div>

          {!currentCluster && <Alert type="info" showIcon message={t('ai.selectClusterFirst')} />}

          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('ai.askPlaceholder')}
              disabled={composerDisabled}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={streaming}
              disabled={composerDisabled || !input.trim()}
              onClick={() => void send()}
            >
              {t('ai.send')}
            </Button>
          </Space.Compact>
        </div>
      </Drawer>
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
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: 8,
          background: isUser ? '#0EA5E9' : '#F1F5F9',
          color: isUser ? '#fff' : 'inherit',
        }}
      >
        {msg.tools.length > 0 && (
          <Collapse
            size="small"
            style={{ marginBottom: msg.content ? 8 : 0, background: 'transparent' }}
            items={[
              {
                key: 'tools',
                label: `${t('ai.toolSteps')} (${msg.tools.length})`,
                children: (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {msg.tools.map((step, i) => (
                      <div key={i}>
                        <Typography.Text strong>{step.tool}</Typography.Text>
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
                  </Space>
                ),
              },
            ]}
          />
        )}
        {showThinking ? (
          <Space>
            <Spin size="small" />
            <Typography.Text type="secondary">{t('ai.thinking')}</Typography.Text>
          </Space>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>
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
    <div
      style={{
        marginTop: 8,
        padding: '8px 10px',
        borderRadius: 6,
        background: '#fff',
        border: '1px solid #FDE68A',
      }}
    >
      <Typography.Text strong>{t('ai.confirmTitle')}</Typography.Text>
      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
        {confirm.actions.map((a, i) => (
          <div key={i}>
            <Typography.Text>
              {t('ai.willExecute')} <Typography.Text code>{a.action}</Typography.Text> {a.resource}
              {(a.namespace || a.name) && ` ${a.namespace ? `${a.namespace}/` : ''}${a.name ?? ''}`}
            </Typography.Text>
            {a.manifest && (
              <Collapse
                size="small"
                style={{ marginTop: 4, background: 'transparent' }}
                items={[
                  {
                    key: 'manifest',
                    label: t('ai.confirmManifest'),
                    children: <pre style={manifestPreStyle}>{JSON.stringify(a.manifest, null, 2)}</pre>,
                  },
                ]}
              />
            )}
          </div>
        ))}
      </Space>
      <Space style={{ marginTop: 8 }}>
        <Button type="primary" size="small" disabled={confirm.resolved} onClick={() => onConfirm?.(true)}>
          {t('ai.confirmRun')}
        </Button>
        <Button size="small" disabled={confirm.resolved} onClick={() => onConfirm?.(false)}>
          {t('ai.cancel')}
        </Button>
      </Space>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: '4px 0 0',
  padding: 6,
  background: 'rgba(0,0,0,0.05)',
  borderRadius: 4,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

// Manifest preview: compact and scrollable so a large object can't blow out the card.
const manifestPreStyle: React.CSSProperties = {
  ...preStyle,
  maxHeight: 160,
  overflow: 'auto',
};
