import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';

vi.mock('../api/resource', () => ({
  resourceApi: {
    revealSecret: vi.fn(),
  },
}));

vi.mock('../api/me', () => ({
  meApi: {
    capabilities: vi.fn().mockResolvedValue({ secrets: ['view', 'reveal'] }),
  },
}));

import SecretDataView from '../components/SecretDataView';
import { resourceApi } from '../api/resource';
import { meApi } from '../api/me';
import { useCtxStore } from '../store/ctx';
import { useCapsStore } from '../store/caps';

describe('SecretDataView reveal toggles display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A cluster must be selected for capabilities to resolve; grant reveal.
    (meApi.capabilities as any).mockResolvedValue({ secrets: ['view', 'reveal'] });
    useCtxStore.setState({ currentCluster: 'c1', currentNamespace: null });
    useCapsStore.setState({ resources: {}, loading: false, loadedKey: null, pendingKey: null });
  });

  it('masks values by default and reveals/re-masks on toggle', async () => {
    const user = userEvent.setup();
    (resourceApi.revealSecret as any).mockResolvedValue({ data: { password: 's3cr3t' } });

    renderWithProviders(<SecretDataView namespace="default" name="db" keys={['password']} />);

    const cell = screen.getByTestId('secret-value-password');
    expect(cell.textContent).toBe('••••••••');
    expect(cell.textContent).not.toContain('s3cr3t');

    await user.click(await screen.findByRole('button', { name: /reveal values/i }));

    await waitFor(() => expect(screen.getByTestId('secret-value-password').textContent).toBe('s3cr3t'));
    expect(resourceApi.revealSecret).toHaveBeenCalledWith('default', 'db');

    // Toggle back to masked.
    await user.click(screen.getByRole('button', { name: /hide values/i }));
    expect(screen.getByTestId('secret-value-password').textContent).toBe('••••••••');
  });

  it('hides the reveal button when the user lacks the reveal capability', async () => {
    (meApi.capabilities as any).mockResolvedValue({ secrets: ['view'] });

    renderWithProviders(<SecretDataView namespace="default" name="db" keys={['password']} />);

    // Values stay masked and the reveal control never appears.
    expect(screen.getByTestId('secret-value-password').textContent).toBe('••••••••');
    await waitFor(() =>
      expect(useCapsStore.getState().resources).toEqual({ secrets: ['view'] }),
    );
    expect(screen.queryByRole('button', { name: /reveal values/i })).toBeNull();
  });
});
