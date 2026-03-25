'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Select, Space, Alert } from 'antd';

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
  };

  const initTerminal = async (c: string) => {
    if (!termRef.current) return;
    setError(null);

    // Dynamically import xterm to avoid SSR issues
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    await import('@xterm/xterm/css/xterm.css');

    // Dispose previous terminal
    if (xtermRef.current) {
      xtermRef.current.dispose();
    }

    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
      },
      fontFamily: 'monospace',
      fontSize: 13,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Fetch WS token
    let wsToken: string;
    try {
      const tokenRes = await fetch('/api/auth/me');
      const tokenData = await tokenRes.json();
      wsToken = tokenData.wsToken;
    } catch {
      setError('无法获取认证令牌');
      return;
    }

    const wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}?token=${wsToken}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'subscribe-exec',
        clusterId,
        namespace,
        podName,
        container: c,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'exec-output') {
          term.write(msg.data);
        } else if (msg.type === 'error') {
          setError(msg.message);
        }
      } catch {
        // Raw data
        term.write(event.data);
      }
    };

    ws.onerror = () => {
      setError('WebSocket 连接失败');
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[连接已关闭]\x1b[0m\r\n');
    };

    // Send keyboard input to server
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-input', data }));
      }
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exec-resize', cols, rows }));
      }
    });
  };

  useEffect(() => {
    if (open) {
      const c = containers[0] || '';
      setContainer(c);
      initTerminal(c);
    } else {
      cleanup();
    }
    return cleanup;
  }, [open, podName, namespace, clusterId]);

  const handleContainerChange = (c: string) => {
    setContainer(c);
    cleanup();
    initTerminal(c);
  };

  return (
    <Modal
      title={
        <Space>
          <span>终端 — {podName}</span>
          {containers.length > 1 && (
            <Select
              value={container}
              onChange={handleContainerChange}
              style={{ width: 200 }}
              size="small"
            >
              {containers.map((c) => (
                <Select.Option key={c} value={c}>{c}</Select.Option>
              ))}
            </Select>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnHidden
      styles={{ body: { padding: 0 } }}
    >
      {error && (
        <Alert message={error} type="error" style={{ margin: '8px 16px' }} />
      )}
      <div
        ref={termRef}
        style={{
          background: '#1e1e1e',
          padding: 8,
          borderRadius: '0 0 8px 8px',
          minHeight: 480,
        }}
      />
    </Modal>
  );
}
