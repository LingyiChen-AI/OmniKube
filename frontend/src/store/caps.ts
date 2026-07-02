import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { meApi, type CapabilityResources } from '../api/me';
import type { TreeAction } from '../api/role';
import { useCtxStore } from './ctx';

/** Key identifying which (cluster, namespace) the loaded capabilities belong to. */
function capsKey(cluster: string | null, namespace: string | null): string {
  return `${cluster ?? ''}::${namespace ?? ''}`;
}

interface CapsState {
  resources: CapabilityResources;
  loading: boolean;
  /** Key the current `resources` were loaded for (null = never loaded). */
  loadedKey: string | null;
  /** Key of an in-flight request, to dedupe concurrent loads. */
  pendingKey: string | null;
  load: (cluster: string | null, namespace: string | null) => Promise<void>;
}

/**
 * Shared capabilities store: fetches the current user's allowed actions per
 * CONCRETE resource for the active cluster + namespace and caches them so the
 * many action-button consumers don't each fire a request. Re-fetches when the
 * cluster or namespace changes.
 */
export const useCapsStore = create<CapsState>((set, get) => ({
  resources: {},
  loading: false,
  loadedKey: null,
  pendingKey: null,
  load: async (cluster, namespace) => {
    const key = capsKey(cluster, namespace);
    const s = get();
    // Already have this slice, or a request for it is already in flight.
    if (s.loadedKey === key || s.pendingKey === key) return;
    // Without a cluster the backend can't resolve capabilities.
    if (!cluster) {
      set({ resources: {}, loadedKey: key, pendingKey: null, loading: false });
      return;
    }
    set({ loading: true, pendingKey: key });
    try {
      const resources = await meApi.capabilities(namespace ?? undefined);
      // Ignore stale responses if the context changed mid-flight.
      if (get().pendingKey !== key) return;
      set({ resources, loadedKey: key, pendingKey: null, loading: false });
    } catch {
      if (get().pendingKey !== key) return;
      set({ resources: {}, loadedKey: key, pendingKey: null, loading: false });
    }
  },
}));

export interface Capabilities {
  /** True if the current user may perform `action` on the given concrete resource. */
  can: (resource: string | undefined, action: TreeAction) => boolean;
  resources: CapabilityResources;
  loading: boolean;
}

/**
 * Hook that keeps capabilities in sync with the current cluster + namespace and
 * exposes a `can(resource, action)` helper. When the resource is unknown the
 * helper returns false (callers should keep always-allowed actions like "view"
 * outside the gate).
 */
export function useCapabilities(): Capabilities {
  const { currentCluster, currentNamespace } = useCtxStore();
  const resources = useCapsStore((s) => s.resources);
  const loading = useCapsStore((s) => s.loading);
  const load = useCapsStore((s) => s.load);

  useEffect(() => {
    load(currentCluster, currentNamespace);
  }, [currentCluster, currentNamespace, load]);

  const can = useCallback(
    (resource: string | undefined, action: TreeAction): boolean =>
      resource ? (resources[resource] ?? []).includes(action) : false,
    [resources],
  );

  return { can, resources, loading };
}
