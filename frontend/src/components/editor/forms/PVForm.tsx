import { Card, Form, Input, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ResourceSelect from './ResourceSelect';

const ACCESS_MODES = ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod'];
const VOLUME_MODES = ['Filesystem', 'Block'];
const RECLAIM_POLICIES = ['Retain', 'Delete', 'Recycle'];

/**
 * PersistentVolume editor (cluster-scoped): capacity, access modes, reclaim
 * policy, volume mode, storage class and a simple hostPath source. Advanced
 * volume sources (NFS, CSI, …) can still be authored in YAML.
 */
export default function PVForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const spec = draft.spec || {};
  const capacity = spec.capacity?.storage ?? '';
  const hostPath = spec.hostPath?.path ?? '';

  const setSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      mut(d.spec);
    }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} namespaced={false} creating={creating} />

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
            <Form.Item label={t('editor.capacity')} style={{ marginBottom: 12 }}>
              <Input
                style={{ width: 160 }}
                value={capacity}
                placeholder="10Gi"
                onChange={(e) => setSpec((s) => {
                  s.capacity = s.capacity || {};
                  s.capacity.storage = e.target.value;
                })}
              />
            </Form.Item>
            <Form.Item label={t('editor.volumeMode')} style={{ marginBottom: 12 }}>
              <Select
                style={{ width: 170 }}
                value={spec.volumeMode || 'Filesystem'}
                options={VOLUME_MODES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setSpec((s) => { s.volumeMode = v; })}
              />
            </Form.Item>
            <Form.Item label={t('editor.reclaimPolicy')} style={{ marginBottom: 12 }}>
              <Select
                style={{ width: 170 }}
                value={spec.persistentVolumeReclaimPolicy || 'Retain'}
                options={RECLAIM_POLICIES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setSpec((s) => { s.persistentVolumeReclaimPolicy = v; })}
              />
            </Form.Item>
          </div>
          <Form.Item label={t('editor.storageClass')} style={{ marginBottom: 12 }}>
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
          <Form.Item label={t('editor.hostPath')} style={{ marginBottom: 0 }}>
            <Input
              style={{ width: 360 }}
              value={hostPath}
              placeholder="/mnt/data"
              onChange={(e) => setSpec((s) => {
                const p = e.target.value;
                if (p) s.hostPath = { ...(s.hostPath || {}), path: p };
                else delete s.hostPath;
              })}
            />
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
