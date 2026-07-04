import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';

vi.mock('../api/cluster', () => ({
  clusterApi: {
    list: vi.fn(),
    listPaged: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

import Clusters from '../pages/clusters/Clusters';
import { clusterApi } from '../api/cluster';
import { useAuthStore } from '../store/auth';

describe('Clusters — test-connection gates submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: 1, username: 'admin', is_admin: true, must_reset: false, nav: { submenus: [] }, global: {} },
    });
    (clusterApi.list as any).mockResolvedValue([]);
    (clusterApi.listPaged as any).mockResolvedValue({ clusters: [], total: 0 });
  });

  it('disables Save until the connection test passes', async () => {
    const user = userEvent.setup();
    (clusterApi.test as any).mockResolvedValue({ ok: true, server_version: 'v1.29.0' });

    renderWithProviders(<Clusters />);

    await user.click(screen.getByRole('button', { name: /add cluster/i }));

    const saveBtn = await screen.findByRole('button', { name: /save cluster/i });
    expect(saveBtn).toBeDisabled();

    const kubeconfig = screen.getByPlaceholderText(/apiVersion/i);
    await user.type(kubeconfig, 'apiVersion: v1');

    // Still gated before testing.
    expect(saveBtn).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(saveBtn).toBeEnabled());
    expect(clusterApi.test).toHaveBeenCalled();
  });
});
