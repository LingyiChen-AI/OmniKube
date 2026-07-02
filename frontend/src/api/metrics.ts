import client from './client';

/** Per-node usage vs allocatable (CPU in mCPU, memory in bytes). */
export interface NodeMetric {
  name: string;
  cpu: number;
  memory: number;
  cpu_capacity: number;
  mem_capacity: number;
  cpu_pct: number;
  mem_pct: number;
}

/** Per-pod usage (CPU in mCPU, memory in bytes). */
export interface PodMetric {
  namespace: string;
  name: string;
  cpu: number;
  memory: number;
}

export const metricsApi = {
  /** Whether metrics-server is serving on the current cluster. */
  available: () =>
    client.get<{ available: boolean }>('/metrics/available').then((r) => r.data.available),

  nodes: () =>
    client
      .get<{ available: boolean; nodes: NodeMetric[] }>('/metrics/nodes')
      .then((r) => ({ available: r.data.available, nodes: r.data.nodes ?? [] })),

  pods: (namespace?: string) =>
    client
      .get<{ available: boolean; pods: PodMetric[] }>('/metrics/pods', {
        params: namespace ? { namespace } : undefined,
      })
      .then((r) => ({ available: r.data.available, pods: r.data.pods ?? [] })),
};

/** Format mCPU as cores (e.g. 429 → "429m", 1500 → "1.5"). */
export function formatCpu(mcpu: number): string {
  if (mcpu <= 0) return '0';
  if (mcpu < 1000) return `${mcpu}m`;
  return (mcpu / 1000).toFixed(mcpu % 1000 === 0 ? 0 : 1);
}

/** Format bytes as Mi/Gi. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0';
  const mi = bytes / (1024 * 1024);
  if (mi < 1024) return `${Math.round(mi)}Mi`;
  return `${(mi / 1024).toFixed(1)}Gi`;
}
