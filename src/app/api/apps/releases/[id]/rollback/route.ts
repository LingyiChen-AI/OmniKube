import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appReleases } from '@/lib/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { createResource, type ResourceKind } from '@/lib/k8s/resources';
import { writeAuditLog } from '@/lib/audit/logger';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id } = await params;

  // Find target release
  const [target] = await db.select().from(appReleases).where(eq(appReleases.id, id)).limit(1);
  if (!target) return NextResponse.json({ error: '发布记录不存在' }, { status: 404 });

  // Get latest revision number for this release name + cluster + namespace
  const [latest] = await db
    .select()
    .from(appReleases)
    .where(
      and(
        eq(appReleases.name, target.name),
        eq(appReleases.clusterId, target.clusterId),
        eq(appReleases.namespace, target.namespace),
      ),
    )
    .orderBy(desc(appReleases.revision))
    .limit(1);

  const newRevision = (latest?.revision ?? target.revision) + 1;
  const manifests = Array.isArray(target.renderedManifests) ? target.renderedManifests : [target.renderedManifests];

  // Create new release from target manifests
  const [newRelease] = await db.insert(appReleases).values({
    appTemplateId: target.appTemplateId,
    clusterId: target.clusterId,
    namespace: target.namespace,
    name: target.name,
    values: target.values,
    renderedManifests: target.renderedManifests,
    status: 'pending',
    revision: newRevision,
    releasedBy: auth.user.id,
  }).returning();

  // Re-apply manifests to K8s
  let status: 'applied' | 'failed' = 'applied';
  try {
    for (const manifest of manifests) {
      const kind = (manifest as any)?.kind?.toLowerCase() + 's' as ResourceKind;
      const resourceNamespace = (manifest as any)?.metadata?.namespace || target.namespace;
      await createResource(target.clusterId, kind, manifest, resourceNamespace);
    }
  } catch {
    status = 'failed';
  }

  await db.update(appReleases)
    .set({ status, updatedAt: new Date() })
    .where(eq(appReleases.id, newRelease.id));

  // Mark original as rolled_back
  await db.update(appReleases)
    .set({ status: 'rolled_back', updatedAt: new Date() })
    .where(eq(appReleases.id, id));

  await writeAuditLog({
    userId: auth.user.id,
    action: 'update',
    resourceType: 'app_release',
    resourceName: target.name,
    clusterId: target.clusterId,
    namespace: target.namespace,
    requestMethod: 'POST',
    requestPath: `/api/apps/releases/${id}/rollback`,
    responseStatus: 200,
  });

  return NextResponse.json({ ...newRelease, status });
}
