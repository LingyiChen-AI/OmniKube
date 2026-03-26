import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clusters } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { getUserBindings, checkPermission, getUserAccessibleNamespaces } from '@/lib/rbac/check';
import { writeAuditLog } from '@/lib/audit/logger';
import { sendFeishuNotification } from '@/lib/notify/feishu';
import { listResources, getResource, createResource, updateResource, deleteResource, type ResourceKind } from '@/lib/k8s/resources';
import { writeReleaseLog } from '@/lib/release-logger';

type Params = { clusterId: string; resource: string[] };

function parseResourcePath(resource: string[]): { kind: ResourceKind; namespace?: string; name?: string } {
  // /api/k8s/{clusterId}/namespaces
  // /api/k8s/{clusterId}/namespaces/{namespace}/pods
  // /api/k8s/{clusterId}/namespaces/{namespace}/pods/{name}
  if (resource[0] === 'namespaces' && resource.length === 1) {
    return { kind: 'namespaces' };
  }
  if (resource[0] === 'nodes') {
    return { kind: 'nodes', name: resource[1] };
  }
  if (resource[0] === 'storageclasses') {
    return { kind: 'storageclasses', name: resource[1] };
  }
  if (resource[0] === 'namespaces' && resource.length >= 3) {
    const namespace = resource[1];
    const kind = resource[2] as ResourceKind;
    const name = resource[3];
    return { kind, namespace, name };
  }
  return { kind: resource[0] as ResourceKind };
}

function methodToAction(method: string): string {
  switch (method) {
    case 'GET': return 'get';
    case 'POST': return 'create';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return 'get';
  }
}

const actionLabel: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };

function extractImage(body: any): string {
  // Try common paths for image in K8s resources
  const image = body?.spec?.template?.spec?.containers?.[0]?.image
    || body?.spec?.containers?.[0]?.image
    || body?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image;
  if (!image) return '-';
  // Extract version tag: "nginx:1.26" -> "1.26", "repo/app:v2.3.1" -> "v2.3.1"
  const parts = image.split(':');
  return parts.length > 1 ? parts[parts.length - 1] : image;
}

async function notifyIfEnabled(clusterId: string, action: string, kind: string, resourceName: string, namespace: string | undefined, operator: string, changeMessage?: string, body?: any) {
  try {
    const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId)).limit(1);
    if (!cluster?.notifyEnabled || !cluster.webhookUrl) return;
    sendFeishuNotification(cluster.webhookUrl, {
      releaseName: resourceName,
      clusterName: cluster.displayName || cluster.name,
      namespace: namespace || '-',
      image: body ? extractImage(body) : '-',
      revision: 0,
      status: 'applied',
      message: changeMessage || `${actionLabel[action] || action} ${kind} ${resourceName}`,
      operator,
      time: new Date().toLocaleString('zh-CN'),
    });
  } catch { /* ignore notification errors */ }
}

async function handleRequest(req: NextRequest, params: Promise<Params>) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { clusterId, resource } = await params;
  const { kind, namespace, name } = parseResourcePath(resource);
  const action = methodToAction(req.method);

  // RBAC check
  const bindings = await getUserBindings(auth.user.id);
  const hasPermission = checkPermission(bindings, {
    clusterId,
    namespace: namespace || '*',
    resource: kind,
    action,
  });

  if (!hasPermission) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  try {
    if (req.method === 'GET' && !name) {
      // List resources
      let items = await listResources(clusterId, kind, namespace);

      // Filter by accessible namespaces
      const accessibleNs = await getUserAccessibleNamespaces(auth.user.id, clusterId);
      if (accessibleNs !== null) {
        if (kind === 'namespaces') {
          // Filter namespace list itself
          items = items.filter((item: any) => accessibleNs.includes(item.metadata?.name));
        } else if (kind !== 'nodes' && kind !== 'storageclasses') {
          // Filter namespaced resources
          if (!namespace) {
            items = items.filter((item: any) => accessibleNs.includes(item.metadata?.namespace));
          }
        }
      }

      await writeAuditLog({
        userId: auth.user.id,
        action: 'list',
        resourceType: kind,
        clusterId,
        namespace,
        requestMethod: 'GET',
        requestPath: req.nextUrl.pathname,
        responseStatus: 200,
      });
      return NextResponse.json(items);
    }

    if (req.method === 'GET' && name) {
      // Get single resource
      const item = await getResource(clusterId, kind, name, namespace);
      return NextResponse.json(item);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const created = await createResource(clusterId, kind, body, namespace);
      await writeAuditLog({
        userId: auth.user.id, action: 'create', resourceType: kind,
        resourceName: body.metadata?.name, clusterId, namespace,
        requestMethod: 'POST', requestPath: req.nextUrl.pathname,
        requestBody: body, responseStatus: 201,
      });
      notifyIfEnabled(clusterId, 'create', kind, body.metadata?.name || '', namespace, auth.user.username, undefined, body);
      writeReleaseLog({
        action: 'create', kind, resourceName: body.metadata?.name || '',
        clusterId, namespace: namespace || null, userId: auth.user.id, requestBody: body,
      });
      return NextResponse.json(created, { status: 201 });
    }

    if (req.method === 'PUT' && name) {
      const rawMsg = req.headers.get('X-Change-Message');
      const changeMessage = rawMsg ? decodeURIComponent(rawMsg) : undefined;
      const body = await req.json();
      const updated = await updateResource(clusterId, kind, name, body, namespace);
      await writeAuditLog({
        userId: auth.user.id, action: 'update', resourceType: kind,
        resourceName: name, clusterId, namespace,
        requestMethod: 'PUT', requestPath: req.nextUrl.pathname,
        requestBody: body, responseStatus: 200,
      });
      notifyIfEnabled(clusterId, 'update', kind, name, namespace, auth.user.username, changeMessage, body);
      writeReleaseLog({
        action: 'update', kind, resourceName: name,
        clusterId, namespace: namespace || null, userId: auth.user.id, requestBody: body,
        message: changeMessage,
      });
      return NextResponse.json(updated);
    }

    if (req.method === 'DELETE' && name) {
      await deleteResource(clusterId, kind, name, namespace);
      await writeAuditLog({
        userId: auth.user.id, action: 'delete', resourceType: kind,
        resourceName: name, clusterId, namespace,
        requestMethod: 'DELETE', requestPath: req.nextUrl.pathname,
        responseStatus: 200,
      });
      notifyIfEnabled(clusterId, 'delete', kind, name, namespace, auth.user.username);
      writeReleaseLog({
        action: 'delete', kind, resourceName: name,
        clusterId, namespace: namespace || null, userId: auth.user.id,
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<Params> }) {
  return handleRequest(req, ctx.params);
}

export async function POST(req: NextRequest, ctx: { params: Promise<Params> }) {
  return handleRequest(req, ctx.params);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<Params> }) {
  return handleRequest(req, ctx.params);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<Params> }) {
  return handleRequest(req, ctx.params);
}
