import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';

const statusMock = vi.fn();
vi.mock('../api/ai', () => ({ aiApi: { status: () => statusMock() } }));

import AiAssistant from '../components/AiAssistant';

describe('AiAssistant launcher', () => {
  beforeEach(() => vi.clearAllMocks());

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
