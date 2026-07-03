import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './render';

vi.mock('../store/ctx', () => ({
  useCtxStore: () => ({ currentCluster: 'c1', currentNamespace: null }),
  getCurrentCluster: () => 'c1',
}));
vi.mock('../store/caps', () => ({ useCapabilities: () => ({ can: () => true }) }));
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
});
