import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/auth/session';
import { getK8sClient } from '@/lib/k8s/client-manager';
import { getUserBindings, checkPermission } from '@/lib/rbac/check';

export async function GET(req: NextRequest, { params }: { params: Promise<{ clusterId: string; namespace: string; pod: string }> }) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { clusterId, namespace, pod } = await params;

  // RBAC check
  const bindings = await getUserBindings(auth.user.id);
  const hasPermission = checkPermission(bindings, {
    clusterId, namespace, resource: 'pods', action: 'get',
  });
  if (!hasPermission) {
    return NextResponse.json({ error: '权限不足' }, { status: 403 });
  }

  const container = req.nextUrl.searchParams.get('container') || undefined;
  const tailLines = parseInt(req.nextUrl.searchParams.get('tailLines') || '200');

  try {
    const clients = await getK8sClient(clusterId);
    const log = await clients.core.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      tailLines,
    });
    return new NextResponse(log, { headers: { 'Content-Type': 'text/plain' } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
