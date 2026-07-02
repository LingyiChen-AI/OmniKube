import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './render';

vi.mock('../api/resource', () => ({
  resourceApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    namespaces: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../api/me', () => ({
  meApi: {
    capabilities: vi.fn(),
  },
}));

import ResourceTable from '../components/ResourceTable';
import { resourceApi } from '../api/resource';
import { meApi } from '../api/me';
import { useCtxStore } from '../store/ctx';
import { useCapsStore } from '../store/caps';

function renderTable() {
  return renderWithProviders(
    <ResourceTable title="Deployments" resource="deployments" />,
  );
}

describe('ResourceTable action gating + fixed columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resourceApi.list as any).mockResolvedValue([
      {
        metadata: {
          name: 'nginx',
          namespace: 'default',
          creationTimestamp: new Date().toISOString(),
        },
      },
    ]);
    useCtxStore.setState({ currentCluster: 'c1', currentNamespace: null });
    useCapsStore.setState({ resources: {}, loading: false, loadedKey: null, pendingKey: null });
  });

  it('shows edit and delete when capabilities include edit + delete', async () => {
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view', 'edit', 'delete'] });
    renderTable();

    await screen.findByText('nginx');
    await waitFor(() => expect(document.querySelector('[data-icon="edit"]')).toBeTruthy());
    expect(document.querySelector('[data-icon="delete"]')).toBeTruthy();
    expect(document.querySelector('[data-icon="eye"]')).toBeTruthy();

    // Fixed first column + fixed actions column are configured (numeric scroll.x).
    expect(document.querySelector('.ant-table-cell-fix-left')).toBeTruthy();
    expect(document.querySelector('.ant-table-cell-fix-right')).toBeTruthy();
  });

  it('view action opens EditResourceDrawer in read-only mode (visual tab, no save)', async () => {
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view', 'edit', 'delete'] });
    (resourceApi.get as any).mockResolvedValue({
      kind: 'Deployment',
      metadata: { name: 'nginx', namespace: 'default' },
      spec: { replicas: 1, template: { spec: { containers: [] } } },
    });
    renderTable();

    await screen.findByText('nginx');
    fireEvent.click(document.querySelector('[data-icon="eye"]')!.closest('button')!);

    // The dual editor opens with the read-only "View resource" title…
    await screen.findByText('View resource');
    // …exposes the (disabled) Visual tab…
    expect(screen.getByText('Visual')).toBeTruthy();
    // …and offers no Save button (read-only).
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('hides edit and delete when capabilities lack write + delete', async () => {
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view'] });
    renderTable();

    await screen.findByText('nginx');
    // The always-available view button confirms the action column rendered.
    await waitFor(() => expect(document.querySelector('[data-icon="eye"]')).toBeTruthy());
    // Let any capability-driven re-render settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('[data-icon="edit"]')).toBeNull();
    expect(document.querySelector('[data-icon="delete"]')).toBeNull();
  });

  it('hides the Create button when the user lacks the create capability', async () => {
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view'] });
    renderTable();

    await screen.findByText('nginx');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('shows a Create button with the create capability and POSTs a new resource', async () => {
    (meApi.capabilities as any).mockResolvedValue({ deployments: ['view', 'create'] });
    (resourceApi.create as any).mockResolvedValue({});
    renderTable();

    await screen.findByText('nginx');

    // The header Create button appears only with the create capability.
    const headerCreate = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(headerCreate);

    // The drawer opens in create mode (no GET, starts from a template).
    await screen.findByText('Create resource');
    expect(resourceApi.get).not.toHaveBeenCalled();

    // The footer Create button POSTs the templated manifest via create().
    const createButtons = screen.getAllByRole('button', { name: /create/i });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => expect(resourceApi.create).toHaveBeenCalled());
    const [ns, res, body] = (resourceApi.create as any).mock.calls[0];
    expect(ns).toBe('default');
    expect(res).toBe('deployments');
    expect(body.kind).toBe('Deployment');
  });
});
