import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Collapse, Empty, Input, Popover, Tooltip, Typography, theme as antdTheme } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  CaretRightOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CodeOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SendOutlined,
  ThunderboltFilled,
  WarningFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { aiApi, type AiConversation, type AiMessage } from '../api/ai';
import { aiChatUrl, type AiChatEvent, type StagedAction } from '../api/aiChat';
import { useCtxStore } from '../store/ctx';
import BrandMark from './BrandMark';

interface ToolStep {
  tool: string;
  args?: string;
  result?: string;
}

/** Pending write actions awaiting the user's confirmation, attached to an assistant bubble. */
interface PendingConfirm {
  actions: StagedAction[];
  resolved: boolean; // true once the user clicked confirm/cancel (disables the buttons)
  running?: boolean; // true while the confirmed action executes (shows a spinner)
  result?: string; // execution outcome text, streamed into THIS card (not a new bubble)
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tools: ToolStep[];
  confirm?: PendingConfirm;
}

// Preferred window size; clamped to the viewport at render for small screens.
const WIN_PREF_W = 460;
const WIN_PREF_H = 720;
const FAB = 56;
// The assistant's own popups (conversation dropdown, header tooltips) must sit
// ABOVE the floating window; AntD's default popup z-index (1050) is below it.
const WIN_Z = 1201;
const POPUP_Z = WIN_Z + 40;

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

/**
 * Parse the persisted tool trace into UI steps. Current format is `[]ToolTrace`
 * (`{tool,args,result}`); older rows used eino's `[]ToolCall`
 * (`{function:{name,arguments}}`) — both are handled for backward compatibility.
 */
function parseToolCalls(raw: string): ToolStep[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((tc: { tool?: string; args?: string; result?: string; function?: { name?: string; arguments?: string } }) =>
      tc.function
        ? { tool: tc.function.name ?? '', args: tc.function.arguments }
        : { tool: tc.tool ?? '', args: tc.args, result: tc.result },
    );
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

/** Parse the persisted `confirm_result` JSON into a card outcome, if present. */
function parseConfirmOutcome(raw?: string): { status: string; text: string } | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { status?: string; text?: string };
    if (!o.status) return undefined;
    return { status: o.status, text: o.text ?? '' };
  } catch {
    return undefined;
  }
}

/**
 * Map persisted messages (user/assistant only) into renderable chat bubbles.
 * An assistant message with a `pending_action` rebuilds its confirmation card:
 * still awaiting → active buttons; resolved (`confirm_result` set) → the resolved
 * card with the executed outcome, so reload matches the live experience.
 */
function toChatMessages(msgs: AiMessage[]): ChatMessage[] {
  return msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const staged = m.role === 'assistant' ? parseStagedActions(m.pending_action) : [];
      let confirm: PendingConfirm | undefined;
      if (staged.length > 0) {
        const outcome = parseConfirmOutcome(m.confirm_result);
        confirm = outcome
          ? {
              actions: staged,
              resolved: true,
              running: outcome.status === 'running',
              result: outcome.status === 'running' ? '' : outcome.text,
            }
          : { actions: staged, resolved: false };
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
        tools: m.role === 'assistant' ? parseToolCalls(m.tool_calls) : [],
        confirm,
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
  const [modelName, setModelName] = useState('');
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeConv, setActiveConv] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TextAreaRef>(null);
  // Guards for async callbacks that may fire after unmount / after a turn ends.
  const mountedRef = useRef(true);
  const streamingRef = useRef(false);
  // IME guard: true while an input-method composition is in progress (so Enter
  // that only confirms a Chinese candidate never sends the message).
  const composingRef = useRef(false);

  // Track the viewport so the window stays sized to fit on resize / small screens.
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const winW = Math.min(WIN_PREF_W, vp.w - 24);
  const winH = Math.min(WIN_PREF_H, vp.h - 24);

  const fab = useDrag(FAB, FAB, 'ok-ai-fab-pos', () => ({
    x: window.innerWidth - FAB - 24,
    y: window.innerHeight - FAB - 28,
  }));
  const win = useDrag(winW, winH, 'ok-ai-win-pos', () => ({
    x: window.innerWidth - winW - 24,
    y: window.innerHeight - winH - 24,
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
          if (mountedRef.current) {
            setReady(s.enabled && s.configured);
            setModelName(s.model ?? '');
          }
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
          updateLastAssistant((m) =>
            // While a confirmed write is executing, stream the outcome text into
            // the confirm card (same bubble) rather than the message body.
            m.confirm?.resolved
              ? { ...m, confirm: { ...m.confirm, result: (m.confirm.result ?? '') + (frame.text ?? '') } }
              : { ...m, content: m.content + (frame.text ?? '') },
          );
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
          // The turn is paused waiting for the user — stop the streaming spinner;
          // the composer stays disabled via pendingConfirm until they resolve it.
          updateLastAssistant((m) => ({
            ...m,
            content: m.content || (frame.text ?? ''),
            confirm: { actions: frame.actions ?? [], resolved: false },
          }));
          setStreaming(false);
          break;
        case 'error':
          updateLastAssistant((m) => ({
            ...m,
            content: m.content ? `${m.content}\n\n${frame.text ?? ''}` : (frame.text ?? t('ai.error')),
          }));
          setStreaming(false);
          break;
        case 'done':
          updateLastAssistant((m) => (m.confirm?.running ? { ...m, confirm: { ...m.confirm, running: false } } : m));
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
      // Mark the card resolved + running; the execution outcome streams as text
      // INTO this same card (see handleFrame 'token'), not a separate bubble.
      updateLastAssistant((m) =>
        m.confirm ? { ...m, confirm: { ...m.confirm, resolved: true, running: true, result: '' } } : m,
      );
      setStreaming(true);
      const payload = { type: 'confirm' as const, conversation_id: activeConv, approved };
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return;
      }
      // Socket dropped — replay via REST and render the returned events locally.
      try {
        const events = await aiApi.confirmConversation(activeConv, approved);
        events.forEach((e) => handleFrame(JSON.stringify(e)));
      } catch {
        setStreaming(false);
        message.error(t('ai.error'));
      }
    },
    [activeConv, handleFrame, updateLastAssistant, message, t],
  );

  // A reloaded (or just-staged) conversation may hold an unresolved write card;
  // block new input until it's confirmed/cancelled — matching the live flow.
  const last = messages[messages.length - 1];
  const pendingConfirm = last?.role === 'assistant' && !!last.confirm && !last.confirm.resolved;
  const clusterConversations = currentCluster
    ? conversations.filter((c) => c.cluster_id === currentCluster)
    : [];
  const composerDisabled = !currentCluster || streaming || pendingConfirm;

  // Auto-focus the composer whenever it becomes usable — on open and, crucially,
  // right after a turn finishes streaming — so the user can immediately type again.
  useEffect(() => {
    if (open && !composerDisabled) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, composerDisabled]);

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
            <BrandMark size="58%" />
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
          style={{ ...vars, left: win.pos.x, top: win.pos.y, width: winW, height: winH, zIndex: WIN_Z }}
        >
          {/* Header — drag handle (grip) + action buttons kept out of the grip. */}
          <div className="ok-ai-head">
            <div
              className="ok-ai-head__grip"
              style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}
              {...win.handlers}
            >
              <span className="ok-ai-head__avatar">
                <BrandMark size="66%" />
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
              <Popover
                open={historyOpen}
                onOpenChange={setHistoryOpen}
                trigger="click"
                placement="bottomRight"
                zIndex={POPUP_Z}
                styles={{ body: { padding: 0 } }}
                content={
                  <HistoryList
                    conversations={clusterConversations}
                    activeConv={activeConv}
                    onPick={(id) => {
                      setHistoryOpen(false);
                      void selectConversation(id);
                    }}
                  />
                }
              >
                <Tooltip title={t('ai.history')} zIndex={POPUP_Z}>
                  <Button type="text" size="small" aria-label={t('ai.history')} icon={<HistoryOutlined />} />
                </Tooltip>
              </Popover>
              <Tooltip title={t('ai.newChat')} zIndex={POPUP_Z}>
                <Button type="text" size="small" aria-label={t('ai.newChat')} icon={<PlusOutlined />} onClick={newChat} />
              </Tooltip>
              <Button
                type="text"
                size="small"
                aria-label={t('common.close')}
                icon={<CloseOutlined />}
                onClick={() => setOpen(false)}
              />
            </div>
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

          {/* Composer — a single rounded card: borderless textarea + footer bar. */}
          <div className="ok-ai-composer">
            <div className={`ok-ai-inputbox${composerDisabled ? ' is-disabled' : ''}`}>
              <Input.TextArea
                ref={inputRef}
                variant="borderless"
                autoSize={{ minRows: 1, maxRows: 6 }}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={currentCluster ? t('ai.askPlaceholder') : t('ai.selectClusterFirst')}
                disabled={composerDisabled}
                onCompositionStart={() => (composingRef.current = true)}
                onCompositionEnd={() => (composingRef.current = false)}
                onKeyDown={onComposerKeyDown}
                style={{ resize: 'none', padding: '2px 4px' }}
              />
              <div className="ok-ai-inputbar">
                <span className="ok-ai-inputchip" title={modelName || undefined}>
                  <span className="ok-ai-dot" style={{ background: ready ? '#22c55e' : '#f59e0b' }} />
                  {modelName || t('ai.noModel')}
                </span>
                <Tooltip title={t('ai.enterHint')}>
                  <Button
                    type="primary"
                    shape="circle"
                    icon={<SendOutlined />}
                    loading={streaming}
                    disabled={composerDisabled || !input.trim()}
                    onClick={() => void send()}
                    aria-label={t('ai.send')}
                  />
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Format an ISO timestamp as "YYYY/M/D · HH:mm" for the history list. */
function formatConvTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} · ${hh}:${mm}`;
}

/** The history popover body: past conversations for the current cluster. */
function HistoryList({
  conversations,
  activeConv,
  onPick,
}: {
  conversations: AiConversation[];
  activeConv: number | null;
  onPick: (id: number) => void;
}) {
  const { t } = useTranslation();
  if (conversations.length === 0) {
    return (
      <div className="ok-ai-history">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ai.noConversations')} />
      </div>
    );
  }
  return (
    <div className="ok-ai-history">
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`ok-ai-histitem ${c.id === activeConv ? 'is-active' : ''}`}
          onClick={() => onPick(c.id)}
        >
          <MessageIcon />
          <div className="ok-ai-histmain">
            <div className="ok-ai-histtitle">{c.title || t('ai.newChat')}</div>
            <div className="ok-ai-histtime">{formatConvTime(c.created_at)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function MessageIcon() {
  return (
    <span className="ok-ai-histicon" aria-hidden>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** One collapsible row (a tool call OR its result) inside a tool step. */
function ToolRow({
  icon,
  label,
  body,
  status,
  defaultOpen,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  body?: string;
  status?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasBody = body !== undefined && body !== '';
  return (
    <div className="ok-ai-toolstep">
      <button
        type="button"
        className="ok-ai-toolhead"
        onClick={() => hasBody && setOpen((o) => !o)}
        style={{ cursor: hasBody ? 'pointer' : 'default' }}
      >
        <CaretRightOutlined className="ok-ai-toolchev" rotate={open ? 90 : 0} style={{ opacity: hasBody ? 1 : 0.25 }} />
        <span className="ok-ai-toolicon">{icon}</span>
        <span className="ok-ai-toollabel">{label}</span>
        {status && <span className="ok-ai-toolstatus">{status}</span>}
      </button>
      {open && hasBody && <pre className="ok-ai-toolbody">{prettyJson(body)}</pre>}
    </div>
  );
}

/** A tool step: the "调用: <tool>" row and the "执行结果" row (with a done check). */
function ToolStepCard({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  const done = step.result !== undefined;
  return (
    <div className="ok-ai-toolcard">
      <ToolRow
        icon={<CodeOutlined />}
        label={
          <>
            {t('ai.toolCall')}: <b>{step.tool}</b>
          </>
        }
        body={step.args}
      />
      <ToolRow
        icon={<PlayCircleOutlined />}
        label={t('ai.toolResult')}
        body={step.result}
        status={
          done ? (
            <CheckCircleFilled style={{ color: '#22c55e' }} />
          ) : (
            <span className="ok-ai-toolspin">…</span>
          )
        }
      />
    </div>
  );
}

/** Pretty-print a JSON string; fall back to the raw text when it isn't JSON. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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
  const isUser = msg.role === 'user';
  const showThinking = !isUser && streaming && !msg.content && msg.tools.length === 0 && !msg.confirm;

  return (
    <div className={`ok-ai-row ${isUser ? 'ok-ai-row--user' : ''}`}>
      <span className={`ok-ai-ava ${isUser ? 'ok-ai-ava--user' : 'ok-ai-ava--ai'}`}>
        {isUser ? '🧑' : <BrandMark size="64%" />}
      </span>
      <div className={`ok-ai-bubble ${isUser ? 'ok-ai-bubble--user' : 'ok-ai-bubble--ai'}`}>
        {msg.tools.length > 0 && (
          <div className="ok-ai-tools">
            {msg.tools.map((step, i) => (
              <ToolStepCard key={i} step={step} />
            ))}
          </div>
        )}
        {showThinking ? (
          <span className="ok-ai-thinking">
            <span />
            <span />
            <span />
          </span>
        ) : isUser ? (
          msg.content
        ) : (
          <div className="ok-ai-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Open links in a new tab; never let the model navigate the app.
                a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
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
        {!confirm.resolved && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button type="primary" size="small" onClick={() => onConfirm?.(true)}>
              {t('ai.confirmRun')}
            </Button>
            <Button size="small" onClick={() => onConfirm?.(false)}>
              {t('ai.cancel')}
            </Button>
          </div>
        )}
        {/* Execution outcome streams into the card itself (proper ReAct: the new
            state as text, not a tool-call trace). */}
        {confirm.resolved && (
          <div className="ok-ai-confirm__result">
            {confirm.running && !confirm.result ? (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                <span className="ok-ai-thinking" style={{ marginRight: 6 }}>
                  <span />
                  <span />
                  <span />
                </span>
                {t('ai.executing')}
              </Typography.Text>
            ) : (
              <div className="ok-ai-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{confirm.result || t('ai.done')}</ReactMarkdown>
              </div>
            )}
          </div>
        )}
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
