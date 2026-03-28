'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Modal, Select, Space, Button, Tag, Switch } from 'antd';
import { ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { request } from '@/lib/request';

interface Props {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  namespace: string;
  podName: string;
  containers: string[];
}

export default function PodLogViewer({ open, onClose, clusterId, namespace, podName, containers }: Props) {
  const [container, setContainer] = useState(containers[0] || '');
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logsRef = useRef('');

  const scrollToBottom = useCallback(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [autoScroll]);

  const cleanupWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStreaming(false);
  }, []);

  const startStreaming = useCallback(async (c: string) => {
    cleanupWs();
    setLoading(true);
    setLogs('');
    logsRef.current = '';

    // Fetch initial logs via REST first
    try {
      const params = new URLSearchParams({ tailLines: '200' });
      if (c) params.set('container', c);
      const res = await request(`/api/k8s/${clusterId}/logs/${namespace}/${podName}?${params.toString()}`);
      if (res.ok) {
        const text = await res.text();
        logsRef.current = text;
        setLogs(text);
      }
    } catch {}
    setLoading(false);

    // Then connect WebSocket for live tail
    let wsToken: string;
    try {
      const tokenRes = await request('/api/auth/me', { credentials: 'include' });
      if (!tokenRes.ok) return;
      const tokenData = await tokenRes.json();
      wsToken = tokenData.wsToken;
      if (!wsToken) return;
    } catch {
      return;
    }

    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!wsUrl) return;

    try {
      const ws = new WebSocket(`${wsUrl}?token=${wsToken}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStreaming(true);
        ws.send(JSON.stringify({
          type: 'subscribe-logs',
          clusterId,
          namespace,
          podName,
          container: c,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'log') {
            logsRef.current += msg.data;
            // Limit buffer to avoid memory issues
            if (logsRef.current.length > 500000) {
              logsRef.current = logsRef.current.slice(-400000);
            }
            setLogs(logsRef.current);
          } else if (msg.type === 'error') {
            logsRef.current += `\n[Error] ${msg.message}\n`;
            setLogs(logsRef.current);
          }
        } catch {}
      };

      ws.onclose = () => {
        setStreaming(false);
      };

      ws.onerror = () => {
        setStreaming(false);
      };
    } catch {}
  }, [clusterId, namespace, podName, cleanupWs]);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  useEffect(() => {
    if (open && containers.length > 0) {
      const c = containers[0];
      setContainer(c);
      startStreaming(c);
    }
    return cleanupWs;
  }, [open, podName, namespace, clusterId]);

  const handleContainerChange = (c: string) => {
    setContainer(c);
    startStreaming(c);
  };

  return (
    <Modal
      title={
        <Space>
          <span>日志 — {podName}</span>
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
          <Tag color={streaming ? 'green' : 'default'}>
            {streaming ? '实时' : '已断开'}
          </Tag>
          <Switch
            checkedChildren="自动滚动"
            unCheckedChildren="自动滚动"
            checked={autoScroll}
            onChange={setAutoScroll}
            size="small"
          />
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => startStreaming(container)}
            loading={loading}
          >
            重连
          </Button>
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnHidden
      styles={{ body: { padding: 0 } }}
    >
      <pre
        ref={logRef}
        style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: 16,
          margin: 0,
          borderRadius: '0 0 8px 8px',
          height: 520,
          overflow: 'auto',
          fontSize: 12,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {logs || (loading ? '加载中...' : '(无日志)')}
      </pre>
    </Modal>
  );
}
