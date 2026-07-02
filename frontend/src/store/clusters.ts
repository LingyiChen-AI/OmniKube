import { create } from 'zustand';
import { clusterApi, type Cluster } from '../api/cluster';

interface ClustersState {
  clusters: Cluster[];
  loading: boolean;
  loaded: boolean;
  error: unknown;
  /** Load once (no-op if already loaded and not loading). */
  load: () => Promise<void>;
  /** Force a re-fetch (used after add / update / delete). */
  refresh: () => Promise<void>;
}

async function fetchInto(
  set: (partial: Partial<ClustersState>) => void,
  get: () => ClustersState,
): Promise<void> {
  if (get().loading) return;
  set({ loading: true, error: null });
  try {
    const clusters = await clusterApi.list();
    set({ clusters, loading: false, loaded: true });
  } catch (error) {
    set({ error, loading: false, loaded: true });
  }
}

export const useClusterStore = create<ClustersState>((set, get) => ({
  clusters: [],
  loading: false,
  loaded: false,
  error: null,
  load: async () => {
    if (get().loaded || get().loading) return;
    await fetchInto(set, get);
  },
  refresh: () => fetchInto(set, get),
}));
