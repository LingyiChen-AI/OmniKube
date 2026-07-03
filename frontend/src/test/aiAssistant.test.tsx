import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';

const statusMock = vi.fn();
const createConversationMock = vi.fn();
const listConversationsMock = vi.fn();
const getConversationMock = vi.fn();

vi.mock('../api/ai', () => ({
  aiApi: {
    status: () => statusMock(),
    createConversation: (clusterId: string, title: string) => createConversationMock(clusterId, title),
    listConversations: () => listConversationsMock(),
    getConversation: (id: number) => getConversationMock(id),
  },
}));

// Provide a current cluster so the composer is enabled.
vi.mock('../store/ctx', () => ({
  useCtxStore: (sel: (s: { currentCluster: string | null }) => unknown) => sel({ currentCluster: 'c1' }),
}));

// --- Minimal fake WebSocket the test can drive ---
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
  url: string;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

import AiAssistant from '../components/AiAssistant';

describe('AiAssistant launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConversationsMock.mockResolvedValue([]);
  });

  it('shows a warning state and message when AI is not configured', async () => {
    statusMock.mockResolvedValue({ enabled: false, configured: false });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiAssistant />);
    const btn = await screen.findByLabelText(/omnikube assistant/i);
    await user.click(btn);
    await waitFor(() =>
      expect(screen.getByText(/contact your administrator|请联系管理员开启/i)).toBeInTheDocument(),
    );
  });

  it('opens the panel when AI is enabled+configured', async () => {
    statusMock.mockResolvedValue({ enabled: true, configured: true });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiAssistant />);
    const btn = await screen.findByLabelText(/omnikube assistant/i);
    await user.click(btn);
    await waitFor(() => expect(screen.getByPlaceholderText(/ask omnikube|向 omnikube 提问/i)).toBeInTheDocument());
  });
});

describe('AiAssistant streaming chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    statusMock.mockResolvedValue({ enabled: true, configured: true });
    listConversationsMock.mockResolvedValue([]);
    createConversationMock.mockResolvedValue({ id: 42, cluster_id: 'c1', title: 'hi' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a conversation, opens the WS, and streams tokens into the panel', async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiAssistant />);

    await user.click(await screen.findByLabelText(/omnikube assistant/i));
    const box = await screen.findByPlaceholderText(/ask omnikube|向 omnikube 提问/i);

    await user.type(box, 'list pods');
    await user.click(screen.getByRole('button', { name: /send|发送/i }));

    // A conversation is created and the WS receives the user_message frame.
    await waitFor(() => expect(createConversationMock).toHaveBeenCalledWith('c1', 'list pods'));
    await waitFor(() => expect(FakeWebSocket.last).toBeTruthy());
    const ws = FakeWebSocket.last;
    await waitFor(() => expect(ws.sent.length).toBe(1));
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'user_message', conversation_id: 42, text: 'list pods' });

    // Stream token frames into the in-progress assistant bubble.
    act(() => {
      ws.emit({ type: 'token', text: 'Hello ' });
      ws.emit({ type: 'token', text: 'world' });
    });
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());

    // done re-enables the composer.
    act(() => ws.emit({ type: 'done', text: 'Hello world' }));
    await waitFor(() => expect(screen.getByPlaceholderText(/ask omnikube|向 omnikube 提问/i)).not.toBeDisabled());
  });
});
