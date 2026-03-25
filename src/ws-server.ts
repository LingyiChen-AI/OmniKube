import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { PassThrough } from 'stream';
import { db } from './lib/db';
import { sessions, users, userRoleBindings, rolePermissions, clusters as clustersTable } from './lib/db/schema';
import { eq, and, gt, lt } from 'drizzle-orm';
import { checkPermission, type RoleBinding } from './lib/rbac/check';
import { getK8sClient, invalidateClient } from './lib/k8s/client-manager';
import * as k8s from '@kubernetes/client-node';

const PORT = parseInt(process.env.WS_PORT || '3001');
const wss = new WebSocketServer({ port: PORT });

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  bindings?: RoleBinding[];
}

async function authenticate(token: string) {
  const result = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (result.length === 0) return null;
  return result[0].user;
}

async function getUserBindings(userId: string): Promise<RoleBinding[]> {
  const rows = await db
    .select({
      roleId: userRoleBindings.roleId,
      clusterId: userRoleBindings.clusterId,
      namespace: userRoleBindings.namespace,
      resource: rolePermissions.resource,
      actions: rolePermissions.actions,
    })
    .from(userRoleBindings)
    .innerJoin(rolePermissions, eq(userRoleBindings.roleId, rolePermissions.roleId))
    .where(eq(userRoleBindings.userId, userId));

  const bindingMap = new Map<string, RoleBinding>();
  for (const row of rows) {
    const key = `${row.roleId}:${row.clusterId}:${row.namespace}`;
    if (!bindingMap.has(key)) {
      bindingMap.set(key, { roleId: row.roleId, clusterId: row.clusterId, namespace: row.namespace, permissions: [] });
    }
    bindingMap.get(key)!.permissions.push({ resource: row.resource, actions: row.actions as string[] });
  }
  return Array.from(bindingMap.values());
}

wss.on('connection', async (ws: AuthenticatedSocket, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Token required');
    return;
  }

  const user = await authenticate(token);
  if (!user) {
    ws.close(4001, 'Invalid token');
    return;
  }

  ws.userId = user.id;
  ws.bindings = await getUserBindings(user.id);

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleMessage(ws, msg);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: 'error', message }));
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
  });
});

async function handleMessage(ws: AuthenticatedSocket, msg: any) {
  const { type, clusterId, namespace, podName, container, resourceType } = msg;

  // RBAC check for every subscription
  const resource = type === 'subscribe-logs' ? 'pods' : type === 'subscribe-events' ? 'events' : type === 'subscribe-exec' ? 'pods' : resourceType || 'pods';
  const action = type === 'subscribe-logs' ? 'logs' : type === 'subscribe-exec' ? 'exec' : 'get';

  if (!checkPermission(ws.bindings || [], { clusterId, namespace: namespace || '*', resource, action })) {
    ws.send(JSON.stringify({ type: 'error', message: '权限不足' }));
    return;
  }

  if (type === 'subscribe-logs') {
    const clients = await getK8sClient(clusterId);
    const logStream = new k8s.Log(clients.kc);
    const passThrough = new PassThrough();

    passThrough.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'log', data: chunk.toString() }));
      }
    });

    passThrough.on('error', () => passThrough.destroy());

    const abortController = await logStream.log(namespace, podName, container, passThrough, {
      follow: true,
      tailLines: 100,
    });

    ws.on('close', () => {
      abortController.abort();
      passThrough.destroy();
    });
  }

  if (type === 'subscribe-exec') {
    await handleExec(ws, msg);
    return;
  }

  if (type === 'subscribe-resource-watch') {
    await handleResourceWatch(ws, msg);
    return;
  }

  if (type === 'subscribe-events') {
    const clients = await getK8sClient(clusterId);
    const watch = new k8s.Watch(clients.kc);

    const path = namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events';
    const watchReq = await watch.watch(path, {}, (phase, obj) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', phase, data: obj }));
      }
    }, (err) => {
      if (err) ws.send(JSON.stringify({ type: 'error', message: err.message }));
    });

    ws.on('close', () => watchReq.abort());
  }
}

// Exec handler — interactive shell via k8s.Exec
async function handleExec(ws: AuthenticatedSocket, msg: any) {
  const { clusterId, namespace, podName, container } = msg;
  const clients = await getK8sClient(clusterId);
  const exec = new k8s.Exec(clients.kc);

  const { PassThrough: PT } = await import('stream');
  const stdin = new PT();
  const stdout = new PT();
  const stderr = new PT();

  stdout.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec-output', data: chunk.toString() }));
    }
  });

  stderr.on('data', (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exec-output', data: chunk.toString() }));
    }
  });

  // Start exec session
  const execWs = await exec.exec(
    namespace,
    podName,
    container || '',
    ['/bin/sh', '-c', 'TERM=xterm-256color; export TERM; [ -x /bin/bash ] && exec /bin/bash || exec /bin/sh'],
    stdout,
    stderr,
    stdin,
    true, // tty
  );

  // Forward incoming messages (stdin / resize) from client to pod
  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === 'exec-input') {
        stdin.push(parsed.data);
      } else if (parsed.type === 'exec-resize') {
        // xterm resize — some clients send this; ignore gracefully if exec doesn't support it
      }
    } catch {
      // raw data
      stdin.push(data);
    }
  });

  ws.on('close', () => {
    stdin.push(null);
    stdout.destroy();
    stderr.destroy();
    if (execWs && (execWs as any).readyState === WebSocket.OPEN) {
      (execWs as any).close();
    }
  });
}

// Resource watch handler
async function handleResourceWatch(ws: AuthenticatedSocket, msg: any) {
  const { clusterId, namespace, resourceType } = msg;
  const clients = await getK8sClient(clusterId);
  const watch = new k8s.Watch(clients.kc);

  const pathMap: Record<string, string> = {
    deployments: namespace ? `/apis/apps/v1/namespaces/${namespace}/deployments` : '/apis/apps/v1/deployments',
    pods: namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods',
    services: namespace ? `/api/v1/namespaces/${namespace}/services` : '/api/v1/services',
    configmaps: namespace ? `/api/v1/namespaces/${namespace}/configmaps` : '/api/v1/configmaps',
    ingresses: namespace ? `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses` : '/apis/networking.k8s.io/v1/ingresses',
  };

  const path = pathMap[resourceType];
  if (!path) {
    ws.send(JSON.stringify({ type: 'error', message: `Unsupported resource type: ${resourceType}` }));
    return;
  }

  const watchReq = await watch.watch(path, {}, (phase, obj) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resource-watch', phase, resourceType, data: obj }));
    }
  }, (err) => {
    if (err) ws.send(JSON.stringify({ type: 'error', message: err.message }));
  });

  ws.on('close', () => watchReq.abort());
}

// Periodic health check for all clusters (60s interval)
async function runHealthChecks() {
  const allClusters = await db.select().from(clustersTable);
  for (const cluster of allClusters) {
    try {
      const clients = await getK8sClient(cluster.id);
      const versionApi = clients.kc.makeApiClient(k8s.VersionApi);
      await versionApi.getCode();
      await db.update(clustersTable).set({
        status: 'connected',
        lastHealthCheckAt: new Date(),
      }).where(eq(clustersTable.id, cluster.id));
    } catch {
      await db.update(clustersTable).set({
        status: 'error',
        lastHealthCheckAt: new Date(),
      }).where(eq(clustersTable.id, cluster.id));
      invalidateClient(cluster.id);
    }
  }
}

setInterval(runHealthChecks, 60000);
runHealthChecks(); // Run immediately on startup

// Periodic session cleanup (every hour)
setInterval(async () => {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  console.log('Cleaned up expired sessions');
}, 60 * 60 * 1000);

console.log(`WebSocket server running on port ${PORT}`);
