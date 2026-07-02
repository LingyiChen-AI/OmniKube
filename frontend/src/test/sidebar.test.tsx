import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Providers } from './render';
import Sidebar from '../components/Sidebar';
import { useAuthStore } from '../store/auth';

function renderSidebar(path: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar collapsed={false} />
      </MemoryRouter>
    </Providers>,
  );
}

describe('Sidebar nav reorg', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 1, username: 'admin', is_admin: true, must_reset: false, nav: { submenus: [] }, global: {} },
    });
  });

  it('exposes Nodes as a top-level item and drops the "Cluster Resources" submenu', async () => {
    renderSidebar('/cluster/nodes');
    // Nodes is now a standalone top-level menu entry.
    expect(await screen.findByText('Nodes')).toBeTruthy();
    // The old parent submenu label is gone.
    expect(screen.queryByText('Cluster Resources')).toBeNull();
  });

  it('places PersistentVolumes inside the Storage submenu', async () => {
    // A /storage route auto-opens the Storage submenu, revealing its children.
    renderSidebar('/storage/persistentvolumes');
    expect(await screen.findByText('PersistentVolumes')).toBeTruthy();
    expect(screen.getByText('Storage')).toBeTruthy();
  });
});
