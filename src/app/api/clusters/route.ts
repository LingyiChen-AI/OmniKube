import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clusters } from '@/lib/db/schema';
import { validateSession } from '@/lib/auth/session';
import { encrypt } from '@/lib/crypto';
import { writeAuditLog } from '@/lib/audit/logger';
import { desc, inArray } from 'drizzle-orm';
import { getUserAccessibleClusterIds } from '@/lib/rbac/check';

export async function GET() {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const accessibleIds = await getUserAccessibleClusterIds(auth.user.id);

  if (accessibleIds !== null && accessibleIds.length === 0) {
    return NextResponse.json([]);
  }

  const query = db.select({
    id: clusters.id, name: clusters.name, displayName: clusters.displayName,
    apiServerUrl: clusters.apiServerUrl, authType: clusters.authType,
    status: clusters.status, lastHealthCheckAt: clusters.lastHealthCheckAt,
    description: clusters.description, webhookUrl: clusters.webhookUrl,
    notifyEnabled: clusters.notifyEnabled, createdAt: clusters.createdAt,
  }).from(clusters);

  const list = accessibleIds === null
    ? await query.orderBy(desc(clusters.createdAt))
    : await query.where(inArray(clusters.id, accessibleIds)).orderBy(desc(clusters.createdAt));

  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const body = await req.json();
  const { name, displayName, apiServerUrl, authType, kubeconfig, saToken, caCert, description, webhookUrl, notifyEnabled } = body;

  const [cluster] = await db.insert(clusters).values({
    name,
    displayName,
    apiServerUrl,
    authType,
    kubeconfig: kubeconfig ? encrypt(kubeconfig) : null,
    saToken: saToken ? encrypt(saToken) : null,
    caCert,
    description,
    webhookUrl: webhookUrl || null,
    notifyEnabled: notifyEnabled || false,
    createdBy: auth.user.id,
  }).returning();

  await writeAuditLog({
    userId: auth.user.id,
    action: 'create',
    resourceType: 'cluster',
    resourceName: name,
    requestMethod: 'POST',
    requestPath: '/api/clusters',
    responseStatus: 201,
  });

  return NextResponse.json(cluster, { status: 201 });
}
