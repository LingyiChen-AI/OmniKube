/**
 * Direct K8s exec WebSocket implementation.
 * Bypasses @kubernetes/client-node's broken stream-based Exec for tty mode.
 */
import WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { getK8sClient } from './client-manager';

interface ExecOptions {
  clusterId: string;
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onClose: () => void;
  onError: (err: string) => void;
}

interface ExecConnection {
  sendStdin: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  close: () => void;
}

export async function connectExec(opts: ExecOptions): Promise<ExecConnection> {
  const clients = await getK8sClient(opts.clusterId);
  const kc = clients.kc;

  const cluster = kc.getCurrentCluster();
  const user = kc.getCurrentUser();
  if (!cluster) throw new Error('No cluster configured');

  // Build exec URL
  const serverUrl = cluster.server.replace(/\/$/, '');
  const params = new URLSearchParams();
  for (const cmd of opts.command) {
    params.append('command', cmd);
  }
  if (opts.container) params.append('container', opts.container);
  params.append('stdin', 'true');
  params.append('stdout', 'true');
  params.append('stderr', 'true');
  params.append('tty', 'true');

  const execUrl = `${serverUrl}/api/v1/namespaces/${opts.namespace}/pods/${opts.podName}/exec?${params.toString()}`;
  const wsUrl = execUrl.replace(/^http/, 'ws');

  // Build WebSocket options with auth
  const wsOpts: WebSocket.ClientOptions = {
    headers: {},
    rejectUnauthorized: false,
  };

  // Apply auth from kubeconfig
  const reqOpts: any = {};
  await kc.applyToHTTPSOptions(reqOpts);

  if (reqOpts.headers?.Authorization) {
    (wsOpts.headers as Record<string, string>)['Authorization'] = reqOpts.headers.Authorization;
  }
  if (user && (user as any).token) {
    (wsOpts.headers as Record<string, string>)['Authorization'] = `Bearer ${(user as any).token}`;
  }
  if (reqOpts.cert) wsOpts.cert = reqOpts.cert;
  if (reqOpts.key) wsOpts.key = reqOpts.key;
  if (reqOpts.ca) {
    wsOpts.ca = reqOpts.ca;
    wsOpts.rejectUnauthorized = true;
  }

  console.log('[exec] Connecting to:', wsUrl.substring(0, 80) + '...');
  console.log('[exec] Auth header:', !!(wsOpts.headers as any)?.Authorization);
  console.log('[exec] Client cert:', !!wsOpts.cert);

  // Connect with v4 channel protocol
  const k8sWs = new WebSocket(wsUrl, ['v4.channel.k8s.io'], wsOpts);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      k8sWs.close();
      reject(new Error('K8s exec 连接超时'));
    }, 10000);

    k8sWs.on('open', () => {
      clearTimeout(timeout);
      console.log('[exec] Connected! Protocol:', k8sWs.protocol);

      resolve({
        sendStdin(data: string) {
          if (k8sWs.readyState === WebSocket.OPEN) {
            const buf = Buffer.from(data, 'utf8');
            const frame = Buffer.alloc(buf.length + 1);
            frame.writeUInt8(0, 0); // channel 0 = stdin
            buf.copy(frame, 1);
            k8sWs.send(frame);
          }
        },
        sendResize(cols: number, rows: number) {
          if (k8sWs.readyState === WebSocket.OPEN) {
            const msg = JSON.stringify({ Width: cols, Height: rows });
            const buf = Buffer.from(msg, 'utf8');
            const frame = Buffer.alloc(buf.length + 1);
            frame.writeUInt8(4, 0); // channel 4 = resize
            buf.copy(frame, 1);
            k8sWs.send(frame);
          }
        },
        close() {
          try { k8sWs.close(); } catch {}
        },
      });
    });

    k8sWs.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as ArrayBuffer);
      if (data.length < 2) return;
      const channel = data[0];
      const content = data.slice(1).toString('utf8');
      if (channel === 1) opts.onStdout(content);
      else if (channel === 2) opts.onStderr(content);
      // channel 3 = status, channel 4 = resize
    });

    k8sWs.on('close', () => {
      clearTimeout(timeout);
      opts.onClose();
    });

    k8sWs.on('error', (err: Error) => {
      clearTimeout(timeout);
      console.error('[exec] WS error:', err.message);
      opts.onError(err.message);
      reject(err);
    });
  });
}
