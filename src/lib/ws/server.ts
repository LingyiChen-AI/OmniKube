import { WebSocketServer, WebSocket } from 'ws';
import { PassThrough } from 'stream';
import { db } from '@/lib/db';
import { users, clusters as clustersTable, sessions } from '@/lib/db/schema';
import { eq, lt } from 'drizzle-orm';
import { checkPermission, getUserBindings, type RoleBinding } from '@/lib/rbac/check';
import { getK8sClient, invalidateClient } from '@/lib/k8s/client-manager';
import { connectExec } from '@/lib/k8s/exec';
import { verifyJwt } from '@/lib/auth/jwt';
import * as k8s from '@kubernetes/client-node';

let started = false;

const WATCH_API_GROUPS: Record<string, string> = {
  pods: '/api/v1',
  services: '/api/v1',
  configmaps: '/api/v1',
  secrets: '/api/v1',
  persistentvolumeclaims: '/api/v1',
  namespaces: '/api/v1',
  nodes: '/api/v1',
  events: '/api/v1',
  deployments: '/apis/apps/v1',
  statefulsets: '/apis/apps/v1',
  daemonsets: '/apis/apps/v1',
  replicasets: '/apis/apps/v1',
  jobs: '/apis/batch/v1',
  cronjobs: '/apis/batch/v1',
  ingresses: '/apis/networking.k8s.io/v1',
  storageclasses: '/apis/storage.k8s.io/v1',
};

const CLUSTER_SCOPED = new Set(['namespaces', 'nodes', 'storageclasses']);

function getWatchPath(kind: string, namespace?: string): string {
  const apiGroup = WATCH_API_GROUPS[kind] || '/api/v1';
  if (CLUSTER_SCOPED.has(kind) || !namespace) {
    return `${apiGroup}/${kind}`;
  }
  return `${apiGroup}/namespaces/${namespace}/${kind}`;
}

interface AuthenticatedSocket extends WebSocket {
  userId?: string;
  bindings?: RoleBinding[];
}

async function authenticate(token: string) {
  const payload = verifyJwt(token);
  if (!payload) return null;
  const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
  if (!user || !user.isActive) return null;
  return user;
}

async function loadUserBindings(userId: string): Promise<RoleBinding[]> {
  return getUserBindings(userId);
}

async function handleExec(ws: AuthenticatedSocket, msg: any) {
  const { clusterId, namespace, podName, container } = msg;
  console.log('[ws] handleExec called:', { clusterId, namespace, podName, container });
  ws.send(JSON.stringify({ type: 'exec-output', data: '\x1b[33m正在建立 K8s exec 连接...\x1b[0m\r\n' }));

  try {
    const shellCmd = `TERM=xterm-256color; export TERM; export PS1='\\033[01;32mroot@${podName}\\033[00m:\\033[01;34m\\w\\033[00m\\$ '; [ -x /bin/bash ] && exec /bin/bash --norc || exec /bin/sh`;

    console.log('[ws] Calling connectExec...');
    const conn = await connectExec({
      clusterId,
      namespace,
      podName,
      container: container || '',
      command: ['/bin/sh', '-c', shellCmd],
      onStdout(data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exec-output', data }));
        }
      },
      onStderr(data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exec-output', data }));
        }
      },
      onClose() {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exec-output', data: '\r\n\x1b[33m[会话已结束]\x1b[0m\r\n' }));
        }
      },
      onError(err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: `Exec 错误: ${err}` }));
        }
      },
    });

    // Forward browser input → K8s stdin
    const messageHandler = (rawData: any) => {
      try {
        const parsed = JSON.parse(rawData.toString());
        if (parsed.type === 'exec-input') {
          conn.sendStdin(parsed.data);
        } else if (parsed.type === 'exec-resize') {
          conn.sendResize(parsed.cols, parsed.rows);
        }
      } catch {}
    };

    console.log('[ws] connectExec succeeded, forwarding messages');
    ws.on('message', messageHandler);
    ws.on('close', () => {
      ws.removeListener('message', messageHandler);
      conn.close();
    });

  } catch (err: any) {
    console.error('[ws] handleExec error:', err.message, err.stack);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: `Exec 失败: ${err.message}` }));
    }
  }
}

async function handleMessage(ws: AuthenticatedSocket, msg: any) {
  const { type, clusterId, namespace, podName, container, resourceType } = msg;
  console.log('[ws] handleMessage:', type);

  const resource = type === 'subscribe-logs' ? 'pods' : type === 'subscribe-exec' ? 'pods' : type === 'subscribe-events' ? 'events' : type === 'subscribe-watch' ? (msg.kind || 'pods') : resourceType || 'pods';
  const action = type === 'subscribe-logs' ? 'logs' : type === 'subscribe-exec' ? 'exec' : 'list';

  if (!checkPermission(ws.bindings || [], { clusterId, namespace: namespace || '*', resource, action })) {
    console.log('[ws] Permission denied for:', { type, clusterId, namespace, resource, action });
    ws.send(JSON.stringify({ type: 'error', message: '权限不足' }));
    return;
  }
  console.log('[ws] Permission granted for:', type);

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

  if (type === 'subscribe-watch') {
    try {
      const kind = msg.kind;
      const clients = await getK8sClient(clusterId);
      const watch = new k8s.Watch(clients.kc);
      const watchPath = getWatchPath(kind, namespace);
      console.log('[ws] Starting watch:', watchPath);
      const watchReq = await watch.watch(watchPath, {}, (phase, _obj) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resource-changed', kind, phase }));
        }
      }, (err) => {
        if (err) console.error('[ws] Watch error:', err.message);
        // Auto-reconnect watch after error
        if (ws.readyState === WebSocket.OPEN) {
          setTimeout(() => handleMessage(ws, msg), 5000);
        }
      });
      ws.on('close', () => watchReq.abort());
    } catch (err: any) {
      console.error('[ws] Watch setup error:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: `Watch 失败: ${err.message}` }));
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

export function startWsServer(httpServer?: import('http').Server) {
  if (started) return;
  started = true;

  // Use noServer mode to manually handle upgrade, avoiding Next.js HMR conflicts
  const wss = new WebSocketServer({ noServer: true });

  if (httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url || '', `http://localhost:3000`);
      if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      }
      // Let other upgrade requests (e.g. Next.js HMR) pass through
    });
  } else {
    // Standalone mode fallback
    const standaloneWss = new WebSocketServer({ port: parseInt(process.env.WS_PORT || '3001') });
    standaloneWss.on('connection', (ws, req) => wss.emit('connection', ws, req));
  }

  wss.on('connection', async (ws: AuthenticatedSocket, req) => {
    // Buffer messages that arrive during authentication
    const pendingMessages: string[] = [];
    let authenticated = false;

    ws.on('message', (data) => {
      if (!authenticated) {
        pendingMessages.push(data.toString());
        return;
      }
      processMessage(ws, data.toString());
    });

    const url = new URL(req.url || '', `http://localhost:3000`);
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
    authenticated = true;
    console.log('[ws] Authenticated user:', user.username, '| buffered messages:', pendingMessages.length);

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);

    // Process any messages that arrived during authentication
    for (const msg of pendingMessages) {
      console.log('[ws] Processing buffered message:', msg.substring(0, 80));
      processMessage(ws, msg);
    }
    pendingMessages.length = 0;

    ws.on('close', () => clearInterval(heartbeat));
  });

  async function processMessage(ws: AuthenticatedSocket, data: string) {
    try {
      const msg = JSON.parse(data);
      await handleMessage(ws, msg);
    } catch (err: any) {
      console.error('[ws] processMessage error:', err.message, err.stack);
      try {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      } catch {}
    }
  }

  // Health checks every 60s
  setInterval(runHealthChecks, 60000);
  setTimeout(runHealthChecks, 5000); // Wait a bit for DB to be ready

  // Session cleanup every hour
  setInterval(async () => {
    try {
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    } catch {}
  }, 60 * 60 * 1000);

  console.log(`WebSocket server started${httpServer ? ' (attached to HTTP server at /ws)' : ''}`);
}
