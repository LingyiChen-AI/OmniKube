import client from './client';

/** One audit-log row as returned by GET /audit-logs. */
export interface AuditLog {
  id: number;
  user_id: string;
  username: string;
  cluster_id: string;
  namespace: string;
  resource: string;
  action: string;
  target: string;
  result: string;
  source_ip: string;
  created_at: string;
}

/** Filters accepted by the audit query + export endpoints. */
export interface AuditParams {
  user_id?: string;
  action?: string;
  resource?: string;
  cluster_id?: string;
  namespace?: string;
  result?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Drop empty/undefined filter values so they don't hit the query string. */
function clean(params: AuditParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) out[k] = v as string | number;
  }
  return out;
}

export const auditApi = {
  /** Paginated audit query (newest first). Returns rows + total for the filter. */
  list: (params: AuditParams = {}) =>
    client
      .get<{ logs: AuditLog[]; total: number }>('/audit-logs', { params: clean(params) })
      .then((r) => ({ logs: r.data.logs ?? [], total: r.data.total ?? 0 })),

  /** Download the filtered audit log as a CSV file (auth header preserved via blob fetch). */
  exportCsv: async (params: AuditParams = {}) => {
    const resp = await client.get('/audit-logs/export', {
      params: clean(params),
      responseType: 'blob',
    });
    const url = window.URL.createObjectURL(resp.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },
};

/** Audit actions the filter dropdown offers (aligned with backend deriveAction). */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'scale',
  'restart',
  'rollback',
  'login',
  'set-roles',
  'disable',
  'enable',
  'reset-password',
  'change-password',
  'reveal',
  'test',
] as const;

/** Audit result states. */
export const AUDIT_RESULTS = ['success', 'denied', 'failed'] as const;
