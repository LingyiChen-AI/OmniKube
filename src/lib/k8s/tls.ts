import { existsSync } from 'fs';

/**
 * Structural subset of @kubernetes/client-node's Cluster,
 * kept import-free so it stays testable under CJS jest (the lib is ESM-only).
 */
export interface TlsCluster {
  readonly name: string;
  readonly server: string;
  readonly caData?: string;
  readonly caFile?: string;
  readonly skipTLSVerify?: boolean;
}

/**
 * Allow connecting to clusters that use self-signed certificates (issue #2).
 *
 * - K8S_SKIP_TLS_VERIFY=true force-skips verification for all clusters.
 * - A cluster with no usable CA (no caData, and caFile missing on disk) would
 *   otherwise be verified against the system trust store and always fail for
 *   self-signed certs, so verification is skipped — same behavior as the
 *   token auth path (`skipTLSVerify: !cluster.caCert`).
 * - Clusters that provide a CA keep full verification.
 */
export function applyTlsFallback(kc: { clusters: TlsCluster[] }): void {
  const forceSkip = process.env.K8S_SKIP_TLS_VERIFY === 'true';
  for (const cluster of kc.clusters) {
    if (cluster.skipTLSVerify) continue;
    const hasUsableCa = !!cluster.caData || (!!cluster.caFile && existsSync(cluster.caFile));
    if (forceSkip || !hasUsableCa) {
      (cluster as { skipTLSVerify?: boolean }).skipTLSVerify = true;
    }
  }
}
