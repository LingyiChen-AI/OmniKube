import { Card, Form, InputNumber, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ContainersSection from './ContainersSection';
import ImagePullSecretsField from './ImagePullSecretsField';

const RESTART_POLICIES = ['Never', 'OnFailure'];

/** Job editor: completions/parallelism/backoffLimit, restart policy, containers. */
export default function JobForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const spec = draft.spec || {};
  const ns = draft.metadata?.namespace || 'default';
  const podSpec = spec.template?.spec || {};
  const containers = (podSpec.containers as any[]) || [];
  const volumes = (podSpec.volumes as any[]) || [];

  const setSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      mut(d.spec);
    }));
  const setPodSpec = (mut: (s: any) => void) =>
    setSpec((s) => {
      s.template = s.template || {};
      s.template.spec = s.template.spec || {};
      mut(s.template.spec);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.jobConfig')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Form.Item label={t('editor.completions')} style={{ marginBottom: 12 }}>
              <InputNumber
                min={1}
                value={spec.completions ?? undefined}
                onChange={(v) => setSpec((s) => { s.completions = v ?? undefined; })}
              />
            </Form.Item>
            <Form.Item label={t('editor.parallelism')} style={{ marginBottom: 12 }}>
              <InputNumber
                min={1}
                value={spec.parallelism ?? undefined}
                onChange={(v) => setSpec((s) => { s.parallelism = v ?? undefined; })}
              />
            </Form.Item>
            <Form.Item label={t('editor.backoffLimit')} style={{ marginBottom: 12 }}>
              <InputNumber
                min={0}
                value={spec.backoffLimit ?? undefined}
                onChange={(v) => setSpec((s) => { s.backoffLimit = v ?? undefined; })}
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
          <>
            <Form.Item label={t('editor.restartPolicy')} style={{ marginBottom: 0, flex: '1 1 0', minWidth: 150 }}>
              <Select
                style={{ width: '100%' }}
                value={podSpec.restartPolicy || 'Never'}
                options={RESTART_POLICIES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setPodSpec((s) => { s.restartPolicy = v; })}
              />
            </Form.Item>
            <ImagePullSecretsField
              namespace={ns}
              style={{ flex: '1 1 0', minWidth: 150 }}
              value={podSpec.imagePullSecrets}
              onChange={(list) => setPodSpec((s) => {
                s.imagePullSecrets = list.length ? list : undefined;
              })}
            />
          </>
        }
        onChange={(cs, vs) => setPodSpec((s) => {
          s.containers = cs;
          s.volumes = vs.length ? vs : undefined;
        })}
      />
    </div>
  );
}
