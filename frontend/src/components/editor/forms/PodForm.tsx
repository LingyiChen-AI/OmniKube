import { Card, Form, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ContainersSection from './ContainersSection';
import ImagePullSecretsField from './ImagePullSecretsField';
import KeyValueEditor, { recordToRows, rowsToRecord } from '../KeyValueEditor';

const RESTART_POLICIES = ['Always', 'OnFailure', 'Never'];

/** Bare Pod editor: labels, restart policy and the container list. */
export default function PodForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const spec = draft.spec || {};
  const ns = draft.metadata?.namespace || 'default';
  const containers = (spec.containers as any[]) || [];
  const volumes = (spec.volumes as any[]) || [];
  const setSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => { d.spec = d.spec || {}; mut(d.spec); }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.general')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.labels')} style={{ marginBottom: 0 }}>
            <KeyValueEditor
              seedEmpty
              rows={recordToRows(draft.metadata?.labels)}
              emptyHint={t('editor.labelsEmpty')}
              onChange={(rows) => onChange(update(draft, (d) => {
                d.metadata = d.metadata || {};
                d.metadata.labels = rowsToRecord(rows);
              }))}
            />
          </Form.Item>
        </Form>
      </Card>

      <ContainersSection
        containers={containers}
        volumes={volumes}
        namespace={ns}
        headerExtra={
          <>
            <Form.Item label={t('editor.restartPolicy')} style={{ marginBottom: 0, flex: '1 1 0', minWidth: 150 }}>
              <Select
                style={{ width: '100%' }}
                value={spec.restartPolicy || 'Always'}
                options={RESTART_POLICIES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setSpec((s) => { s.restartPolicy = v; })}
              />
            </Form.Item>
            <ImagePullSecretsField
              namespace={ns}
              style={{ flex: '1 1 0', minWidth: 150 }}
              value={spec.imagePullSecrets}
              onChange={(list) => setSpec((s) => { s.imagePullSecrets = list.length ? list : undefined; })}
            />
          </>
        }
        onChange={(cs, vs) => setSpec((s) => {
          s.containers = cs;
          s.volumes = vs.length ? vs : undefined;
        })}
      />
    </div>
  );
}
