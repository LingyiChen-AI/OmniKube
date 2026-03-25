'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ClusterState {
  clusterId: string | null;
  clusterName: string | null;
  setCluster: (id: string, name: string) => void;
}

export const useClusterStore = create<ClusterState>()(
  persist(
    (set) => ({
      clusterId: null,
      clusterName: null,
      setCluster: (id, name) => set({ clusterId: id, clusterName: name }),
    }),
    { name: 'k8s-cluster' },
  ),
);
