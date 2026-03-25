import { db } from '@/lib/db';
import { appReleases } from '@/lib/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';

const KIND_LABELS: Record<string, string> = {
  deployments: 'Deployment', statefulsets: 'StatefulSet', daemonsets: 'DaemonSet',
  services: 'Service', configmaps: 'ConfigMap', secrets: 'Secret',
  ingresses: 'Ingress', jobs: 'Job', cronjobs: 'CronJob', pods: 'Pod',
  persistentvolumeclaims: 'PVC', storageclasses: 'StorageClass', namespaces: 'Namespace',
};

interface ReleaseLogEntry {
  action: 'create' | 'update' | 'delete';
  kind: string;
  resourceName: string;
  clusterId: string;
  namespace: string | null;
  userId: string;
  requestBody?: any;
}

export async function writeReleaseLog(entry: ReleaseLogEntry) {
  try {
    const kindLabel = KIND_LABELS[entry.kind] || entry.kind;
    const actionLabel = entry.action === 'create' ? '创建' : entry.action === 'update' ? '更新' : '删除';
    const message = `${actionLabel} ${kindLabel} ${entry.resourceName}`;

    // Compute next revision
    const nsCondition = entry.namespace
      ? eq(appReleases.namespace, entry.namespace)
      : isNull(appReleases.namespace);

    const [latest] = await db.select({ revision: appReleases.revision })
      .from(appReleases)
      .where(and(
        eq(appReleases.name, entry.resourceName),
        eq(appReleases.clusterId, entry.clusterId),
        nsCondition,
      ))
      .orderBy(desc(appReleases.revision))
      .limit(1);

    const revision = (latest?.revision ?? 0) + 1;

    await db.insert(appReleases).values({
      appTemplateId: null,
      clusterId: entry.clusterId,
      namespace: entry.namespace,
      name: entry.resourceName,
      values: null,
      renderedManifests: entry.action === 'delete' ? null : entry.requestBody,
      status: 'applied',
      revision,
      message,
      releasedBy: entry.userId,
    });
  } catch (err) {
    console.error('Failed to write release log:', err);
    // Don't throw — release logging should never break the main operation
  }
}
