import { useMemo } from 'react';
import { Button, Card, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { K8sObject } from '../../api/resource';
import { fromYAML } from '../../components/editor/util';
import type { DeployItem } from '../../api/integratedDeploy';

const { Text } = Typography;

interface Mount {
  kind: 'configmaps' | 'secrets';
  name: string;
}

/** Collect referenced ConfigMap/Secret names from a workload pod spec. */
function extractMounts(spec: Record<string, any> | undefined): Mount[] {
  const out: Mount[] = [];
  const podSpec = spec?.template?.spec ?? spec?.jobTemplate?.spec?.template?.spec;
  const push = (kind: Mount['kind'], name: string | undefined) => {
    if (name) out.push({ kind, name });
  };
  for (const v of podSpec?.volumes ?? []) {
    push('configmaps', v?.configMap?.name);
    push('secrets', v?.secret?.secretName);
  }
  for (const c of podSpec?.containers ?? []) {
    for (const e of c?.envFrom ?? []) {
      push('configmaps', e?.configMapRef?.name);
      push('secrets', e?.secretRef?.name);
    }
    for (const e of c?.env ?? []) {
      push('configmaps', e?.valueFrom?.configMapKeyRef?.name);
      push('secrets', e?.valueFrom?.secretKeyRef?.name);
    }
  }
  return Array.from(new Map(out.map((m) => [`${m.kind}:${m.name}`, m])).values());
}

function containersOf(kind: string, obj: K8sObject): Array<{ name?: string; image?: string }> {
  if (kind === 'cronjobs') return obj.spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];
  return obj.spec?.template?.spec?.containers ?? [];
}

function podSpecOf(kind: string, obj: K8sObject): Record<string, any> | undefined {
  return kind === 'cronjobs' ? obj.spec?.jobTemplate?.spec : obj.spec;
}

export interface ResourceItemCardProps {
  item: DeployItem;
  groupLabel: string;
  inOrder: Set<string>;
  onEdit: () => void;
  onDelete: () => void;
  onOpenMount: (kind: string, name: string) => void;
  canEdit: boolean;
}

const WORKLOAD_KINDS = new Set(['deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'jobs']);

export default function ResourceItemCard({
  item, groupLabel, inOrder, onEdit, onDelete, onOpenMount, canEdit,
}: ResourceItemCardProps) {
  const { t } = useTranslation();

  const obj = useMemo<K8sObject | null>(() => {
    try {
      return fromYAML(item.manifest_yaml);
    } catch {
      return null;
    }
  }, [item.manifest_yaml]);

  const body = () => {
    if (!obj) return null;
    const { kind } = item;
    if (kind === 'configmaps' || kind === 'secrets') {
      const dataKeys = Object.keys(obj.data || {});
      const stringDataKeys = Object.keys((obj as any).stringData || {});
      const allKeys = [...dataKeys, ...stringDataKeys];
      return (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary">{t('integratedDeploy.dataItems', { n: allKeys.length })}</Text>
          <Space wrap size={[4, 4]}>
            {allKeys.slice(0, 8).map((k) => (
              <Tag key={k} style={{ marginInlineEnd: 0 }}>{k}</Tag>
            ))}
            {allKeys.length > 8 && <Tag>…</Tag>}
          </Space>
        </Space>
      );
    }
    if (WORKLOAD_KINDS.has(kind)) {
      const containers = containersOf(kind, obj);
      const replicas = obj.spec?.replicas;
      const podSpec = podSpecOf(kind, obj);
      const mounts = extractMounts(podSpec);
      return (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {typeof replicas === 'number' && (
            <Text type="secondary">{t('integratedDeploy.replicas')}: {replicas}</Text>
          )}
          {containers.length > 0 && (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Text type="secondary">{t('integratedDeploy.images')}</Text>
              <Space wrap size={[4, 4]}>
                {containers.map((c, i) => (
                  <Tag key={`${c.name}-${i}`} style={{ marginInlineEnd: 0 }}>
                    {c.name}:{c.image}
                  </Tag>
                ))}
              </Space>
            </Space>
          )}
          {mounts.length > 0 && (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Text type="secondary">{t('integratedDeploy.mounts')}</Text>
              <Space wrap size={[4, 4]}>
                {mounts.map((m) => {
                  const key = `${m.kind}:${m.name}`;
                  const label = `${m.kind}/${m.name}`;
                  const added = inOrder.has(key);
                  // Every mount is clickable. In-order → solid colored Tag; not yet
                  // in order → a "+"-prefixed Tag hinting it will be added on click.
                  return (
                    <Tag
                      key={key}
                      color={added ? 'blue' : undefined}
                      icon={added ? undefined : <PlusOutlined />}
                      style={{ marginInlineEnd: 0, cursor: 'pointer' }}
                      onClick={() => onOpenMount(m.kind, m.name)}
                    >
                      {label}
                    </Tag>
                  );
                })}
              </Space>
            </Space>
          )}
        </Space>
      );
    }
    if (kind === 'services') {
      const type = obj.spec?.type || 'ClusterIP';
      const ports = (obj.spec?.ports ?? []).map((p: any) => p?.port).filter((p: any) => p !== undefined);
      return (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary">{t('integratedDeploy.svcType')}: {type}</Text>
          {ports.length > 0 && (
            <Space wrap size={[4, 4]}>
              <Text type="secondary">{t('integratedDeploy.ports')}:</Text>
              {ports.map((p: number, i: number) => <Tag key={i} style={{ marginInlineEnd: 0 }}>{p}</Tag>)}
            </Space>
          )}
        </Space>
      );
    }
    if (kind === 'ingresses') {
      const hosts = (obj.spec?.rules ?? []).map((r: any) => r?.host).filter(Boolean);
      return (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary">{t('integratedDeploy.hosts')}:</Text>
          <Space wrap size={[4, 4]}>
            {hosts.map((h: string, i: number) => <Tag key={i} style={{ marginInlineEnd: 0 }}>{h}</Tag>)}
          </Space>
        </Space>
      );
    }
    if (kind === 'persistentvolumeclaims') {
      const storage = obj.spec?.resources?.requests?.storage;
      const accessModes: string[] = obj.spec?.accessModes ?? [];
      return (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {storage && <Text type="secondary">{t('integratedDeploy.storage')}: {storage}</Text>}
          {accessModes.length > 0 && (
            <Space wrap size={[4, 4]}>
              {accessModes.map((m) => <Tag key={m} style={{ marginInlineEnd: 0 }}>{m}</Tag>)}
            </Space>
          )}
        </Space>
      );
    }
    return null;
  };

  return (
    <Card
      size="small"
      style={{ width: '100%' }}
      styles={{ body: { padding: 16 } }}
      title={
        <Space size={6}>
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{item.kind}</Tag>
          <a onClick={onEdit}>{item.name}</a>
        </Space>
      }
      extra={
        <Space size={6}>
          <Tag style={{ marginInlineEnd: 0 }}>
            {item.source === 'selected' ? t('integratedDeploy.addSelected') : t('integratedDeploy.addAuthored')}
          </Tag>
          {canEdit && (
            <Button
              size="small"
              danger
              type="text"
              icon={<DeleteOutlined />}
              onClick={onDelete}
              aria-label={t('integratedDeploy.delete')}
            />
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={2} style={{ width: '100%', marginBottom: 6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{groupLabel}</Text>
      </Space>
      {obj ? body() : <Text type="secondary">{item.name}</Text>}
    </Card>
  );
}
