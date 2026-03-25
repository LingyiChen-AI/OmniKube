import { db } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';

export interface AuditEntry {
  userId?: string;
  action: string;
  resourceType: string;
  resourceName?: string;
  clusterId?: string;
  namespace?: string;
  requestMethod?: string;
  requestPath?: string;
  requestBody?: unknown;
  responseStatus?: number;
  ipAddress?: string;
  userAgent?: string;
}

export async function writeAuditLog(entry: AuditEntry) {
  await db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceName: entry.resourceName,
    clusterId: entry.clusterId,
    namespace: entry.namespace,
    requestMethod: entry.requestMethod,
    requestPath: entry.requestPath,
    requestBody: entry.requestBody,
    responseStatus: entry.responseStatus,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
  });
}
