import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { appReleases, appTemplates } from '@/lib/db/schema';
import { validateSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/logger';
import { createResource, type ResourceKind } from '@/lib/k8s/resources';
import { desc, eq } from 'drizzle-orm';

function renderTemplate(template: unknown, variables: Record<string, string>): unknown {
  const str = JSON.stringify(template);
  const rendered = str.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
  return JSON.parse(rendered);
}

export async function GET(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('pageSize') || '20');

  const list = await db
    .select()
    .from(appReleases)
    .orderBy(desc(appReleases.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { appTemplateId, clusterId, namespace, name, values } = await req.json();

  // Load template
  const [template] = await db.select().from(appTemplates).where(eq(appTemplates.id, appTemplateId)).limit(1);
  if (!template) return NextResponse.json({ error: '模板不存在' }, { status: 404 });

  // Render template variables
  const rendered = renderTemplate(template.template, values || {});
  const manifests = Array.isArray(rendered) ? rendered : [rendered];

  // Create release record initially as pending
  const [release] = await db.insert(appReleases).values({
    appTemplateId,
    clusterId,
    namespace,
    name,
    values,
    renderedManifests: manifests,
    status: 'pending',
    revision: 1,
    releasedBy: auth.user.id,
  }).returning();

  // Apply each resource to K8s
  let status: 'applied' | 'failed' = 'applied';
  try {
    for (const manifest of manifests) {
      const kind = (manifest as any)?.kind?.toLowerCase() + 's' as ResourceKind;
      const resourceNamespace = (manifest as any)?.metadata?.namespace || namespace;
      await createResource(clusterId, kind, manifest, resourceNamespace);
    }
  } catch (err: any) {
    status = 'failed';
  }

  // Update release status
  await db.update(appReleases)
    .set({ status, updatedAt: new Date() })
    .where(eq(appReleases.id, release.id));

  await writeAuditLog({
    userId: auth.user.id,
    action: 'create',
    resourceType: 'app_release',
    resourceName: name,
    clusterId,
    namespace,
    requestMethod: 'POST',
    requestPath: '/api/apps/releases',
    responseStatus: status === 'applied' ? 201 : 500,
  });

  return NextResponse.json({ ...release, status }, { status: 201 });
}
