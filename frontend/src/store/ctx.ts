import { create } from 'zustand';

const CLUSTER_KEY = 'omnikube_cluster';
const NS_KEY = 'omnikube_namespace';

interface CtxState {
  currentCluster: string | null;
  currentNamespace: string | null;
  setCluster: (id: string | null) => void;
  setNamespace: (ns: string | null) => void;
}

export const useCtxStore = create<CtxState>((set) => ({
  currentCluster: localStorage.getItem(CLUSTER_KEY),
  currentNamespace: localStorage.getItem(NS_KEY),
  setCluster: (id) => {
    if (id) localStorage.setItem(CLUSTER_KEY, id);
    else localStorage.removeItem(CLUSTER_KEY);
    // changing cluster invalidates the selected namespace
    localStorage.removeItem(NS_KEY);
    set({ currentCluster: id, currentNamespace: null });
  },
  setNamespace: (ns) => {
    if (ns) localStorage.setItem(NS_KEY, ns);
    else localStorage.removeItem(NS_KEY);
    set({ currentNamespace: ns });
  },
}));

/** Read the current cluster outside React (used by the axios interceptor). */
export function getCurrentCluster(): string | null {
  return useCtxStore.getState().currentCluster ?? localStorage.getItem(CLUSTER_KEY);
}
