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
import { aiChatUrl, type AiChatEvent } from '../api/aiChat';
import { useCtxStore } from '../store/ctx';

interface ToolStep {
  tool: string;
  args?: string;
  result?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tools: ToolStep[];
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

/** Map persisted messages (user/assistant only) into renderable chat bubbles. */
function toChatMessages(msgs: AiMessage[]): ChatMessage[] {
  return msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      tools: m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [],
    }));
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

  // ---- launcher readiness (Phase-1 behaviour, unchanged) ----
  useEffect(() => {
    let active = true;
    aiApi
      .status()
      .then((s) => {
        if (active) setReady(s.enabled && s.configured);
      })
      .catch(() => {
        if (active) setReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

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

  // Tear the socket down on unmount.
  useEffect(() => () => closeSocket(), [closeSocket]);

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

  const onClickLauncher = () => {
    if (!ready) {
      message.warning(t('ai.notConfigured'));
      return;
    }
    setOpen(true);
  };

  // ---- streaming helpers (functional updates so stale closures are safe) ----
  const updateLastAssistant = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
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
          if (socketRef.current === ws) socketRef.current = null;
        };
      }),
    [handleFrame],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !currentCluster) return;
    setInput('');
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
    } catch {
      setStreaming(false);
      updateLastAssistant((m) => ({ ...m, content: m.content || t('ai.error') }));
      message.error(t('ai.error'));
    }
  };

  const newChat = () => {
    setActiveConv(null);
    setMessages([]);
    setStreaming(false);
  };

  const selectConversation = async (id: number) => {
    if (id === activeConv) return;
    try {
      const { messages: msgs } = await aiApi.getConversation(id);
      setActiveConv(id);
      setMessages(toChatMessages(msgs));
      setStreaming(false);
    } catch {
      message.error(t('ai.error'));
    }
  };

  const composerDisabled = !currentCluster || streaming;

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
              onClick={onClickLauncher}
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
              options={conversations.map((c) => ({ value: c.id, label: c.title || `#${c.id}` }))}
              notFoundContent={t('ai.noConversations')}
            />
          </Space.Compact>

          <div style={{ flex: 1, overflow: 'auto' }}>
            {messages.length === 0 ? (
              <Empty description={t('ai.emptyChat')} />
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {messages.map((m, i) => (
                  <MessageBubble key={i} msg={m} streaming={streaming && i === messages.length - 1} />
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

function MessageBubble({ msg, streaming }: { msg: ChatMessage; streaming: boolean }) {
  const { t } = useTranslation();
  const isUser = msg.role === 'user';
  const showThinking = !isUser && streaming && !msg.content && msg.tools.length === 0;

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
      </div>
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
