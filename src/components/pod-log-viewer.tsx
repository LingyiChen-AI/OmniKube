'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Select, Space, Spin, Typography, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

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
  const logRef = useRef<HTMLPreElement>(null);

  const fetchLogs = async (c: string) => {
    if (!clusterId || !namespace || !podName) return;
    setLoading(true);
    setLogs('');
    try {
      const params = new URLSearchParams({ tailLines: '500' });
      if (c) params.set('container', c);
      const res = await fetch(`/api/k8s/${clusterId}/logs/${namespace}/${podName}?${params.toString()}`);
      if (res.ok) {
        const text = await res.text();
        setLogs(text);
      } else {
        const d = await res.json().catch(() => ({}));
        setLogs(`Error: ${d.error || res.statusText}`);
      }
    } catch (err: any) {
      setLogs(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && containers.length > 0) {
      const c = containers[0];
      setContainer(c);
      fetchLogs(c);
    }
  }, [open, podName, namespace, clusterId]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const handleContainerChange = (c: string) => {
    setContainer(c);
    fetchLogs(c);
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
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => fetchLogs(container)}
            loading={loading}
          >
            刷新
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
      <Spin spinning={loading}>
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
          {logs || (loading ? '' : '(无日志)')}
        </pre>
      </Spin>
    </Modal>
  );
}
