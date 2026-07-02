import { Button, Input, InputNumber, Select, Space, Typography, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

export type PortVariant = 'container' | 'service';

interface Props {
  ports: any[];
  onChange: (ports: any[]) => void;
  variant: PortVariant;
  /** Show one blank row by default when there are no ports yet. */
  seedEmpty?: boolean;
}

const PROTOCOLS = ['TCP', 'UDP', 'SCTP'];

/**
 * Edits a list of ports. For containers it exposes name/containerPort/protocol;
 * for services it adds port/targetPort/nodePort. Only the documented common
 * fields are touched — any other keys on a port object are preserved.
 */
export default function PortListEditor({ ports: propPorts, onChange, variant, seedEmpty }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  // Local state so a seeded blank row survives without being written to the
  // manifest until the user edits it (mirrors KeyValueEditor.seedEmpty).
  const [ports, setPorts] = useState<any[]>(() =>
    propPorts.length === 0 && seedEmpty ? [{ protocol: 'TCP' }] : propPorts,
  );
  const lastEmit = useRef(JSON.stringify(propPorts));
  const propKey = JSON.stringify(propPorts);
  useEffect(() => {
    if (propKey !== lastEmit.current) {
      setPorts(propPorts);
      lastEmit.current = propKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propKey]);
  const emit = (next: any[]) => {
    setPorts(next);
    lastEmit.current = JSON.stringify(next);
    onChange(next);
  };

  const setPort = (i: number, patch: Record<string, any>) => {
    emit(
      ports.map((p, idx) => {
        if (idx !== i) return p;
        const next = { ...p, ...patch };
        // Drop keys explicitly set to undefined so we don't emit nulls.
        Object.keys(patch).forEach((k) => {
          if (patch[k] === undefined || patch[k] === '') delete next[k];
        });
        return next;
      }),
    );
  };
  const removePort = (i: number) => emit(ports.filter((_, idx) => idx !== i));
  const addPort = () =>
    emit([...ports, variant === 'container' ? { containerPort: 80, protocol: 'TCP' } : { port: 80, protocol: 'TCP' }]);

  const caption = (label: string, width: number) => (
    <Text type="secondary" style={{ width, flex: '0 0 auto', fontSize: 11.5, letterSpacing: 0.2 }}>
      {label}
    </Text>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ports.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            padding: '14px 16px',
            textAlign: 'center',
            color: token.colorTextTertiary,
            fontSize: 13,
            background: token.colorFillQuaternary,
          }}
        >
          {t('editor.noPorts')}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingInline: 2 }}>
            {caption(t('editor.portName'), 120)}
            {variant === 'service' ? (
              <>
                {caption(t('editor.port'), 100)}
                {caption(t('editor.targetPort'), 110)}
                {caption(t('editor.nodePort'), 110)}
              </>
            ) : (
              caption(t('editor.containerPort'), 130)
            )}
            {caption(t('editor.protocol'), 90)}
          </div>
          {ports.map((p, i) => (
            <Space key={i} wrap align="center" size={8}>
              <Input
                placeholder={t('editor.portName')}
                value={p.name ?? ''}
                style={{ width: 120 }}
                onChange={(e) => setPort(i, { name: e.target.value })}
              />
              {variant === 'service' ? (
                <>
                  <InputNumber
                    placeholder={t('editor.port')}
                    value={p.port}
                    min={1}
                    max={65535}
                    style={{ width: 100 }}
                    onChange={(v) => setPort(i, { port: v ?? undefined })}
                  />
                  <Input
                    placeholder={t('editor.targetPort')}
                    value={p.targetPort ?? ''}
                    style={{ width: 110 }}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const num = Number(raw);
                      setPort(i, { targetPort: raw === '' ? undefined : Number.isInteger(num) && String(num) === raw ? num : raw });
                    }}
                  />
                  <InputNumber
                    placeholder={t('editor.nodePort')}
                    value={p.nodePort}
                    min={1}
                    max={65535}
                    style={{ width: 110 }}
                    onChange={(v) => setPort(i, { nodePort: v ?? undefined })}
                  />
                </>
              ) : (
                <InputNumber
                  placeholder={t('editor.containerPort')}
                  value={p.containerPort}
                  min={1}
                  max={65535}
                  style={{ width: 130 }}
                  onChange={(v) => setPort(i, { containerPort: v ?? undefined })}
                />
              )}
              <Select
                value={p.protocol ?? 'TCP'}
                style={{ width: 90 }}
                options={PROTOCOLS.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setPort(i, { protocol: v })}
              />
              <Button
                type="text"
                icon={<DeleteOutlined />}
                onClick={() => removePort(i)}
                aria-label={t('editor.remove')}
                style={{ color: token.colorTextTertiary }}
              />
            </Space>
          ))}
        </>
      )}
      <Button type="dashed" icon={<PlusOutlined />} onClick={addPort} size="small" style={{ alignSelf: 'flex-start' }}>
        {t('editor.addPort')}
      </Button>
    </div>
  );
}
