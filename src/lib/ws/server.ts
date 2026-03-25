import { WebSocketServer, WebSocket } from 'ws';
import { PassThrough } from 'stream';
import { db } from '@/lib/db';
import { sessions, users, userRoleBindings, rolePermissions, clusters as clustersTable } from '@/lib/db/schema';
import { eq, and, gt, lt } from 'drizzle-orm';
import { checkPermission, type RoleBinding } from '@/lib/rbac/check';
import { getK8sClient, invalidateClient } from '@/lib/k8s/client-manager';
import * as k8s from '@kubernetes/client-node';

let started = false;

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

async function loadUserBindings(userId: string): Promise<RoleBinding[]> {
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

async function handleExec(ws: AuthenticatedSocket, msg: any) {
  const { clusterId, namespace, podName, container } = msg;

  try {
    const clients = await getK8sClient(clusterId);
    const kc = clients.kc;

    // Build the exec WebSocket URL directly
    const cluster = kc.getCurrentCluster();
    const user = kc.getCurrentUser();
    if (!cluster || !user) throw new Error('No cluster/user configured');

    const cmd = encodeURIComponent('/bin/sh');
    const cmdArgs = ['-c', `TERM=xterm-256color; export TERM; export PS1='\\033[01;32mroot@${podName}\\033[00m:\\033[01;34m\\w\\033[00m\\$ '; [ -x /bin/bash ] && exec /bin/bash --norc || exec /bin/sh`];
    const cmdQuery = cmdArgs.map(a => `command=${encodeURIComponent(a)}`).join('&');
    const containerParam = container ? `&container=${encodeURIComponent(container)}` : '';

    const serverUrl = cluster.server.replace(/\/$/, '');
    const execPath = `/api/v1/namespaces/${namespace}/pods/${podName}/exec?command=${cmd}&${cmdQuery}${containerParam}&stdin=true&stdout=true&stderr=true&tty=true`;

    // Convert to WebSocket URL
    const wsUrl = serverUrl.replace(/^http/, 'ws') + execPath;

    // Get auth options
    const opts: any = {};
    await kc.applyToHTTPSOptions(opts);

    // Connect directly to K8s API WebSocket
    const k8sWsOpts: any = {
      headers: {} as Record<string, string>,
      rejectUnauthorized: false, // TODO: use CA cert
      protocol: 'v4.channel.k8s.io',
    };

    // Apply auth (token or client cert)
    if (user.token) {
      k8sWsOpts.headers['Authorization'] = `Bearer ${user.token}`;
    }
    if (opts.cert) k8sWsOpts.cert = opts.cert;
    if (opts.key) k8sWsOpts.key = opts.key;
    if (opts.ca) { k8sWsOpts.ca = opts.ca; k8sWsOpts.rejectUnauthorized = true; }

    const K8sWs = (await import('ws')).default;
    const k8sWs = new K8sWs(wsUrl, ['v4.channel.k8s.io'], k8sWsOpts);

    k8sWs.on('open', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-ready' }));
      }
    });

    k8sWs.on('message', (data: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // K8s exec protocol: first byte is channel number
      // 0 = stdin, 1 = stdout, 2 = stderr, 3 = status
      const channel = data[0];
      const content = data.slice(1).toString();
      if (channel === 1 || channel === 2) {
        ws.send(JSON.stringify({ type: 'exec-output', data: content }));
      } else if (channel === 3) {
        // Status/error channel
        ws.send(JSON.stringify({ type: 'exec-output', data: `\r\n\x1b[33m${content}\x1b[0m\r\n` }));
      }
    });

    k8sWs.on('error', (err: Error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `K8s exec 错误: ${err.message}` }));
      }
    });

    k8sWs.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-output', data: '\r\n\x1b[33m[会话已结束]\x1b[0m\r\n' }));
      }
    });

    // Forward client input → K8s exec stdin (channel 0)
    const messageHandler = (rawData: any) => {
      try {
        const parsed = JSON.parse(rawData.toString());
        if (parsed.type === 'exec-input' && k8sWs.readyState === K8sWs.OPEN) {
          const inputBuf = Buffer.from(parsed.data);
          const msg = Buffer.alloc(inputBuf.length + 1);
          msg.writeUInt8(0, 0); // channel 0 = stdin
          inputBuf.copy(msg, 1);
          k8sWs.send(msg);
        } else if (parsed.type === 'exec-resize' && k8sWs.readyState === K8sWs.OPEN) {
          const resizeMsg = JSON.stringify({ Width: parsed.cols, Height: parsed.rows });
          const resizeBuf = Buffer.from(resizeMsg);
          const msg = Buffer.alloc(resizeBuf.length + 1);
          msg.writeUInt8(4, 0); // channel 4 = resize
          resizeBuf.copy(msg, 1);
          k8sWs.send(msg);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on('message', messageHandler);

    ws.on('close', () => {
      ws.removeListener('message', messageHandler);
      if (k8sWs.readyState === K8sWs.OPEN) k8sWs.close();
    });

  } catch (err: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: `Exec 失败: ${err.message}` }));
    }
  }
}

async function handleMessage(ws: AuthenticatedSocket, msg: any) {
  const { type, clusterId, namespace, podName, container, resourceType } = msg;

  const resource = type === 'subscribe-logs' ? 'pods' : type === 'subscribe-exec' ? 'pods' : type === 'subscribe-events' ? 'events' : resourceType || 'pods';
  const action = type === 'subscribe-logs' ? 'logs' : type === 'subscribe-exec' ? 'exec' : 'get';

  if (!checkPermission(ws.bindings || [], { clusterId, namespace: namespace || '*', resource, action })) {
    ws.send(JSON.stringify({ type: 'error', message: '权限不足' }));
    return;
  }

  if (type === 'subscribe-exec') {
    await handleExec(ws, msg);
    return;
  }

  if (type === 'subscribe-logs') {
    try {
      const clients = await getK8sClient(clusterId);
      const logStream = new k8s.Log(clients.kc);
      const passThrough = new PassThrough();

      passThrough.on('data', (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'log', data: chunk.toString() }));
        }
      });

      const abortController = await logStream.log(namespace, podName, container, passThrough, {
        follow: true,
        tailLines: 100,
      });

      ws.on('close', () => {
        abortController.abort();
        passThrough.destroy();
      });
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: `日志获取失败: ${err.message}` }));
    }
    return;
  }

  if (type === 'subscribe-events') {
    try {
      const clients = await getK8sClient(clusterId);
      const watch = new k8s.Watch(clients.kc);
      const path = namespace ? `/api/v1/namespaces/${namespace}/events` : '/api/v1/events';
      const watchReq = await watch.watch(path, {}, (phase, obj) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'event', phase, data: obj }));
        }
      }, (err) => {
        if (err && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: err.message }));
      });
      ws.on('close', () => watchReq.abort());
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  }
}

async function runHealthChecks() {
  try {
    const allClusters = await db.select().from(clustersTable);
    for (const cluster of allClusters) {
      try {
        const clients = await getK8sClient(cluster.id);
        const versionApi = clients.kc.makeApiClient(k8s.VersionApi);
        await versionApi.getCode();
        await db.update(clustersTable).set({ status: 'connected', lastHealthCheckAt: new Date() }).where(eq(clustersTable.id, cluster.id));
      } catch {
        await db.update(clustersTable).set({ status: 'error', lastHealthCheckAt: new Date() }).where(eq(clustersTable.id, cluster.id));
        invalidateClient(cluster.id);
      }
    }
  } catch {
    // DB connection might not be ready yet
  }
}

export function startWsServer() {
  if (started) return;
  started = true;

  const port = parseInt(process.env.WS_PORT || '3001');
  const wss = new WebSocketServer({ port });

  wss.on('connection', async (ws: AuthenticatedSocket, req) => {
    const url = new URL(req.url || '', `http://localhost:${port}`);
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
    ws.bindings = await loadUserBindings(user.id);

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleMessage(ws, msg);
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => clearInterval(heartbeat));
  });

  // Health checks every 60s
  setInterval(runHealthChecks, 60000);
  setTimeout(runHealthChecks, 5000); // Wait a bit for DB to be ready

  // Session cleanup every hour
  setInterval(async () => {
    try {
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    } catch {}
  }, 60 * 60 * 1000);

  console.log(`WebSocket server running on port ${port}`);
}
