import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderWithProviders, Providers } from './render';
import {
  actionAppliesToResource,
  actionsForResource,
  cleanOperations,
  cleanGlobalPerms,
  operationsToCheckedKeys,
  checkedKeysToOperations,
  globalPermsToCheckedKeys,
  checkedKeysToGlobalPerms,
  type RoleView,
  type Operations,
  type GlobalPerms,
} from '../api/role';
import Roles, { RuleBuilder, cloneRuleConfig, type RuleDraft } from '../pages/roles/Roles';
import Sidebar from '../components/Sidebar';
import { useAuthStore } from '../store/auth';

vi.mock('../api/resource', () => ({
  resourceApi: { namespaces: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../store/clusters', () => ({
  useClusterStore: () => ({ clusters: [], load: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('../api/role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/role')>();
  return {
    ...actual,
    roleApi: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  };
});

import { roleApi } from '../api/role';

const ADMIN = { id: 1, username: 'admin', is_admin: true, must_reset: false, nav: { submenus: [] }, global: {} };

// ---------------------------------------------------------------------------
// Pure model helpers
// ---------------------------------------------------------------------------

describe('per-resource action applicability', () => {
  it('gates exec to pods and reveal to secrets', () => {
    expect(actionAppliesToResource('pods', 'exec')).toBe(true);
    expect(actionAppliesToResource('deployments', 'exec')).toBe(false);
    expect(actionAppliesToResource('secrets', 'reveal')).toBe(true);
    expect(actionAppliesToResource('configmaps', 'reveal')).toBe(false);
    expect(actionsForResource('pods')).toEqual(['view', 'create', 'edit', 'delete', 'exec']);
    expect(actionsForResource('secrets')).toEqual(['view', 'create', 'edit', 'delete', 'reveal']);
    expect(actionsForResource('deployments')).toEqual(['view', 'create', 'edit', 'delete']);
  });

  it('cleanOperations drops empty resources and inapplicable actions', () => {
    expect(
      cleanOperations({ deployments: ['view', 'exec'], pods: [], secrets: ['view', 'reveal'] }),
    ).toEqual({ deployments: ['view'], secrets: ['view', 'reveal'] });
  });
});

describe('operations <-> checked-keys round trip (hierarchical tree)', () => {
  it('maps operations to leaf keys and back', () => {
    const ops: Operations = { pods: ['view', 'exec'], secrets: ['view', 'reveal'] };
    const keys = operationsToCheckedKeys(ops);
    expect(keys).toContain('a:pods:exec');
    expect(keys).toContain('a:secrets:reveal');
    expect(checkedKeysToOperations(keys)).toEqual({ pods: ['view', 'exec'], secrets: ['view', 'reveal'] });
  });

  it('ignores structural (module/resource) keys and keeps only leaves', () => {
    expect(checkedKeysToOperations(['m:workloads', 'r:pods', 'a:pods:view'])).toEqual({ pods: ['view'] });
  });

  it('clears descendants: unchecking a parent leaves no child leaf keys', () => {
    // Simulate AntD removing the module + its leaves on uncheck → only siblings remain.
    const after = checkedKeysToOperations(['a:services:view']);
    expect(after).toEqual({ services: ['view'] });
    // Nothing from the unchecked workloads module survives.
    expect(Object.keys(after)).not.toContain('pods');
  });
});

describe('global perms <-> checked-keys', () => {
  it('round-trips system-management + releases perms', () => {
    const gp: GlobalPerms = { clusters: ['view', 'create'], releases: ['view'] };
    const keys = globalPermsToCheckedKeys(gp);
    expect(keys).toContain('gp:clusters:create');
    expect(keys).toContain('gp:releases:view');
    expect(checkedKeysToGlobalPerms(keys)).toEqual({ clusters: ['view', 'create'], releases: ['view'] });
  });

  it('cleanGlobalPerms drops actions not applicable to releases', () => {
    expect(cleanGlobalPerms({ releases: ['view', 'delete'] })).toEqual({ releases: ['view'] });
  });
});

describe('cloneRuleConfig (one-click reuse of first cluster)', () => {
  it('deep-clones scope/namespaces/operations onto a cluster-less card', () => {
    const src: RuleDraft = {
      cluster_id: 'c1',
      scope: 'namespace',
      namespaces: ['dev'],
      operations: { pods: ['view', 'exec'] },
    };
    const copy = cloneRuleConfig(src);
    expect(copy.cluster_id).toBe('');
    expect(copy.scope).toBe('namespace');
    expect(copy.namespaces).toEqual(['dev']);
    expect(copy.operations).toEqual({ pods: ['view', 'exec'] });
    // Mutating the copy must not affect the source.
    copy.namespaces.push('prod');
    copy.operations.pods.push('delete');
    expect(src.namespaces).toEqual(['dev']);
    expect(src.operations.pods).toEqual(['view', 'exec']);
  });
});

// ---------------------------------------------------------------------------
// RuleBuilder — add + reuse-first interactions
// ---------------------------------------------------------------------------

function RuleHarness() {
  const [value, setValue] = useState<RuleDraft[]>([
    { cluster_id: 'c1', scope: 'cluster', namespaces: [], operations: { pods: ['view'] } },
  ]);
  return <RuleBuilder value={value} onChange={setValue} clusters={[{ id: 'c1', name: 'C1', status: 'Healthy' }]} />;
}

describe('RuleBuilder', () => {
  it('reuses the first cluster config into a new card', async () => {
    renderWithProviders(<RuleHarness />);
    expect(await screen.findByText('Cluster rule #1')).toBeInTheDocument();
    expect(screen.queryByText('Cluster rule #2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /reuse first cluster config/i }));
    expect(await screen.findByText('Cluster rule #2')).toBeInTheDocument();
  });

  it('adds an empty cluster card', async () => {
    renderWithProviders(<RuleHarness />);
    fireEvent.click(screen.getByRole('button', { name: /add cluster/i }));
    expect(await screen.findByText('Cluster rule #2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Roles table — system roles read-only
// ---------------------------------------------------------------------------

const SYSTEM_ROLE: RoleView = {
  id: 1,
  name: 'Cluster-Admin',
  description: 'built in',
  system: true,
  global_perms: { clusters: ['view', 'create', 'edit', 'delete'], releases: ['view'] },
  rules: [
    { cluster_id: '*', scope: 'cluster', namespaces: [], operations: { deployments: ['view'], pods: ['view'] } },
  ],
  user_count: 2,
};
const CUSTOM_ROLE: RoleView = {
  id: 2,
  name: 'Team Ops',
  description: '',
  system: false,
  global_perms: { releases: ['view'] },
  rules: [{ cluster_id: 'c1', scope: 'cluster', namespaces: [], operations: { deployments: ['view'] } }],
  user_count: 0,
};

describe('roles table — system roles', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: ADMIN });
    (roleApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([SYSTEM_ROLE, CUSTOM_ROLE]);
  });

  it('disables delete for system roles but not custom ones (admin)', async () => {
    renderWithProviders(<Roles />);

    await screen.findByText('Cluster-Admin');
    expect(screen.getByText('System')).toBeInTheDocument();

    expect(screen.getByLabelText('delete-role-1')).toBeDisabled();
    expect(screen.getByLabelText('delete-role-2')).not.toBeDisabled();
  });

  it('shows the global + per-cluster sections in the create drawer', async () => {
    renderWithProviders(<Roles />);
    await screen.findByText('Cluster-Admin');

    fireEvent.click(screen.getByText('Create role'));
    expect(await screen.findByText('Global permissions')).toBeInTheDocument();
    expect(screen.getByText('Cluster permissions')).toBeInTheDocument();
    // The global tree exposes the system-management parent (unique to the tree).
    expect(screen.getByText('System management')).toBeInTheDocument();
    // The per-cluster resource matrix exposes resource rows (unique to the matrix).
    expect(screen.getByText('StatefulSets')).toBeInTheDocument();
  });

  it('copies a role into a prefilled create drawer (gated by create perm)', async () => {
    renderWithProviders(<Roles />);
    await screen.findByText('Cluster-Admin');

    // Copy button is present for both rows (admin has create).
    fireEvent.click(screen.getByLabelText('copy-role-2'));
    // Opens a drawer with the name prefilled "<name> copy" — the suffix proves
    // it's create mode (edit would prefill the bare name).
    expect(await screen.findByDisplayValue('Team Ops copy')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sidebar gating by /me nav + global
// ---------------------------------------------------------------------------

describe('sidebar nav gating by /me nav + global', () => {
  function renderSidebar() {
    return render(
      <Providers>
        <MemoryRouter>
          <Sidebar collapsed={false} />
        </MemoryRouter>
      </Providers>,
    );
  }

  it('non-admin sees only granted resource submenus and no management pages', () => {
    useAuthStore.setState({
      user: {
        id: 9,
        username: 'bob',
        is_admin: false,
        must_reset: false,
        nav: { submenus: ['deployments'] },
        global: {},
      },
    });
    renderSidebar();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Workloads')).toBeInTheDocument();
    expect(screen.queryByText('Networking')).not.toBeInTheDocument();
    expect(screen.queryByText('Release Records')).not.toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
  });

  it('shows Release Records when the releases global perm is granted', () => {
    useAuthStore.setState({
      user: {
        id: 9,
        username: 'bob',
        is_admin: false,
        must_reset: false,
        nav: { submenus: [] },
        global: { releases: ['view'] },
      },
    });
    renderSidebar();
    expect(screen.getByText('Release Records')).toBeInTheDocument();
  });

  it('shows the System submenu with only the areas the user may view', () => {
    useAuthStore.setState({
      user: {
        id: 9,
        username: 'bob',
        is_admin: false,
        must_reset: false,
        nav: { submenus: [] },
        global: { users: ['view'] },
      },
    });
    renderSidebar();

    const system = screen.getByText('System');
    expect(system).toBeInTheDocument();
    fireEvent.click(system);
    expect(screen.getByText('Users')).toBeInTheDocument();
    // Clusters/Roles are not viewable → not rendered.
    expect(screen.queryByText('Clusters')).not.toBeInTheDocument();
    expect(screen.queryByText('Roles')).not.toBeInTheDocument();
  });

  it('admin sees resource modules plus a full System submenu', () => {
    useAuthStore.setState({ user: ADMIN });
    renderSidebar();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Workloads')).toBeInTheDocument();
    expect(screen.getByText('Release Records')).toBeInTheDocument();
    const system = screen.getByText('System');
    fireEvent.click(system);
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Roles')).toBeInTheDocument();
  });
});
