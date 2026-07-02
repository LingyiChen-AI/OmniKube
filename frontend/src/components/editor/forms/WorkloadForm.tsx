import { Card, Form, InputNumber, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ContainersSection from './ContainersSection';
import ImagePullSecretsField from './ImagePullSecretsField';
import KeyValueEditor, { recordToRows, rowsToRecord } from '../KeyValueEditor';

/** Deployment / StatefulSet / DaemonSet. DaemonSet hides the replicas field. */
export default function WorkloadForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const kind = draft.kind || '';
  const showReplicas = kind !== 'DaemonSet';
  const spec = draft.spec || {};
  const ns = draft.metadata?.namespace || 'default';
  const containers = (spec.template?.spec?.containers as any[]) || [];
  const volumes = (spec.template?.spec?.volumes as any[]) || [];
  const setPodSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      d.spec.template = d.spec.template || {};
      d.spec.template.spec = d.spec.template.spec || {};
      mut(d.spec.template.spec);
    }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection
        draft={draft}
        onChange={onChange}
        creating={creating}
        extra={
          showReplicas && (
            <Form.Item label={t('editor.replicas')} style={{ marginBottom: 0, flex: '1 1 0', minWidth: 180 }}>
              <InputNumber
                min={0}
                style={{ width: '100%' }}
                value={spec.replicas ?? 0}
                onChange={(v) => onChange(update(draft, (d) => {
                  d.spec = d.spec || {};
                  d.spec.replicas = v ?? 0;
                }))}
              />
            </Form.Item>
          )
        }
      />

      <Card size="small" title={t('editor.general')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item
              label={t('editor.labels')}
              style={{ marginBottom: 0, flex: '1 1 320px', minWidth: 0 }}
            >
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
            {/* dashed vertical divider between the two label columns */}
            <div
              style={{
                alignSelf: 'stretch',
                borderLeft: `1px dashed ${token.colorBorder}`,
                flex: '0 0 auto',
              }}
            />
            <Form.Item
              label={t('editor.podLabels')}
              style={{ marginBottom: 0, flex: '1 1 320px', minWidth: 0 }}
            >
              <KeyValueEditor
                seedEmpty
                rows={recordToRows(spec.template?.metadata?.labels)}
                emptyHint={t('editor.labelsEmpty')}
                onChange={(rows) => onChange(update(draft, (d) => {
                  d.spec = d.spec || {};
                  d.spec.template = d.spec.template || {};
                  d.spec.template.metadata = d.spec.template.metadata || {};
                  d.spec.template.metadata.labels = rowsToRecord(rows);
                }))}
              />
            </Form.Item>
          </div>
        </Form>
      </Card>

      <ContainersSection
        containers={containers}
        volumes={volumes}
        namespace={ns}
        headerExtra={
          <ImagePullSecretsField
            namespace={ns}
            style={{ flex: '1 1 0', minWidth: 150 }}
            value={spec.template?.spec?.imagePullSecrets}
            onChange={(list) => setPodSpec((s) => { s.imagePullSecrets = list.length ? list : undefined; })}
          />
        }
        onChange={(cs, vs) => setPodSpec((s) => {
          s.containers = cs;
          s.volumes = vs.length ? vs : undefined;
        })}
      />
    </div>
  );
}
