import { Card } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import KeyValueEditor, { recordToRows, rowsToRecord } from '../KeyValueEditor';

export default function ConfigMapForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.data')}>
        <KeyValueEditor
          variant="block"
          codeValue
          seedEmpty
          rows={recordToRows(draft.data)}
          emptyHint={t('editor.dataEmpty')}
          onChange={(rows) => onChange(update(draft, (d) => {
            d.data = rowsToRecord(rows);
          }))}
        />
      </Card>
    </div>
  );
}
