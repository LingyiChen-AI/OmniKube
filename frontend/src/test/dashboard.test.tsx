import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderWithProviders } from './render';
import {
  countTodayReleases,
  isSameLocalDay,
  type ReleaseRecord,
} from '../api/release';

// ---- mocks --------------------------------------------------------------

vi.mock('../store/ctx', () => ({
  useCtxStore: () => ({ currentCluster: 'c1', currentNamespace: null }),
  getCurrentCluster: () => 'c1',
}));

vi.mock('../api/cluster', () => ({
  clusterApi: { list: vi.fn() },
}));

vi.mock('../api/release', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/release')>();
  return { ...actual, releaseApi: { list: vi.fn() } };
});

// Dashboard gates nodes (cluster-scoped) + events (admin-only) on permission.
// Render as an admin with full capabilities so those widgets are exercised.
vi.mock('../store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { is_admin: true } }),
}));
vi.mock('../store/caps', () => ({
  useCapabilities: () => ({ can: () => true, resources: {}, loading: false }),
}));

import { clusterApi } from '../api/cluster';
import { releaseApi } from '../api/release';
import { resourceApi } from '../api/resource';
import Dashboard from '../pages/dashboard/Dashboard';

function rec(id: number, created_at: string): ReleaseRecord {
  return {
    id,
    user_id: 1,
    username: 'alice',
    cluster_id: 'c1',
    namespace: 'dev',
    kind: 'Deployment',
    name: 'web',
    image_before: '',
    image_after: '',
    comment: '',
    created_at,
  };
}

describe('countTodayReleases', () => {
  it('counts only records created on the reference local day', () => {
    const ref = new Date('2026-06-29T10:00:00');
    const records = [
      rec(1, '2026-06-29T08:00:00'), // today
      rec(2, '2026-06-29T23:59:00'), // today
      rec(3, '2026-06-28T23:59:00'), // yesterday
      rec(4, '2026-06-30T00:01:00'), // tomorrow
      rec(5, 'not-a-date'), // invalid
    ];
    expect(countTodayReleases(records, ref)).toBe(2);
    expect(isSameLocalDay('2026-06-29T08:00:00', ref)).toBe(true);
    expect(isSameLocalDay('2026-06-28T08:00:00', ref)).toBe(false);
    expect(isSameLocalDay(undefined, ref)).toBe(false);
  });
});

describe('Dashboard', () => {
  beforeEach(() => {
    (clusterApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'c1', name: 'prod-us-east', status: 'Healthy' },
      { id: 'c2', name: 'staging', status: 'Unreachable' },
    ]);
    (releaseApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      rec(1, new Date().toISOString()),
    ]);
    vi.spyOn(resourceApi, 'list').mockImplementation((resource: string) => {
      if (resource === 'pods') {
        return Promise.resolve([
          { status: { phase: 'Running' } },
          { status: { phase: 'Running' } },
          { status: { phase: 'Pending' } },
        ]);
      }
      if (resource === 'deployments') return Promise.resolve([{}, {}, {}, {}]);
      if (resource === 'nodes') return Promise.resolve([{}, {}, {}]);
      if (resource === 'events') {
        return Promise.resolve([
          {
            metadata: { uid: 'e1' },
            type: 'Warning',
            reason: 'BackOff',
            message: 'Back-off restarting failed container',
            involvedObject: { kind: 'Pod', name: 'web-1', namespace: 'dev' },
            lastTimestamp: new Date().toISOString(),
          },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it('renders summary cards, cluster status and recent events with mocked APIs', async () => {
    renderWithProviders(<MemoryRouter><Dashboard /></MemoryRouter>);

    // Cluster count card (2 accessible clusters).
    expect(await screen.findByText('prod-us-east')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();

    // Running pods (2 of 3) and deployments (4) resolved.
    await waitFor(() => expect(screen.getByText('BackOff')).toBeInTheDocument());
    expect(screen.getByText(/Back-off restarting/)).toBeInTheDocument();
  });

  it('shows a friendly empty state when events are forbidden (403)', async () => {
    vi.spyOn(resourceApi, 'list').mockImplementation((resource: string) => {
      if (resource === 'events') return Promise.reject(new Error('403'));
      return Promise.resolve([]);
    });

    renderWithProviders(<MemoryRouter><Dashboard /></MemoryRouter>);
    // The recent-events panel degrades to the "no events / no access" message.
    expect(await screen.findByText(/no access permission|no events/i)).toBeInTheDocument();
  });
});
