'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Select, Space, Alert, Tag } from 'antd';

interface Props {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  namespace: string;
  podName: string;
  containers: string[];
}

export default function PodTerminal({ open, onClose, clusterId, namespace, podName, containers }: Props) {
  const [container, setContainer] = useState(containers[0] || '');
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);

  const cleanup = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    setConnected(false);
  };

  const initTerminal = async (c: string) => {
    if (!termRef.current) return;
    setError(null);

    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    await import('@xterm/xterm/css/xterm.css');

    if (xtermRef.current) xtermRef.current.dispose();

    const term = new Terminal({
      theme: {
        background: '#0c0c0c',
        foreground: '#cccccc',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#264f78',
        black: '#0c0c0c',
        red: '#c50f1f',
        green: '#13a10e',
        yellow: '#c19c00',
        blue: '#0037da',
        magenta: '#881798',
        cyan: '#3a96dd',
        white: '#cccccc',
        brightBlack: '#767676',
        brightRed: '#e74856',
        brightGreen: '#16c60c',
        brightYellow: '#f9f1a5',
        brightBlue: '#3b78ff',
        brightMagenta: '#b4009e',
        brightCyan: '#61d6d6',
        brightWhite: '#f2f2f2',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // Delay fit to ensure DOM is ready
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fetch WS token
    let wsToken: string;
    try {
      const tokenRes = await fetch('/api/auth/me', { credentials: 'include' });
      if (!tokenRes.ok) {
        setError('认证失败，请重新登录');
        return;
      }
      const tokenData = await tokenRes.json();
      wsToken = tokenData.wsToken;
      if (!wsToken) {
        setError('无法获取 WebSocket 令牌');
        return;
      }
    } catch (e: any) {
      setError('获取认证令牌失败: ' + (e.message || '网络错误'));
      return;
    }

    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!wsUrl) {
      setError('WebSocket 服务未配置，请重启 Next.js 服务');
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${wsUrl}?token=${wsToken}`);
    } catch {
      setError('WebSocket 连接失败');
      return;
    }
    wsRef.current = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        setError('WebSocket 连接超时');
        ws.close();
      }
    }, 8000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      setConnected(true);
      ws.send(JSON.stringify({
        type: 'subscribe-exec',
        clusterId,
        namespace,
        podName,
        container: c,
      }));

      // Send initial resize
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          ws.send(JSON.stringify({
            type: 'exec-resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'exec-output') {
          term.write(msg.data);
        } else if (msg.type === 'error') {
          setError(msg.message);
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        }
      } catch {
        term.write(event.data);
      }
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      setError('WebSocket 连接失败');
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      setConnected(false);
      term.write('\r\n\x1b[33m[连接已关闭]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-resize', cols, rows }));
      }
    });

    // Handle window resize
    const handleResize = () => {
      if (fitAddonRef.current) fitAddonRef.current.fit();
    };
    window.addEventListener('resize', handleResize);
    // Cleanup on dispose
    const origDispose = term.dispose.bind(term);
    term.dispose = () => {
      window.removeEventListener('resize', handleResize);
      origDispose();
    };
  };

  useEffect(() => {
    if (open) {
      const c = containers[0] || '';
      setContainer(c);
      // Small delay to ensure modal is rendered
      setTimeout(() => initTerminal(c), 100);
    } else {
      cleanup();
    }
    return cleanup;
  }, [open, podName, namespace, clusterId]);

  const handleContainerChange = (c: string) => {
    setContainer(c);
    cleanup();
    setTimeout(() => initTerminal(c), 100);
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'monospace' }}>
            <span style={{ color: '#16c60c' }}>root</span>
            <span style={{ color: '#cccccc' }}>@</span>
            <span style={{ color: '#3a96dd' }}>{podName}</span>
          </span>
          <Tag color={connected ? 'green' : 'default'}>{connected ? '已连接' : '未连接'}</Tag>
          {containers.length > 1 && (
            <Select
              value={container}
              onChange={handleContainerChange}
              style={{ width: 160 }}
              size="small"
              options={containers.map((c) => ({ value: c, label: c }))}
            />
          )}
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnHidden
      styles={{
        body: { padding: 0 },
        header: { background: '#1e1e1e', borderBottom: '1px solid #333', padding: '8px 16px' },
        content: { background: '#0c0c0c' },
      }}
      closable
      closeIcon={<span style={{ color: '#ccc' }}>✕</span>}
    >
      {error && (
        <Alert message={error} type="error" style={{ margin: '8px 12px', borderRadius: 4 }} />
      )}
      <div
        ref={termRef}
        style={{
          background: '#0c0c0c',
          padding: '4px 8px',
          minHeight: 500,
        }}
      />
    </Modal>
  );
}
