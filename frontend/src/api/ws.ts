import { API_BASE, API_PREFIX } from './client';
import { getToken } from '../store/auth';

function wsBase(): string {
  // Derive ws(s):// origin from the configured API base.
  try {
    const u = new URL(API_BASE, window.location.origin);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${u.protocol}//${u.host}${API_PREFIX}`;
  } catch {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${API_PREFIX}`;
  }
}

interface ExecParams {
  cluster_id: string;
  namespace: string;
  pod: string;
  container?: string;
}

export function execUrl(p: ExecParams): string {
  const q = new URLSearchParams({
    cluster_id: p.cluster_id,
    namespace: p.namespace,
    pod: p.pod,
    token: getToken() || '',
  });
  if (p.container) q.set('container', p.container);
  return `${wsBase()}/exec?${q.toString()}`;
}

interface LogParams extends ExecParams {
  follow?: boolean;
  tail?: number;
}

export function logsUrl(p: LogParams): string {
  const q = new URLSearchParams({
    cluster_id: p.cluster_id,
    namespace: p.namespace,
    pod: p.pod,
    token: getToken() || '',
    follow: String(p.follow ?? true),
    tail: String(p.tail ?? 200),
  });
  if (p.container) q.set('container', p.container);
  return `${wsBase()}/logs?${q.toString()}`;
}

export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}
