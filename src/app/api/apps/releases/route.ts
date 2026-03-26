import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appReleases, users } from '@/lib/db/schema';
import { validateSession } from '@/lib/auth/session';
import { desc, eq, inArray, and } from 'drizzle-orm';
import { getUserAccessibleClusterIds, getUserAccessibleNamespaces } from '@/lib/rbac/check';

export async function GET(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('pageSize') || '20');

  // Build filters based on user permissions
  const accessibleClusterIds = await getUserAccessibleClusterIds(auth.user.id);

  const conditions = [];
  if (accessibleClusterIds !== null) {
    if (accessibleClusterIds.length === 0) return NextResponse.json([]);
    conditions.push(inArray(appReleases.clusterId, accessibleClusterIds));
  }

  const list = await db
    .select({
      id: appReleases.id,
      appTemplateId: appReleases.appTemplateId,
      clusterId: appReleases.clusterId,
      namespace: appReleases.namespace,
      name: appReleases.name,
      values: appReleases.values,
      status: appReleases.status,
      revision: appReleases.revision,
      message: appReleases.message,
      releasedBy: appReleases.releasedBy,
      createdAt: appReleases.createdAt,
      updatedAt: appReleases.updatedAt,
      operator: users.username,
    })
    .from(appReleases)
    .leftJoin(users, eq(appReleases.releasedBy, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(appReleases.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Further filter by accessible namespaces per cluster
  if (accessibleClusterIds !== null) {
    const filtered = [];
    for (const record of list) {
      if (!record.clusterId) { filtered.push(record); continue; }
      const accessibleNs = await getUserAccessibleNamespaces(auth.user.id, record.clusterId);
      if (accessibleNs === null || (record.namespace && accessibleNs.includes(record.namespace))) {
        filtered.push(record);
      }
    }
    return NextResponse.json(filtered);
  }

  return NextResponse.json(list);
}
