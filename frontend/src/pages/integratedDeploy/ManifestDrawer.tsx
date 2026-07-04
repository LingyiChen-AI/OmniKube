import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Button, ConfigProvider, Drawer, Segmented, Space, Tag, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { K8sObject } from '../../api/resource';
import { getResourceForm, kindFromResource } from '../../components/editor/forms';
import { toYAML, fromYAML } from '../../components/editor/util';
import CodeBox from '../../components/editor/CodeBox';

type ViewMode = 'visual' | 'yaml';

export interface ManifestDrawerResult {
  kind: string;
  name: string;
  yaml: string;
}

export interface ManifestDrawerProps {
  open: boolean;
  /** plural kind, e.g. 'deployments'. */
  kind: string;
  initialYaml?: string;
  readOnly?: boolean;
  onClose: () => void;
  onConfirm: (result: ManifestDrawerResult) => void;
}

export default function ManifestDrawer({
  open,
  kind,
  initialYaml,
  readOnly = false,
  onClose,
  onConfirm,
}: ManifestDrawerProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();

  const [draft, setDraft] = useState<K8sObject | null>(null);
  const [yamlText, setYamlText] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('visual');

  // Reset internal state whenever the drawer opens for a new target.
  useEffect(() => {
    if (!open) return;
    try {
      const obj = fromYAML(initialYaml || '');
      setDraft(obj);
      setYamlText(initialYaml || '');
      setViewMode(getResourceForm(kindFromResource(kind)) ? 'visual' : 'yaml');
    } catch {
      setDraft(null);
      setYamlText(initialYaml || '');
      setViewMode('yaml');
    }
  }, [open, kind, initialYaml]);

  const FormComp = useMemo(() => getResourceForm(kindFromResource(kind)), [kind]);
  const supportsVisual = !!FormComp;

  const switchMode = (next: ViewMode) => {
    if (next === viewMode) return;
    if (next === 'yaml') {
      if (draft) setYamlText(toYAML(draft));
      setViewMode('yaml');
      return;
    }
    try {
      const parsed = fromYAML(yamlText);
      setDraft(parsed);
      setViewMode('visual');
    } catch (e: any) {
      message.error(e?.message || t('editor.parseError'));
    }
  };

  const handleConfirm = () => {
    const finalYaml = viewMode === 'yaml' ? yamlText : draft ? toYAML(draft) : '';
    let parsed: K8sObject | null = null;
    try {
      parsed = fromYAML(finalYaml);
    } catch {
      /* handled below */
    }
    const name = parsed?.metadata?.name ?? '';
    if (!name) {
      message.error(t('integratedDeploy.nameRequired'));
      return;
    }
    const expectedKind = kindFromResource(kind);
    if (parsed?.kind && expectedKind && parsed.kind !== expectedKind) {
      message.error(t('integratedDeploy.kindMismatch'));
      return;
    }
    onConfirm({ kind, name, yaml: finalYaml });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(1100px, 90vw)"
      destroyOnClose
      styles={{
        body: { background: token.colorBgLayout, padding: 20, display: 'flex', flexDirection: 'column' },
      }}
      title={
        <Space size={8} wrap style={{ alignItems: 'center' }}>
          <span>{t('integratedDeploy.editItem')}</span>
          <Tag color="geekblue">{kind}</Tag>
        </Space>
      }
      extra={
        <Segmented<ViewMode>
          value={viewMode}
          onChange={(v) => switchMode(v)}
          options={[
            { label: t('editor.visual'), value: 'visual', disabled: !supportsVisual },
            { label: t('editor.yaml'), value: 'yaml' },
          ]}
        />
      }
      footer={
        readOnly ? null : (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Space>
              <Button onClick={onClose}>{t('editor.cancel')}</Button>
              <Button type="primary" onClick={handleConfirm}>
                {t('integratedDeploy.save')}
              </Button>
            </Space>
          </div>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        {!supportsVisual && <Alert type="info" showIcon message={t('integratedDeploy.noVisualEditor')} />}
        {viewMode === 'visual' && FormComp && draft ? (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <ConfigProvider componentDisabled={readOnly}>
              <FormComp draft={draft} onChange={setDraft} creating={false} />
            </ConfigProvider>
          </div>
        ) : (
          <CodeBox
            value={yamlText}
            onChange={readOnly ? undefined : setYamlText}
            readOnly={readOnly}
            label="YAML"
            minHeight={480}
          />
        )}
      </div>
    </Drawer>
  );
}
