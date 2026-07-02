import { useEffect, useState } from 'react';
import { resourceApi, type K8sObject } from '../../../api/resource';

/**
 * Fetch a resource list from the current cluster for use as create-form
 * dropdown options. Errors (no permission, cluster-scoped resource the user
 * can't list, etc.) degrade to an empty list so the consuming field falls back
 * to free text. `enabled=false` skips the fetch entirely.
 */
export function useClusterList(resource: string, namespace?: string, enabled = true) {
  const [items, setItems] = useState<K8sObject[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    resourceApi
      .list(resource, namespace)
      .then((d) => {
        if (!cancelled) setItems(d);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, namespace, enabled]);

  const names = items.map((it) => it.metadata?.name).filter(Boolean) as string[];
  return { items, names, loading };
}
