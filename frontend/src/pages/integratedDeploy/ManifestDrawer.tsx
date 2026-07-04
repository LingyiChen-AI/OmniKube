import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Button, ConfigProvider, Drawer, Segmented, Select, Space, Tag, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { K8sObject } from '../../api/resource';
import { getResourceForm, kindFromResource } from '../../components/editor/forms';
import { toYAML, fromYAML } from '../../components/editor/util';
import CodeBox from '../../components/editor/CodeBox';
import { integratedDeployApi, DEPLOY_KINDS } from '../../api/integratedDeploy';

type ViewMode = 'visual' | 'yaml';
export type ManifestDrawerMode = 'select-add' | 'edit';

export interface ManifestDrawerResult {
  kind: string;
  name: string;
  yaml: string;
}

export interface ManifestDrawerProps {
  open: boolean;
  mode: ManifestDrawerMode;
  clusterId: string;
  namespace: string;
  /** for edit mode: plural kind, e.g. 'deployments'. */
  initialKind?: string;
  initialYaml?: string;
  readOnly?: boolean;
  onClose: () => void;
  onConfirm: (result: ManifestDrawerResult) => void;
}

export default function ManifestDrawer({
  open,
  mode,
  clusterId,
  namespace,
  initialKind,
  initialYaml,
  readOnly = false,
  onClose,
  onConfirm,
}: ManifestDrawerProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();

  const [kind, setKind] = useState<string>('configmaps');
  const [draft, setDraft] = useState<K8sObject | null>(null);
  const [yamlText, setYamlText] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('visual');

  // select-add: resource-name picker.
  const [selName, setSelName] = useState('');
  const [selectableNames, setSelectableNames] = useState<string[]>([]);

  // Reset internal state whenever the drawer opens.
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit') {
      const k = initialKind || 'configmaps';
      setKind(k);
      setSelName('');
      setSelectableNames([]);
      try {
        const obj = fromYAML(initialYaml || '');
        setDraft(obj);
        setYamlText(initialYaml || '');
        setViewMode(getResourceForm(kindFromResource(k)) ? 'visual' : 'yaml');
      } catch {
        setDraft(null);
        setYamlText(initialYaml || '');
        setViewMode('yaml');
      }
      return;
    }
    // select-add
    setKind('configmaps');
    setSelName('');
    setDraft(null);
    setYamlText('');
    setViewMode('visual');
  }, [open, mode, initialKind, initialYaml]);

  // select-add: load selectable names whenever kind changes (while open).
  useEffect(() => {
    if (!open || mode !== 'select-add') return;
    if (!clusterId || !namespace) {
      setSelectableNames([]);
      return;
    }
    integratedDeployApi.selectable(clusterId, namespace, kind).then(setSelectableNames).catch(() => setSelectableNames([]));
  }, [open, mode, clusterId, namespace, kind]);

  const FormComp = useMemo(() => getResourceForm(kindFromResource(kind)), [kind]);
  const supportsVisual = !!FormComp;
  // select-add shows only the kind+name picker until a resource is loaded.
  const showEditor = !(mode === 'select-add' && !draft);

  const handleKindChangeSelectAdd = (k: string) => {
    setKind(k);
    setSelName('');
    setDraft(null);
    setYamlText('');
  };

  const handleSelectName = async (name: string) => {
    setSelName(name);
    if (!clusterId || !namespace) return;
    try {
      const y = await integratedDeployApi.snapshot(clusterId, namespace, kind, name);
      const obj = fromYAML(y);
      setDraft(obj);
      setYamlText(y);
      setViewMode(getResourceForm(kindFromResource(kind)) ? 'visual' : 'yaml');
    } catch {
      /* axios interceptor already toasts */
    }
  };

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

  const title = mode === 'select-add' ? t('integratedDeploy.addSelected') : t('integratedDeploy.editItem');

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
          <span>{title}</span>
          {mode === 'edit' && <Tag color="geekblue">{kind}</Tag>}
        </Space>
      }
      extra={
        showEditor ? (
          <Segmented<ViewMode>
            value={viewMode}
            onChange={(v) => switchMode(v)}
            options={[
              { label: t('editor.visual'), value: 'visual', disabled: !supportsVisual },
              { label: t('editor.yaml'), value: 'yaml' },
            ]}
          />
        ) : undefined
      }
      footer={
        readOnly ? null : (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Space>
              <Button onClick={onClose}>{t('editor.cancel')}</Button>
              <Button type="primary" onClick={handleConfirm} disabled={!showEditor}>
                {mode === 'edit' ? t('integratedDeploy.save') : t('integratedDeploy.addItem')}
              </Button>
            </Space>
          </div>
        )
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {mode === 'select-add' && (
          <Space wrap>
            <Select
              style={{ width: 200 }}
              value={kind}
              onChange={handleKindChangeSelectAdd}
              options={DEPLOY_KINDS.map((k) => ({ value: k, label: k }))}
            />
            <Select
              style={{ width: 280 }}
              showSearch
              placeholder={t('integratedDeploy.selectResource')}
              value={selName || undefined}
              onChange={handleSelectName}
              options={selectableNames.map((n) => ({ value: n, label: n }))}
              notFoundContent={t('integratedDeploy.noSelectable')}
            />
          </Space>
        )}
      </Space>

      {showEditor ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0, marginTop: 12 }}>
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
      ) : (
        <div style={{ marginTop: 12, color: token.colorTextSecondary }}>
          {t('integratedDeploy.selectResource')}
        </div>
      )}
    </Drawer>
  );
}
