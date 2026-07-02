import { Button, Collapse, ConfigProvider, Form, Input, Select, Tag, Tooltip, Typography, theme } from 'antd';
import { ContainerOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import KeyValueEditor, { recordToRows, rowsToRecord, type KVRow } from './KeyValueEditor';
import PortListEditor from './PortListEditor';
import ResourceLimitsEditor, { type ResourceSpec } from './ResourceLimitsEditor';
import VolumeMountsEditor from './forms/VolumeMountsEditor';

const { Text } = Typography;
const PULL_POLICIES = ['Always', 'IfNotPresent', 'Never'];

interface Props {
  container: any;
  /** Reports the updated container; pass nextVolumes to also update pod volumes
   *  atomically (mount edits manage their backing volume behind the scenes). */
  onChange: (next: any, nextVolumes?: any[]) => void;
  defaultOpen?: boolean;
  /** When provided, a remove button is shown in the card header. */
  onRemove?: () => void;
  /** Editable container name (shown when true, e.g. multi-container specs). */
  editableName?: boolean;
  /** Pod-level Form.Item(s) rendered inline on the first header row (e.g. image
   *  pull secrets, restart policy). Provided only for the first container. */
  headerExtra?: ReactNode;
  /** Pod volumes — each mount manages its own backing volume here. */
  volumes?: any[];
  /** Namespace, for the mount source (ConfigMap/Secret/PVC) dropdowns. */
  namespace?: string;
}

/** env entries that carry a plain `value` (valueFrom entries are preserved but not edited). */
function envValueRows(env: any[]): KVRow[] {
  return env.filter((e) => e && e.valueFrom === undefined).map((e) => ({ key: e.name ?? '', value: e.value ?? '' }));
}

/** A labelled field group inside the container body. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div>
      <Text
        style={{
          display: 'block',
          marginBottom: 8,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          color: token.colorTextTertiary,
        }}
      >
        {label}
      </Text>
      {children}
    </div>
  );
}

/**
 * Single-container editor: image, ports, plain-value env vars and
 * cpu/memory requests·limits, grouped under a collapsible header that surfaces
 * the image and port/env counts at a glance. `valueFrom` env entries are left
 * untouched and re-appended so editing the simple vars never drops references.
 */
export default function ContainerCard({
  container,
  onChange,
  defaultOpen = true,
  onRemove,
  editableName = false,
  headerExtra,
  volumes = [],
  namespace = 'default',
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const c = container || {};
  const ports = (c.ports as any[]) || [];
  const env = (c.env as any[]) || [];
  const fromRefs = env.filter((e) => e && e.valueFrom !== undefined);
  const envValues = envValueRows(env);
  const mounts = (c.volumeMounts as any[]) || [];

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <ContainerOutlined style={{ color: token.colorPrimary, fontSize: 16, flex: '0 0 auto' }} />
      <Text strong style={{ flex: '0 0 auto' }}>
        {c.name || t('editor.container')}
      </Text>
      {c.image && (
        <Text
          type="secondary"
          ellipsis
          style={{ fontFamily: token.fontFamilyCode, fontSize: 12, minWidth: 0 }}
        >
          {c.image}
        </Text>
      )}
      <span style={{ flex: 1 }} />
      {ports.length > 0 && (
        <Tag bordered={false} color="blue" style={{ marginInlineEnd: 0 }}>
          {t('editor.ports')} · {ports.length}
        </Tag>
      )}
      {envValues.length > 0 && (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {t('editor.env')} · {envValues.length}
        </Tag>
      )}
    </div>
  );

  const body = (
    <ConfigProvider componentSize="small">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          {/* Row 1: name · pull policy · (pod-level extras) — equal-width columns */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
            {editableName && (
              <Form.Item label={t('editor.name')} style={{ marginBottom: 0, flex: '1 1 0', minWidth: 150 }}>
                <Input
                  value={c.name ?? ''}
                  placeholder="app"
                  style={{ fontFamily: token.fontFamilyCode }}
                  onChange={(e) => onChange({ ...c, name: e.target.value })}
                />
              </Form.Item>
            )}
            <Form.Item label={t('editor.pullPolicy')} style={{ marginBottom: 0, flex: '1 1 0', minWidth: 150 }}>
              <Select
                allowClear
                style={{ width: '100%' }}
                value={c.imagePullPolicy || undefined}
                placeholder={t('editor.pullPolicyDefault')}
                options={PULL_POLICIES.map((x) => ({ value: x, label: x }))}
                onChange={(v) => {
                  const next = { ...c };
                  if (v) next.imagePullPolicy = v;
                  else delete next.imagePullPolicy;
                  onChange(next);
                }}
              />
            </Form.Item>
            {headerExtra}
          </div>
          {/* Row 2: image — fills the row */}
          <Form.Item label={t('editor.image')} style={{ marginBottom: 0 }}>
            <Input
              value={c.image ?? ''}
              placeholder="nginx:1.27"
              style={{ fontFamily: token.fontFamilyCode }}
              onChange={(e) => onChange({ ...c, image: e.target.value })}
            />
          </Form.Item>
        </Form>

        {/* Ports (left) | dashed divider | Env (right) */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <Group label={t('editor.ports')}>
              <PortListEditor
                variant="container"
                seedEmpty
                ports={ports}
                onChange={(p) => onChange({ ...c, ports: p.length ? p : undefined })}
              />
            </Group>
          </div>
          <div
            style={{ alignSelf: 'stretch', borderLeft: `1px dashed ${token.colorBorder}`, flex: '0 0 auto' }}
          />
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <Group label={t('editor.env')}>
              <KeyValueEditor
                seedEmpty
                rows={envValues}
                emptyHint={t('editor.envEmpty')}
                onChange={(rows) => {
                  const valueEnv = rows
                    .filter((r) => r.key.trim() !== '')
                    .map((r) => ({ name: r.key, value: r.value }));
                  const merged = [...valueEnv, ...fromRefs];
                  onChange({ ...c, env: merged.length ? merged : undefined });
                }}
              />
            </Group>
          </div>
        </div>

        <Group label={t('editor.mounts')}>
          <VolumeMountsEditor
            volumeMounts={mounts}
            volumes={volumes}
            namespace={namespace}
            onChange={(vm, vols) => onChange({ ...c, volumeMounts: vm.length ? vm : undefined }, vols)}
          />
        </Group>

        <Group label={t('editor.resources')}>
          <ResourceLimitsEditor
            value={c.resources as ResourceSpec | undefined}
            onChange={(r) => onChange({ ...c, resources: r })}
          />
        </Group>
      </div>
    </ConfigProvider>
  );

  return (
    <Collapse
      defaultActiveKey={defaultOpen ? ['c'] : []}
      style={{ marginBottom: 12, background: token.colorBgContainer }}
      items={[
        {
          key: 'c',
          label: header,
          children: body,
          extra: onRemove ? (
            <Tooltip title={t('editor.remove')}>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="remove-container"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
              />
            </Tooltip>
          ) : undefined,
        },
      ]}
    />
  );
}

export { recordToRows, rowsToRecord };
