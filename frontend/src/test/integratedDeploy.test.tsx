import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Providers } from './render';

vi.mock('../api/integratedDeploy', () => ({
  DEPLOY_KIND_GROUP: {},
  DEPLOY_KINDS: [],
  orderedItems: (x: unknown) => x,
  integratedDeployApi: {
    list: vi.fn().mockResolvedValue([
      { id: 1, title: '工单A', cluster_id: 'test', namespace: 'default', status: 'draft', username: 'admin', updated_at: '2026-07-04' },
    ]),
    copy: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../store/auth', () => ({
  useAuthStore: (sel: (s: { user: unknown }) => unknown) =>
    sel({ user: { id: 1, username: 'admin', is_admin: true } }),
}));

import IntegratedDeploy from '../pages/integratedDeploy/IntegratedDeploy';

function renderPage() {
  return render(
    <Providers>
      <MemoryRouter>
        <IntegratedDeploy />
      </MemoryRouter>
    </Providers>,
  );
}

describe('IntegratedDeploy list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders orders from the api', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('工单A')).toBeInTheDocument());
    expect(screen.getByText('default')).toBeInTheDocument();
  });
});
