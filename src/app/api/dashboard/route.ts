import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clusters, appReleases } from '@/lib/db/schema';
import { eq, gte, and, sql, inArray } from 'drizzle-orm';
import { validateSession } from '@/lib/auth/session';
import { getK8sClient } from '@/lib/k8s/client-manager';
import { getUserAccessibleClusterIds, getUserAccessibleNamespaces } from '@/lib/rbac/check';

export async function GET(req: NextRequest) {
  const auth = await validateSession();
  if (!auth) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const selectedClusterId = req.nextUrl.searchParams.get('clusterId');
  const accessibleIds = await getUserAccessibleClusterIds(auth.user.id);

  // Build cluster query with filters
  const conditions = [];
  if (selectedClusterId) {
    conditions.push(eq(clusters.id, selectedClusterId));
  }
  if (accessibleIds !== null) {
    if (accessibleIds.length === 0) {
      return NextResponse.json({
        clusterCount: 0, podCount: 0, deploymentCount: 0,
        todayReleaseCount: 0, clusters: [], events: [],
      });
    }
    conditions.push(inArray(clusters.id, accessibleIds));
  }

  const clusterQuery = db.select({
    id: clusters.id, name: clusters.name, displayName: clusters.displayName, status: clusters.status,
  }).from(clusters);

  const allClusters = conditions.length > 0
    ? await clusterQuery.where(and(...conditions))
    : await clusterQuery;

  // Today's releases count - filtered by same clusters
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const releaseConditions = [gte(appReleases.createdAt, today)];
  if (selectedClusterId) {
    releaseConditions.push(eq(appReleases.clusterId, selectedClusterId));
  } else if (accessibleIds !== null) {
    releaseConditions.push(inArray(appReleases.clusterId, accessibleIds));
  }
  const todayReleases = await db.select({ count: sql<number>`count(*)::int` })
    .from(appReleases)
    .where(and(...releaseConditions));

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
        const accessibleNs = await getUserAccessibleNamespaces(auth.user.id, cluster.id);

        // Helper: list resources filtered by accessible namespaces
        const listByNs = async <T>(
          listAll: () => Promise<{ items?: T[] }>,
          listNs: (ns: string) => Promise<{ items?: T[] }>,
        ): Promise<T[]> => {
          if (accessibleNs === null) {
            const res = await listAll();
            return res.items || [];
          }
          const results: T[] = [];
          for (const ns of accessibleNs) {
            const res = await listNs(ns);
            results.push(...(res.items || []));
          }
          return results;
        };

        // Count pods
        const podItems = await listByNs(
          () => clients.core.listPodForAllNamespaces(),
          (ns) => clients.core.listNamespacedPod({ namespace: ns }),
        );
        totalPods += podItems.length;
        stat.pods = podItems.length;

        // Count nodes (cluster-level, not namespace-scoped)
        const nodes = await clients.core.listNode();
        stat.nodes = nodes.items?.length || 0;

        // Count deployments
        const depItems = await listByNs(
          () => clients.apps.listDeploymentForAllNamespaces(),
          (ns) => clients.apps.listNamespacedDeployment({ namespace: ns }),
        );
        totalDeployments += depItems.length;

        // Get recent events
        const eventItems = await listByNs(
          () => clients.core.listEventForAllNamespaces(),
          (ns) => clients.core.listNamespacedEvent({ namespace: ns }),
        );
        const sorted = eventItems
          .sort((a: any, b: any) => {
            const ta = a.lastTimestamp || a.metadata?.creationTimestamp;
            const tb = b.lastTimestamp || b.metadata?.creationTimestamp;
            return new Date(tb || 0).getTime() - new Date(ta || 0).getTime();
          })
          .slice(0, 5);

        for (const evt of sorted as any[]) {
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
