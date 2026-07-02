import { Button, Card, Form, Input, InputNumber, Select, Space, Typography, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { FormProps } from './types';
import { update } from '../util';
import type { K8sObject } from '../../../api/resource';
import ResourceSelect from './ResourceSelect';
import MetaSection from './MetaSection';
import { useClusterList } from './useClusterList';

const { Text } = Typography;
const PATH_TYPES = ['Prefix', 'Exact', 'ImplementationSpecific'];

function emptyPath() {
  return {
    path: '/',
    pathType: 'Prefix',
    backend: { service: { name: '', port: { number: 80 } } },
  };
}

/** Ports declared by a named Service, for the backend-port dropdown. */
function servicePorts(services: K8sObject[], name?: string): { port: number; name?: string }[] {
  if (!name) return [];
  const svc = services.find((s) => s.metadata?.name === name);
  const ports = (svc?.spec?.ports as any[]) || [];
  return ports
    .map((p) => ({ port: Number(p.port), name: p.name as string | undefined }))
    .filter((p) => Number.isFinite(p.port));
}

export default function IngressForm({ draft, onChange, creating }: FormProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const spec = draft.spec || {};
  const rules = (spec.rules as any[]) || [];
  const ns = draft.metadata?.namespace || 'default';
  // Live cluster lookups for the backend dropdowns (degrade to free text).
  const { items: services } = useClusterList('services', ns);

  const mutateRules = (fn: (rules: any[]) => void) =>
    onChange(update(draft, (d) => {
      d.spec = d.spec || {};
      d.spec.rules = (d.spec.rules as any[]) || [];
      fn(d.spec.rules);
    }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <MetaSection draft={draft} onChange={onChange} creating={creating} />

      <Card size="small" title={t('editor.general')}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Form.Item label={t('editor.ingressClass')} style={{ marginBottom: 0 }}>
            <ResourceSelect
              resource="ingressclasses"
              value={spec.ingressClassName ?? ''}
              placeholder="nginx"
              style={{ width: 260 }}
              onChange={(v) => onChange(update(draft, (d) => {
                d.spec = d.spec || {};
                if (!v) delete d.spec.ingressClassName;
                else d.spec.ingressClassName = v;
              }))}
            />
          </Form.Item>
        </Form>
      </Card>

      <Card
        size="small"
        title={t('editor.rules')}
        extra={
          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => mutateRules((r) => r.push({ host: '', http: { paths: [emptyPath()] } }))}
          >
            {t('editor.addRule')}
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {rules.length === 0 && <Text type="secondary">{t('editor.noRules')}</Text>}
          {rules.map((rule, ri) => {
            const paths = (rule.http?.paths as any[]) || [];
            return (
              <Card
                key={ri}
                size="small"
                type="inner"
                title={<Text strong>{`${t('editor.rule')} ${ri + 1}`}</Text>}
                extra={
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => mutateRules((r) => r.splice(ri, 1))}
                    aria-label={t('editor.remove')}
                  />
                }
              >
                <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
                  <Form.Item label={t('editor.host')} style={{ marginBottom: 14 }}>
                    <Input
                      placeholder="example.com"
                      value={rule.host ?? ''}
                      style={{ maxWidth: 360 }}
                      onChange={(e) => mutateRules((r) => {
                        const v = e.target.value;
                        if (v === '') delete r[ri].host;
                        else r[ri].host = v;
                      })}
                    />
                  </Form.Item>

                  {paths.length > 0 && (
                    <div style={{ display: 'flex', marginBottom: 6, paddingLeft: 2 }}>
                      {[
                        { w: 240, label: t('editor.path') },
                        { w: 120, label: t('editor.pathType') },
                        { w: 180, label: t('editor.backendService') },
                        { w: 130, label: t('editor.backendPort') },
                      ].map((c) => (
                        <span
                          key={c.label}
                          style={{
                            width: c.w,
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: 0.3,
                            textTransform: 'uppercase',
                            color: token.colorTextTertiary,
                          }}
                        >
                          {c.label}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {paths.map((p, pi) => {
                      const svcName = p.backend?.service?.name as string | undefined;
                      const ports = servicePorts(services, svcName);
                      const portVal = p.backend?.service?.port?.number;
                      const setPort = (n: number | undefined) => mutateRules((r) => {
                        const path = r[ri].http.paths[pi];
                        path.backend = path.backend || {};
                        path.backend.service = path.backend.service || { name: '' };
                        path.backend.service.port = { number: n };
                      });
                      return (
                        <div key={pi} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Space.Compact>
                            <Input
                              placeholder={t('editor.path')}
                              value={p.path ?? ''}
                              style={{ width: 240 }}
                              onChange={(e) => mutateRules((r) => {
                                r[ri].http.paths[pi].path = e.target.value;
                              })}
                            />
                            <Select
                              value={p.pathType || 'Prefix'}
                              style={{ width: 120 }}
                              options={PATH_TYPES.map((x) => ({ value: x, label: x }))}
                              onChange={(v) => mutateRules((r) => {
                                r[ri].http.paths[pi].pathType = v;
                              })}
                            />
                            <ResourceSelect
                              resource="services"
                              namespace={ns}
                              value={svcName ?? ''}
                              placeholder={t('editor.backendService')}
                              style={{ width: 180 }}
                              onChange={(v) => mutateRules((r) => {
                                const path = r[ri].http.paths[pi];
                                path.backend = path.backend || {};
                                path.backend.service = path.backend.service || { port: { number: 80 } };
                                path.backend.service.name = v;
                              })}
                            />
                            {ports.length > 0 ? (
                              <Select
                                placeholder={t('editor.backendPort')}
                                value={portVal}
                                style={{ width: 130 }}
                                options={[
                                  ...ports.map((pt) => ({
                                    value: pt.port,
                                    label: pt.name ? `${pt.name} · ${pt.port}` : String(pt.port),
                                  })),
                                  // Preserve an out-of-list custom value as an option.
                                  ...(portVal != null && !ports.some((pt) => pt.port === portVal)
                                    ? [{ value: portVal, label: String(portVal) }]
                                    : []),
                                ]}
                                onChange={(v) => setPort(v as number)}
                              />
                            ) : (
                              <InputNumber
                                placeholder={t('editor.backendPort')}
                                value={portVal}
                                min={1}
                                max={65535}
                                style={{ width: 130 }}
                                onChange={(v) => setPort(v ?? undefined)}
                              />
                            )}
                          </Space.Compact>
                          <Button
                            type="text"
                            icon={<DeleteOutlined />}
                            style={{ color: token.colorTextTertiary }}
                            onClick={() => mutateRules((r) => {
                              r[ri].http.paths.splice(pi, 1);
                            })}
                            aria-label={t('editor.remove')}
                          />
                        </div>
                      );
                    })}
                    <Button
                      type="dashed"
                      size="small"
                      icon={<PlusOutlined />}
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => mutateRules((r) => {
                        r[ri].http = r[ri].http || { paths: [] };
                        r[ri].http.paths = r[ri].http.paths || [];
                        r[ri].http.paths.push(emptyPath());
                      })}
                    >
                      {t('editor.addPath')}
                    </Button>
                  </div>
                </Form>
              </Card>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
