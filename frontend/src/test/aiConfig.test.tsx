import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';
import { aiApi } from '../api/ai';

vi.mock('../api/ai', () => ({
  aiApi: {
    getConfig: vi.fn().mockResolvedValue({
      enabled: false, base_url: '', model_id: '', temperature: 0, system_prompt: '', max_steps: 0, has_key: false,
    }),
    putConfig: vi.fn().mockResolvedValue({}),
    getGrants: vi.fn().mockResolvedValue({}),
    putGrants: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../store/clusters', () => ({
  useClusterStore: () => ({ clusters: [{ id: 'c1', name: 'C1' }], loaded: true, load: vi.fn() }),
}));

import AiConfig from '../pages/ai/AiConfig';

describe('AiConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the model form fields', async () => {
    renderWithProviders(<AiConfig />);
    await waitFor(() => expect(screen.getByLabelText(/base ?url/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
  });

  it('saves the model config via putConfig', async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiConfig />);
    await waitFor(() => expect(screen.getByLabelText(/base ?url/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/base ?url/i), 'https://api.example.com/v1');
    await user.type(screen.getByLabelText(/model/i), 'gpt-4o-mini');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(aiApi.putConfig).toHaveBeenCalledTimes(1));
    expect(aiApi.putConfig).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: 'https://api.example.com/v1', model_id: 'gpt-4o-mini' }),
    );
  });

  it('loads grants when a cluster panel is expanded', async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AiConfig />);
    await waitFor(() => expect(screen.getByLabelText(/base ?url/i)).toBeInTheDocument());

    // Each cluster has its own collapsible panel; expanding one loads its grants.
    await user.click(screen.getByText('C1'));

    await waitFor(() => expect(aiApi.getGrants).toHaveBeenCalledWith('c1'));
  });
});
