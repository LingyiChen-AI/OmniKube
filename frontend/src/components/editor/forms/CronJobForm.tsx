import { Card, Form, Input, Select, Switch, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import MetaSection from './MetaSection';
import ContainersSection from './ContainersSection';
import ImagePullSecretsField from './ImagePullSecretsField';

const RESTART_POLICIES = ['Never', 'OnFailure'];
const CONCURRENCY = ['Allow', 'Forbid', 'Replace'];

/** CronJob editor: schedule, suspend, concurrency, restart policy, containers. */
export default function CronJobForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const spec = draft.spec || {};
  const ns = draft.metadata?.namespace || 'default';
  const podSpec = spec.jobTemplate?.spec?.template?.spec || {};
  const containers = (podSpec.containers as any[]) || [];
  const volumes = (podSpec.volumes as any[]) || [];

  const setSpec = (mut: (s: any) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      mut(d.spec);
    }));
  const setPodSpec = (mut: (s: any) => void) =>
    setSpec((s) => {
      s.jobTemplate = s.jobTemplate || {};
      s.jobTemplate.spec = s.jobTemplate.spec || {};
      s.jobTemplate.spec.template = s.jobTemplate.spec.template || {};
      s.jobTemplate.spec.template.spec = s.jobTemplate.spec.template.spec || {};
      mut(s.jobTemplate.spec.template.spec);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.scheduleConfig')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.schedule')} style={{ marginBottom: 12 }}>
            <Input
              value={spec.schedule ?? ''}
              placeholder="*/5 * * * *"
              style={{ width: 240, fontFamily: token.fontFamilyCode }}
              onChange={(e) => setSpec((s) => { s.schedule = e.target.value; })}
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Form.Item label={t('editor.concurrencyPolicy')} style={{ marginBottom: 12 }}>
              <Select
                style={{ width: 200 }}
                value={spec.concurrencyPolicy || 'Allow'}
                options={CONCURRENCY.map((x) => ({ value: x, label: x }))}
                onChange={(v) => setSpec((s) => { s.concurrencyPolicy = v; })}
              />
            </Form.Item>
            <Form.Item label={t('editor.suspend')} style={{ marginBottom: 12 }}>
              <Switch
                checked={!!spec.suspend}
                onChange={(v) => setSpec((s) => { s.suspend = v; })}
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
