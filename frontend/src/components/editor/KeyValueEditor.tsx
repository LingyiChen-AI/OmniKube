import { Button, Input, Space, Tooltip, theme } from 'antd';
import {
  CodeOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FormOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeBox from './CodeBox';

export interface KVRow {
  key: string;
  value: string;
}

export type KVVariant = 'inline' | 'block';

interface Props {
  /** Current rows, in display order. */
  rows: KVRow[];
  onChange: (rows: KVRow[]) => void;
  /**
   * Layout mode:
   * - `inline` (default): a compact `key | value | delete` row with aligned
   *   columns — for labels, selectors, env vars and other short scalars.
   * - `block`: one "file card" per entry — a filename-style key in the header
   *   and a full-width code body — for ConfigMap / Secret data.
   */
  variant?: KVVariant;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyHint?: string;
  /**
   * Block mode only: render each value as a CodeBox by default (the user can
   * still collapse a single-line value to an inline field). Used by ConfigMap /
   * Secret where values are typically multi-line config/PEM content.
   */
  codeValue?: boolean;
  /** Start with one blank row when there is no data yet (create convenience). */
  seedEmpty?: boolean;
}

/**
 * Editable key/value list with two layouts (see `variant`). In `block` mode an
 * entry whose value contains newlines is always rendered as a full-width
 * CodeBox; short values render as a single-line field with an "edit as code"
 * toggle. Works on an ordered array so editing a key never reorders rows.
 */
export default function KeyValueEditor({
  rows: propRows,
  onChange,
  variant = 'inline',
  keyPlaceholder,
  valuePlaceholder,
  emptyHint,
  codeValue = false,
  seedEmpty = false,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const isBlock = variant === 'block';
  // Rows the user explicitly promoted to a code box, by index.
  const [coded, setCoded] = useState<Record<number, boolean>>({});

  // Local row state so half-filled rows (blank key) survive: the parent stores
  // the rows as a record (rowsToRecord drops blank keys), so a freshly-added
  // empty row would otherwise vanish on the next render. We only re-seed from
  // the prop when it represents data we didn't just emit ourselves.
  const [rows, setRows] = useState<KVRow[]>(() =>
    propRows.length === 0 && seedEmpty ? [{ key: '', value: '' }] : propRows,
  );
  const lastEmit = useRef(JSON.stringify(rowsToRecord(propRows)));
  const propKey = JSON.stringify(rowsToRecord(propRows));
  useEffect(() => {
    if (propKey !== lastEmit.current) {
      setRows(propRows);
      lastEmit.current = propKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propKey]);

  const emit = (next: KVRow[]) => {
    setRows(next);
    lastEmit.current = JSON.stringify(rowsToRecord(next));
    onChange(next);
  };

  const setRow = (i: number, patch: Partial<KVRow>) => {
    emit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => {
    emit(rows.filter((_, idx) => idx !== i));
    setCoded((m) => {
      const next: Record<number, boolean> = {};
      Object.entries(m).forEach(([k, v]) => {
        const n = Number(k);
        if (n < i) next[n] = v;
        else if (n > i) next[n - 1] = v;
      });
      return next;
    });
  };
  const addRow = () => emit([...rows, { key: '', value: '' }]);

  const emptyState = (
    <div
      style={{
        border: `1px dashed ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: isBlock ? '28px 16px' : '18px 16px',
        textAlign: 'center',
        color: token.colorTextTertiary,
        fontSize: 13,
        background: token.colorFillQuaternary,
      }}
    >
      {emptyHint || t('editor.dataEmpty')}
    </div>
  );

  // ---- inline mode: aligned key | value | delete rows --------------------
  if (!isBlock) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.length === 0
          ? emptyState
          : rows.map((row, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 6, alignItems: 'center', maxWidth: 620 }}
              >
                {/* key and value joined into one control so the pair reads as a unit */}
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    style={{ width: '40%', fontFamily: token.fontFamilyCode }}
                    value={row.key}
                    placeholder={keyPlaceholder || t('editor.key')}
                    onChange={(e) => setRow(i, { key: e.target.value })}
                  />
                  <Input
                    style={{ width: '60%', fontFamily: token.fontFamilyCode }}
                    value={row.value}
                    placeholder={valuePlaceholder || t('editor.value')}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                  />
                </Space.Compact>
                <Button
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => removeRow(i)}
                  aria-label={t('editor.remove')}
                  style={{ flex: '0 0 auto', color: token.colorTextTertiary }}
                />
              </div>
            ))}
        <div>
          <Button type="dashed" icon={<PlusOutlined />} onClick={addRow} size="small">
            {t('editor.addRow')}
          </Button>
        </div>
      </div>
    );
  }

  // ---- block mode: one "file card" per entry -----------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.length === 0
        ? emptyState
        : rows.map((row, i) => {
            const codeMode = (coded[i] ?? codeValue) || row.value.includes('\n');
            return (
              <div
                key={i}
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadiusLG,
                  background: token.colorBgContainer,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 6px 4px 10px',
                    background: token.colorFillQuaternary,
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <FileTextOutlined
                    style={{ color: token.colorTextTertiary, fontSize: 14, flex: '0 0 auto' }}
                  />
                  <Input
                    variant="borderless"
                    value={row.key}
                    placeholder={keyPlaceholder || t('editor.fileName')}
                    onChange={(e) => setRow(i, { key: e.target.value })}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: token.fontFamilyCode,
                      fontWeight: 600,
                      paddingInline: 4,
                    }}
                  />
                  <Tooltip title={codeMode ? t('editor.editInline') : t('editor.editAsCode')}>
                    <Button
                      type="text"
                      size="small"
                      disabled={row.value.includes('\n')}
                      icon={codeMode ? <FormOutlined /> : <CodeOutlined />}
                      onClick={() => setCoded((m) => ({ ...m, [i]: !codeMode }))}
                      aria-label={codeMode ? t('editor.editInline') : t('editor.editAsCode')}
                    />
                  </Tooltip>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeRow(i)}
                    aria-label={t('editor.remove')}
                  />
                </div>
                <div style={{ padding: 10 }}>
                  {codeMode ? (
                    <CodeBox
                      value={row.value}
                      toolbar
                      minHeight={160}
                      maxHeight={420}
                      placeholder={valuePlaceholder || t('editor.value')}
                      ariaLabel={row.key || t('editor.value')}
                      onChange={(v) => setRow(i, { value: v })}
                    />
                  ) : (
                    <Input
                      value={row.value}
                      placeholder={valuePlaceholder || t('editor.value')}
                      style={{ fontFamily: token.fontFamilyCode }}
                      onChange={(e) => setRow(i, { value: e.target.value })}
                    />
                  )}
                </div>
              </div>
            );
          })}
      <div>
        <Button
          type="dashed"
          icon={<PlusOutlined />}
          onClick={addRow}
          block
          style={{ height: 40 }}
        >
          {t('editor.addRow')}
        </Button>
      </div>
    </div>
  );
}

/** Convert an object map to ordered KV rows. */
export function recordToRows(rec?: Record<string, string>): KVRow[] {
  return Object.entries(rec || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

/** Convert KV rows back to an object map (drops blank keys, keeps last on dup). */
export function rowsToRecord(rows: KVRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    if (key.trim() === '') continue;
    out[key] = value;
  }
  return out;
}
