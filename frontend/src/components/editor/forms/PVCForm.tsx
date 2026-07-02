import { Card, Form, Input, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ResourceSelect from './ResourceSelect';

const ACCESS_MODES = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];
const VOLUME_MODES = ['Filesystem', 'Block'];

/** PersistentVolumeClaim editor: access modes, storage size, class, volume mode. */
export default function PVCForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const spec = draft.spec || {};
  const storage = spec.resources?.requests?.storage ?? '';

  const setSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      mut(d.spec);
    }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.storageConfig')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.accessModes')} style={{ marginBottom: 12 }}>
            <Select
              mode="multiple"
              style={{ width: '100%', maxWidth: 420 }}
              value={(spec.accessModes as string[]) || ['ReadWriteOnce']}
              options={ACCESS_MODES.map((x) => ({ value: x, label: x }))}
              onChange={(v) => setSpec((s) => { s.accessModes = v; })}
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label={t('editor.storage')} style={{ marginBottom: 12 }}>
              <Input
                style={{ width: 160 }}
                value={storage}
                placeholder="1Gi"
                onChange={(e) => setSpec((s) => {
                  s.resources = s.resources || {};
                  s.resources.requests = s.resources.requests || {};
                  s.resources.requests.storage = e.target.value;
                })}
              />
            </Form.Item>
            <Form.Item label={t('editor.volumeMode')} style={{ marginBottom: 12 }}>
              <Select
                style={{ width: 180 }}
                value={spec.volumeMode || 'Filesystem'}
                options={VOLUME_MODES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setSpec((s) => { s.volumeMode = v; })}
              />
            </Form.Item>
          </div>
          <Form.Item label={t('editor.storageClass')} style={{ marginBottom: 0 }}>
            <ResourceSelect
              resource="storageclasses"
              value={spec.storageClassName ?? ''}
              placeholder="standard"
              style={{ width: 260 }}
              onChange={(v) => setSpec((s) => {
                s.storageClassName = v || undefined;
              })}
            />
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
