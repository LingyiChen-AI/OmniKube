import client from './client';
import type { TreeAction } from './role';

/** The current user's allowed actions per CONCRETE resource (admin → all). */
export type CapabilityResources = Record<string, TreeAction[]>;

export const meApi = {
  /**
   * Current user's capabilities for the active cluster (X-Cluster-ID is added
   * automatically by the axios client) and an optional namespace.
   * Returns the `resources` map; an empty object when no cluster is selected.
   */
  capabilities: (namespace?: string) =>
    client
      .get<{ resources: CapabilityResources }>('/me/capabilities', {
        params: namespace ? { namespace } : undefined,
      })
      .then((r) => r.data?.resources ?? {}),
};
