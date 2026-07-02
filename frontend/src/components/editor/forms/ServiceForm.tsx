import { useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Button, Card, Form, Select, Space, Typography, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import PortListEditor from '../PortListEditor';
import MetaSection from './MetaSection';
import { recordToRows, rowsToRecord, type KVRow } from '../KeyValueEditor';
import { useClusterList } from './useClusterList';
import type { K8sObject } from '../../../api/resource';

const { Text } = Typography;
const TYPES = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'];

/** key → set of values, gathered from the deployments' pod/selector labels. */
type LabelIndex = Record<string, Set<string>>;

function buildLabelIndex(deployments: K8sObject[]): LabelIndex {
  const idx: LabelIndex = {};
  for (const d of deployments) {
    const sources = [d.spec?.selector?.matchLabels, d.spec?.template?.metadata?.labels];
    for (const m of sources) {
      if (!m || typeof m !== 'object') continue;
      for (const [k, v] of Object.entries(m as Record<string, string>)) {
        (idx[k] ??= new Set()).add(String(v));
      }
    }
  }
  return idx;
}

/**
 * Service selector editor: each row is a label key/value pair chosen from the
 * labels that real workloads in the namespace actually carry (both keys and
 * values are dropdowns, still free-text). Local row state keeps half-filled
 * rows alive while the user is picking.
 */
function SelectorEditor({
  selector,
  onChange,
  labelIndex,
}: {
  selector?: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  labelIndex: LabelIndex;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<KVRow[]>(() => {
    const seeded = recordToRows(selector);
    // Default to one blank row so the user can fill it without clicking "Add".
    return seeded.length ? seeded : [{ key: '', value: '' }];
  });

  // Re-seed when the selector changes externally (e.g. a YAML round-trip) to
  // something we didn't just emit ourselves.
  const selKey = JSON.stringify(selector || {});
  const lastPushed = useRef(JSON.stringify(rowsToRecord(recordToRows(selector))));
  useEffect(() => {
    if (selKey !== lastPushed.current) {
      setRows(recordToRows(selector));
      lastPushed.current = selKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const push = (next: KVRow[]) => {
    setRows(next);
    const rec = rowsToRecord(next);
    lastPushed.current = JSON.stringify(rec);
    onChange(rec);
  };
  const setAt = (i: number, patch: Partial<KVRow>) =>
    push(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const keyOptions = Object.keys(labelIndex).sort().map((k) => ({ value: k }));
  const valueOptions = (key: string) =>
    [...(labelIndex[key] ?? [])].sort().map((v) => ({ value: v }));
  const filter = (input: string, opt?: { value?: string | number }) =>
    String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', maxWidth: 620 }}>
          <Space.Compact style={{ width: '100%' }}>
            <AutoComplete
              style={{ width: '40%', fontFamily: token.fontFamilyCode }}
              value={row.key}
              placeholder={t('editor.key')}
              options={keyOptions}
              filterOption={filter}
              onChange={(k) => setAt(i, { key: k })}
            />
            <AutoComplete
              style={{ width: '60%', fontFamily: token.fontFamilyCode }}
              value={row.value}
              placeholder={t('editor.value')}
              options={valueOptions(row.key)}
              filterOption={filter}
              onChange={(v) => setAt(i, { value: v })}
            />
          </Space.Compact>
          <Button
            type="text"
            icon={<DeleteOutlined />}
            style={{ flex: '0 0 auto', color: token.colorTextTertiary }}
            aria-label={t('editor.remove')}
            onClick={() => push(rows.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}
      {rows.length === 0 && <Text type="secondary">{t('editor.selectorEmpty')}</Text>}
      <div>
        <Button
          type="dashed"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => push([...rows, { key: '', value: '' }])}
        >
          {t('editor.addRow')}
        </Button>
      </div>
    </div>
  );
}

export default function ServiceForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const spec = draft.spec || {};
  const ns = draft.metadata?.namespace || 'default';
  // Deployments in this namespace, to source selector label options.
  const { items: deployments } = useClusterList('deployments', ns);
  const labelIndex = useMemo(() => buildLabelIndex(deployments), [deployments]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.general')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.type')} style={{ marginBottom: 12 }}>
            <Select
              style={{ width: 220 }}
              value={spec.type || 'ClusterIP'}
              options={TYPES.map((x) => ({ value: x, label: x }))}
              onChange={(v) => onChange(update(draft, (d) => {
                d.spec = d.spec || {};
                d.spec.type = v;
              }))}
            />
          </Form.Item>
          <Form.Item label={t('editor.selector')} style={{ marginBottom: 0 }}>
            <SelectorEditor
              selector={spec.selector as Record<string, string> | undefined}
              labelIndex={labelIndex}
              onChange={(sel) => onChange(update(draft, (d) => {
                d.spec = d.spec || {};
                d.spec.selector = sel;
              }))}
            />
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title={t('editor.ports')}>
        <PortListEditor
          variant="service"
          ports={(spec.ports as any[]) || []}
          onChange={(p) => onChange(update(draft, (d) => {
            d.spec = d.spec || {};
            d.spec.ports = p;
          }))}
        />
      </Card>
    </div>
  );
}
