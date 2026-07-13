import { hasNoChange } from '../../components/editor/diff';

/** A freshly-fetched manifest from the cluster (paired with its resourceVersion). */
export interface LiveSnapshot {
  manifest_yaml: string;
  resource_version: string;
}

/**
 * True when the cluster object has drifted from the base this order item was
 * snapshotted from — i.e. someone changed it after the snapshot was taken, so
 * publishing the order would silently overwrite that change.
 *
 * Prefers resourceVersion (precise: did the object move, regardless of what the
 * user has since staged in the order). Falls back to a content comparison for
 * legacy items that predate RV capture (or when the live RV is unavailable).
 */
export function baseDrifted(
  item: { manifest_yaml: string; resource_version?: string },
  live: LiveSnapshot,
): boolean {
  if (item.resource_version && live.resource_version) {
    return item.resource_version !== live.resource_version;
  }
  return !hasNoChange(item.manifest_yaml, live.manifest_yaml);
}
