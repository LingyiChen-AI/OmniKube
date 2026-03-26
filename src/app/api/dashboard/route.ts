import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clusters, appReleases } from '@/lib/db/schema';
import { eq, gte, and, sql, inArray } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { getK8sClient } from '@/lib/k8s/client-manager';
import { getUserAccessibleClusterIds } from '@/lib/rbac/check';

export async function GET() {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const accessibleIds = await getUserAccessibleClusterIds(auth.user.id);

  // Get clusters filtered by user permissions
  const clusterQuery = db.select({
    id: clusters.id, name: clusters.name, displayName: clusters.displayName, status: clusters.status,
  }).from(clusters);

  const allClusters = accessibleIds === null
    ? await clusterQuery
    : accessibleIds.length === 0
    ? []
    : await clusterQuery.where(inArray(clusters.id, accessibleIds));

  // Today's releases count
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayReleases = await db.select({ count: sql<number>`count(*)::int` })
    .from(appReleases)
    .where(gte(appReleases.createdAt, today));

  // Aggregate K8s stats from connected clusters
  let totalPods = 0;
  let totalDeployments = 0;
  const clusterStats = [];
  const recentEvents: any[] = [];

  for (const cluster of allClusters) {
    const stat: any = {
      id: cluster.id,
      name: cluster.displayName || cluster.name,
      status: cluster.status,
      nodes: 0,
      pods: 0,
    };

    if (cluster.status === 'connected') {
      try {
        const clients = await getK8sClient(cluster.id);

        // Count pods
        const pods = await clients.core.listPodForAllNamespaces();
        const podCount = pods.items?.length || 0;
        totalPods += podCount;
        stat.pods = podCount;

        // Count nodes
        const nodes = await clients.core.listNode();
        stat.nodes = nodes.items?.length || 0;

        // Count deployments
        const deployments = await clients.apps.listDeploymentForAllNamespaces();
        const depCount = deployments.items?.length || 0;
        totalDeployments += depCount;

        // Get recent events (last 10)
        const events = await clients.core.listEventForAllNamespaces();
        const sorted = (events.items || [])
          .sort((a, b) => {
            const ta = a.lastTimestamp || a.metadata?.creationTimestamp;
            const tb = b.lastTimestamp || b.metadata?.creationTimestamp;
            return new Date(tb || 0).getTime() - new Date(ta || 0).getTime();
          })
          .slice(0, 5);

        for (const evt of sorted) {
          recentEvents.push({
            cluster: cluster.displayName || cluster.name,
            type: evt.type,
            reason: evt.reason,
            message: evt.message,
            namespace: evt.metadata?.namespace,
            object: evt.involvedObject?.name,
            time: evt.lastTimestamp || evt.metadata?.creationTimestamp,
          });
        }
      } catch {
        stat.status = 'error';
      }
    }

    clusterStats.push(stat);
  }

  // Sort events by time, take top 10
  recentEvents.sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());

  return NextResponse.json({
    clusterCount: allClusters.length,
    podCount: totalPods,
    deploymentCount: totalDeployments,
    todayReleaseCount: todayReleases[0]?.count || 0,
    clusters: clusterStats,
    events: recentEvents.slice(0, 10),
  });
}
