import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Space, Spin, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { publishWsUrl, type DeployItem, type PublishEvent } from '../../api/integratedDeploy';

const { Text } = Typography;

type RowPhase = 'pending' | 'running' | 'created' | 'updated' | 'failed' | 'skipped';

interface RowState {
  phase: RowPhase;
  message?: string;
}

export interface PublishDrawerProps {
  open: boolean;
  orderId: number;
  /** Already order-sorted via orderedItems — drives both display order and index matching. */
  items: DeployItem[];
  onClose: () => void;
  onDone: () => void;
}

function keyOf(kind: string, name: string): string {
  return `${kind}/${name}`;
}

export default function PublishDrawer({ open, orderId, items, onClose, onDone }: PublishDrawerProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [publishing, setPublishing] = useState(false);
  const [started, setStarted] = useState(false);
  const [doneStatus, setDoneStatus] = useState<'succeeded' | 'failed' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Reset all local state whenever the drawer opens for a (possibly new) order.
  useEffect(() => {
    if (!open) return;
    const init: Record<string, RowState> = {};
    for (const it of items) {
      init[keyOf(it.kind, it.name)] = { phase: 'pending' };
    }
    setRows(init);
    setPublishing(false);
    setStarted(false);
    setDoneStatus(null);
    setErrorMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);

  const closeSocket = () => {
    wsRef.current?.close();
    wsRef.current = null;
  };

  useEffect(() => () => closeSocket(), []);

  const applyItemEvent = (ev: PublishEvent) => {
    const kind = ev.kind ?? (typeof ev.index === 'number' ? items[ev.index]?.kind : undefined);
    const name = ev.name ?? (typeof ev.index === 'number' ? items[ev.index]?.name : undefined);
    if (!kind || !name) return;
    setRows((prev) => ({
      ...prev,
      [keyOf(kind, name)]: { phase: (ev.phase as RowPhase) ?? 'running', message: ev.message },
    }));
  };

  const startPublish = () => {
    setStarted(true);
    setPublishing(true);
    setErrorMsg(null);
    setDoneStatus(null);
    const ws = new WebSocket(publishWsUrl(orderId));
    wsRef.current = ws;
    ws.onmessage = (evt) => {
      let ev: PublishEvent;
      try {
        ev = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (ev.type === 'item') {
        applyItemEvent(ev);
      } else if (ev.type === 'done') {
        setDoneStatus(ev.status === 'failed' ? 'failed' : 'succeeded');
        setPublishing(false);
        onDone();
      } else if (ev.type === 'error') {
        setErrorMsg(ev.message || t('integratedDeploy.publishGenericError'));
        setPublishing(false);
      }
    };
    ws.onerror = () => {
      // onclose fires right after in browsers; let it decide the final state.
    };
    ws.onclose = () => {
      wsRef.current = null;
      setPublishing((wasPublishing) => {
        if (wasPublishing) {
          setErrorMsg((prevErr) => prevErr ?? t('integratedDeploy.publishGenericError'));
        }
        return false;
      });
    };
  };

  const handleClose = () => {
    closeSocket();
    onClose();
  };

  const phaseTag = (phase: RowPhase, message?: string) => {
    switch (phase) {
      case 'pending':
        return <Tag>{t('integratedDeploy.pending')}</Tag>;
      case 'running':
        return (
          <Space size={6}>
            <Spin size="small" />
            <Text type="secondary">{t('integratedDeploy.publishing')}</Text>
          </Space>
        );
      case 'created':
        return <Tag color="success">{t('integratedDeploy.phaseCreated')}</Tag>;
      case 'updated':
        return <Tag color="processing">{t('integratedDeploy.phaseUpdated')}</Tag>;
      case 'failed':
        return (
          <Space size={6}>
            <Tag color="error">{t('integratedDeploy.phaseFailed')}</Tag>
            {message && <Text type="danger">{message}</Text>}
          </Space>
        );
      case 'skipped':
        return <Tag>{t('integratedDeploy.phaseSkipped')}</Tag>;
      default:
        return null;
    }
  };

  return (
    <Drawer
      title={t('integratedDeploy.publish')}
      open={open}
      width="min(680px, 92vw)"
      onClose={handleClose}
      destroyOnHidden
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          {doneStatus ? (
            <Button onClick={handleClose}>{t('common.close')}</Button>
          ) : (
            <Button type="primary" loading={publishing} disabled={started && publishing} onClick={startPublish}>
              {t('integratedDeploy.confirmPublish')}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {items.map((it) => {
          const row = rows[keyOf(it.kind, it.name)] ?? { phase: 'pending' as RowPhase };
          return (
            <div
              key={keyOf(it.kind, it.name)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
            >
              <Space size={6}>
                <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{it.kind}</Tag>
                <Text>{it.name}</Text>
              </Space>
              {phaseTag(row.phase, row.message)}
            </div>
          );
        })}

        {doneStatus && (
          <Alert
            type={doneStatus === 'succeeded' ? 'success' : 'error'}
            showIcon
            message={
              doneStatus === 'succeeded'
                ? t('integratedDeploy.statusSucceeded')
                : t('integratedDeploy.statusFailed')
            }
          />
        )}
        {errorMsg && <Alert type="error" showIcon message={errorMsg} />}
      </Space>
    </Drawer>
  );
}
