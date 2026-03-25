'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Select } from 'antd';

interface Props {
  clusterId: string;
  namespace: string;
  podName: string;
  containers: string[];
}

export default function PodLogViewer({ clusterId, namespace, podName, containers }: Props) {
  const [container, setContainer] = useState(containers[0]);
  const [logs, setLogs] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;

    const init = async () => {
      // Fetch a WS token from the API (since session cookie is HttpOnly)
      const tokenRes = await fetch('/api/auth/me');
      const tokenData = await tokenRes.json();
      ws = new WebSocket(`${process.env.NEXT_PUBLIC_WS_URL}?token=${tokenData.wsToken}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws!.send(JSON.stringify({
          type: 'subscribe-logs',
          clusterId,
          namespace,
          podName,
          container,
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'log') {
          setLogs((prev) => [...prev.slice(-1000), msg.data]);
        }
      };
    };

    init();

    return () => {
      if (ws) ws.close();
      else if (wsRef.current) wsRef.current.close();
    };
  }, [clusterId, namespace, podName, container]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <Card
      title="日志"
      extra={
        <Select value={container} onChange={setContainer} style={{ width: 200 }}>
          {containers.map((c) => <Select.Option key={c} value={c}>{c}</Select.Option>)}
        </Select>
      }
    >
      <pre
        ref={logRef}
        style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: 16,
          borderRadius: 4,
          height: 500,
          overflow: 'auto',
          fontSize: 12,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
        }}
      >
        {logs.join('')}
      </pre>
    </Card>
  );
}
