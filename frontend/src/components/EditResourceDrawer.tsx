import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  ConfigProvider,
  Drawer,
  Input,
  Modal,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { SaveOutlined, EyeOutlined, RocketOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../api/resource';
import { useCapabilities } from '../store/caps';
import { getResourceForm, createTemplate } from './editor/forms';
import { clone, toYAML, fromYAML, forcePrimaryKeys } from './editor/util';
import DiffView from './editor/DiffView';
import CodeBox from './editor/CodeBox';

const { Text } = Typography;

type Mode = 'visual' | 'yaml';

/** Workload kinds whose container-image changes require a release comment. */
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];

/** Extract a container→image map from a workload's pod template. */
function containerImages(obj: K8sObject | null): Record<string, string> {
  const out: Record<string, string> = {};
  const containers = obj?.spec?.template?.spec?.containers;
  if (Array.isArray(containers)) {
    for (const c of containers) {
      if (c && typeof c === 'object' && c.name) out[c.name] = c.image ?? '';
    }
  }
  return out;
}

/** Whether any container image differs between two workload objects. */
function imagesChanged(a: K8sObject | null, b: K8sObject | null): boolean {
  const ia = containerImages(a);
  const ib = containerImages(b);
  const keys = new Set([...Object.keys(ia), ...Object.keys(ib)]);
  for (const k of keys) {
    if (ia[k] !== ib[k]) return true;
  }
  return false;
}

export interface EditResourceDrawerProps {
  open: boolean;
  /** k8s plural, e.g. "deployments". */
  resource: string;
  /** k8s Kind, e.g. "Deployment" — selects the visual form. */
  kind?: string;
  namespace: string;
  name: string;
  /**
   * Force a read-only view: the visual + YAML tabs render with every input
   * disabled and the save button hidden, regardless of write capability.
   * Used by the row "view" (eye) action so it mirrors the edit experience.
   */
  readOnly?: boolean;
  /**
   * Create mode: instead of loading an existing object, start from a per-kind
   * YAML template (editable in the visual + YAML tabs) and POST on save. The
   * namespace prop is the default; the user may change it before creating.
   */
  creating?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export default function EditResourceDrawer({
  open,
  resource,
  kind,
  namespace,
  name,
  readOnly = false,
  creating = false,
  onClose,
  onSaved,
}: EditResourceDrawerProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const { can } = useCapabilities();
  // Effective writability: create mode gates on `create`; edit gates on `edit`
  // (and is suppressed by the read-only view action).
  const canWrite = creating
    ? can(resource, 'create')
    : can(resource, 'edit') && !readOnly;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [original, setOriginal] = useState<K8sObject | null>(null);
  const [draft, setDraft] = useState<K8sObject | null>(null);
  const [yamlText, setYamlText] = useState('');
  const [mode, setMode] = useState<Mode>('visual');
  const [showDiff, setShowDiff] = useState(false);
  const [yamlError, setYamlError] = useState<string | null>(null);
  // Release-comment flow for workload image changes.
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<K8sObject | null>(null);

  const effectiveKind = original?.kind || kind;
  const FormComp = useMemo(() => getResourceForm(effectiveKind), [effectiveKind]);
  const supportsVisual = !!FormComp;

  // Load the object whenever the drawer opens for a new target. In create mode
  // there is no remote object — start from a per-kind template instead.
  useEffect(() => {
    if (!open) return;
    setYamlError(null);
    setShowDiff(false);
    if (creating) {
      const tpl = createTemplate(resource, namespace) as K8sObject;
      // No "original" in create mode → save stays enabled and primary keys are
      // not force-restored (the user may freely set name/namespace/kind).
      setOriginal(null);
      setDraft(clone(tpl));
      setYamlText(toYAML(tpl));
      setMode(getResourceForm(tpl.kind || kind) ? 'visual' : 'yaml');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    resourceApi
      .get(namespace, resource, name)
      .then((obj) => {
        if (cancelled) return;
        setOriginal(clone(obj));
        setDraft(clone(obj));
        setYamlText(toYAML(obj));
        setMode(getResourceForm(obj.kind || kind) ? 'visual' : 'yaml');
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, namespace, resource, name, creating]);

  const currentYaml = useMemo(() => {
    if (mode === 'yaml') return yamlText;
    return draft ? toYAML(draft) : '';
  }, [mode, yamlText, draft]);

  const originalYaml = useMemo(() => (original ? toYAML(original) : ''), [original]);
  const dirty = originalYaml !== currentYaml;

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === 'yaml') {
      // visual → YAML: serialise the working draft.
      if (draft) setYamlText(toYAML(draft));
      setYamlError(null);
      setMode('yaml');
      return;
    }
    // YAML → visual: parse; stay in YAML on error.
    try {
      const parsed = fromYAML(yamlText);
      setDraft(parsed);
      setYamlError(null);
      setShowDiff(false);
      setMode('visual');
    } catch (e: any) {
      setYamlError(e?.message || t('editor.parseError'));
    }
  };

  const handleSave = async () => {
    if (!creating && !original) return;
    let obj: K8sObject;
    if (mode === 'yaml') {
      try {
        obj = fromYAML(yamlText);
        setYamlError(null);
      } catch (e: any) {
        setYamlError(e?.message || t('editor.parseError'));
        message.error(t('editor.parseErrorToast'));
        return;
      }
    } else {
      obj = draft || original || ({} as K8sObject);
    }
    // Create mode POSTs the authored manifest as-is (no primary-key forcing,
    // no release-comment flow — there is no prior object to diff against).
    if (creating) {
      await performSave(obj);
      return;
    }
    const payload = forcePrimaryKeys(obj, original!);
    // Workload image change → require a release comment before PUT.
    const isWorkload = WORKLOAD_KINDS.includes(effectiveKind || '');
    if (isWorkload && imagesChanged(original, payload)) {
      setPendingPayload(payload);
      setComment('');
      setCommentError(null);
      setCommentOpen(true);
      return;
    }
    await performSave(payload);
  };

  const performSave = async (payload: K8sObject, releaseComment?: string) => {
    setSaving(true);
    try {
      if (creating) {
        // Namespace comes from the manifest (user-editable), falling back to the
        // current namespace, then `default`.
        const ns = payload.metadata?.namespace || namespace || 'default';
        await resourceApi.create(ns, resource, payload);
        message.success(t('editor.created'));
      } else {
        await resourceApi.update(
          namespace,
          resource,
          name,
          payload,
          releaseComment ? { releaseComment } : undefined,
        );
        message.success(t('editor.saved'));
      }
      onSaved?.();
      onClose();
    } catch {
      // request interceptor surfaces the error toast
    } finally {
      setSaving(false);
    }
  };

  const confirmComment = async () => {
    const c = comment.trim();
    if (!c) {
      setCommentError(t('editor.releaseCommentRequired'));
      return;
    }
    if (!pendingPayload) return;
    setCommentOpen(false);
    await performSave(pendingPayload, c);
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
          {creating && (
            <Space size={6} style={{ alignItems: 'center', color: token.colorPrimary }}>
              <PlusOutlined />
              <Text strong style={{ color: token.colorText }}>{t('editor.createTitle')}</Text>
              <span style={{ opacity: 0.4 }}>·</span>
            </Space>
          )}
          {readOnly && (
            <Space size={6} style={{ alignItems: 'center', color: token.colorTextSecondary }}>
              <EyeOutlined />
              <Text strong style={{ color: token.colorText }}>{t('editor.viewTitle')}</Text>
              <span style={{ opacity: 0.4 }}>·</span>
            </Space>
          )}
          {effectiveKind && (
            <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
              {effectiveKind}
            </Tag>
          )}
          {namespace && (
            <Text type="secondary" style={{ fontWeight: 400, fontFamily: token.fontFamilyCode }}>
              {namespace}
              <span style={{ opacity: 0.5, margin: '0 2px' }}>/</span>
            </Text>
          )}
          <Text strong style={{ fontFamily: token.fontFamilyCode }}>{name}</Text>
          {!canWrite && <Tag style={{ marginInlineEnd: 0 }}>{t('editor.readOnly')}</Tag>}
          {dirty && canWrite && (
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
              {t('editor.unsaved')}
            </Tag>
          )}
        </Space>
      }
      extra={
        <Segmented<Mode>
          value={mode}
          onChange={(v) => switchMode(v)}
          options={[
            {
              label: t('editor.visual'),
              value: 'visual',
              disabled: !supportsVisual,
            },
            { label: t('editor.yaml'), value: 'yaml' },
          ]}
        />
      }
      footer={
        // Read-only view has nothing to save/cancel — the header ✕ closes it.
        readOnly ? null : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              {mode === 'yaml' && (
                <Button onClick={() => setShowDiff((s) => !s)}>
                  {showDiff ? t('editor.hideDiff') : t('editor.showDiff')}
                </Button>
              )}
            </div>
            <Space>
              <Button onClick={onClose}>{t('editor.cancel')}</Button>
              {canWrite && (
                <Button
                  type="primary"
                  icon={creating ? <PlusOutlined /> : <SaveOutlined />}
                  loading={saving}
                  disabled={!dirty}
                  onClick={handleSave}
                >
                  {creating ? t('editor.create') : t('editor.save')}
                </Button>
              )}
            </Space>
          </div>
        )
      }
    >
      {loading || !draft ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
          {creating && (
            <Alert
              type="info"
              showIcon
              icon={<PlusOutlined />}
              message={t('editor.createBanner')}
              style={{ borderRadius: token.borderRadiusLG }}
            />
          )}
          {renderBody()}
        </div>
      )}
      <Modal
        open={commentOpen}
        title={t('editor.releaseCommentTitle')}
        okText={t('editor.releaseCommentSubmit')}
        cancelText={t('editor.cancel')}
        confirmLoading={saving}
        onCancel={() => setCommentOpen(false)}
        onOk={confirmComment}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          icon={<RocketOutlined />}
          message={t('editor.releaseCommentHint')}
          style={{ marginBottom: 14, borderRadius: token.borderRadiusLG }}
        />
        <Input.TextArea
          autoFocus
          rows={3}
          maxLength={500}
          value={comment}
          aria-label="release-comment"
          placeholder={t('editor.releaseCommentPlaceholder')}
          status={commentError ? 'error' : undefined}
          onChange={(e) => {
            setComment(e.target.value);
            if (commentError) setCommentError(null);
          }}
          onPressEnter={(e) => {
            if ((e as any).ctrlKey || (e as any).metaKey) confirmComment();
          }}
        />
        {commentError && (
          <Text type="danger" style={{ display: 'block', marginTop: 8 }}>
            {commentError}
          </Text>
        )}
      </Modal>
    </Drawer>
  );

  function renderBody() {
    if (!draft) return null;
    if (!supportsVisual && mode === 'visual') {
      return <Alert type="info" showIcon message={t('editor.unsupported')} />;
    }
    if (mode === 'visual' && FormComp && draft) {
      return (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ConfigProvider componentDisabled={!canWrite}>
            <FormComp draft={draft} onChange={setDraft} creating={creating} />
          </ConfigProvider>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        {!supportsVisual && (
          <Alert type="info" showIcon message={t('editor.unsupported')} />
        )}
          {yamlError && (
            <Alert
              type="error"
              showIcon
              message={t('editor.parseError')}
              description={yamlError}
            />
          )}
          {showDiff ? (
            <DiffView original={originalYaml} current={currentYaml} />
          ) : (
            <CodeBox
              value={yamlText}
              onChange={canWrite ? setYamlText : undefined}
              readOnly={!canWrite}
              label="YAML"
              ariaLabel="YAML editor"
              height="100%"
            />
          )}
      </div>
    );
  }
}
