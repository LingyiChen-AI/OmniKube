import { Card, Form, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update, decodeBase64, encodeBase64 } from '../util';
import MetaSection from './MetaSection';
import KeyValueEditor, { type KVRow } from '../KeyValueEditor';

/** Decode the base64 `data` map into display rows. */
function decodedRows(data?: Record<string, string>): KVRow[] {
  return Object.entries(data || {}).map(([key, value]) => ({ key, value: decodeBase64(value) }));
}

/**
 * Secret editor. `type` is shown read-only. Values are base64-decoded for
 * display and re-encoded back into `data` on every change; any `stringData`
 * is dropped so the two representations can't conflict.
 */
export default function SecretForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.general')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.type')} style={{ marginBottom: 0 }}>
            <Tag>{draft.type || 'Opaque'}</Tag>
          </Form.Item>
        </Form>
      </Card>

      <Card size="small" title={t('editor.data')}>
        <KeyValueEditor
          variant="block"
          codeValue
          seedEmpty
          rows={decodedRows(draft.data as Record<string, string> | undefined)}
          emptyHint={t('editor.dataEmpty')}
          valuePlaceholder={t('editor.decodedValue')}
          onChange={(rows) => onChange(update(draft, (d) => {
            const next: Record<string, string> = {};
            for (const { key, value } of rows) {
              if (key.trim() === '') continue;
              next[key] = encodeBase64(value);
            }
            d.data = next;
            delete (d as any).stringData;
          }))}
        />
      </Card>
    </div>
  );
}
