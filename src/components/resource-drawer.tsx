'use client';

import { useState, useEffect, useMemo } from 'react';
import { Drawer, Button, Space, App, Tag, Input } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import yaml from 'yaml';
import YamlEditor from '@/components/yaml-editor';
import { RESOURCE_TEMPLATES } from '@/components/resource-templates';
import { useClusterStore } from '@/hooks/use-cluster';
import { gradientBtnStyle } from '@/lib/styles';
import { request } from '@/lib/request';

interface ResourceDrawerProps {
  open: boolean;
  mode: 'view' | 'edit' | 'create';
  kind: string;
  kindLabel: string;
  record?: any;
  namespace?: string;
  permissions: { canUpdate: boolean };
  onClose: () => void;
  onSuccess: () => void;
}

function cleanForEdit(obj: any): any {
  const clean = JSON.parse(JSON.stringify(obj));
  delete clean.status;
  if (clean.metadata) {
    delete clean.metadata.managedFields;
    delete clean.metadata.uid;
    delete clean.metadata.resourceVersion;
    delete clean.metadata.generation;
    delete clean.metadata.creationTimestamp;
    delete clean.metadata.selfLink;
    if (clean.metadata.annotations) {
      delete clean.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
      delete clean.metadata.annotations['deployment.kubernetes.io/revision'];
      if (Object.keys(clean.metadata.annotations).length === 0) delete clean.metadata.annotations;
    }
  }
  return clean;
}

export default function ResourceDrawer({
  open, mode, kind, kindLabel, record, namespace, permissions, onClose, onSuccess,
}: ResourceDrawerProps) {
  const { message } = App.useApp();
  const { clusterId } = useClusterStore();
  const [currentMode, setCurrentMode] = useState(mode);
  const [yamlText, setYamlText] = useState('');
  const [originalYaml, setOriginalYaml] = useState('');
  const [changeMessage, setChangeMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setCurrentMode(mode);
    if (!open) setChangeMessage('');
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    if (mode === 'view' && record) {
      setYamlText(yaml.stringify(record));
    } else if (mode === 'edit' && record) {
      const cleaned = yaml.stringify(cleanForEdit(record));
      setYamlText(cleaned);
      setOriginalYaml(cleaned);
    } else if (mode === 'create') {
      setYamlText('');
      setOriginalYaml('');
    }
  }, [open, mode, record, kind]);

  useEffect(() => {
    if (!open) return;
    if (currentMode === 'view' && record) {
      setYamlText(yaml.stringify(record));
    } else if (currentMode === 'edit' && record) {
      const cleaned = yaml.stringify(cleanForEdit(record));
      setYamlText(cleaned);
      setOriginalYaml(cleaned);
    }
  }, [currentMode]);

  const handleSave = async () => {
    if (!clusterId) return;
    if (kind === 'deployments' && !changeMessage.trim()) {
      message.warning('请填写变更说明');
      return;
    }
    setLoading(true);
    try {
      let parsed: any;
      try { parsed = yaml.parse(yamlText); }
      catch (e: any) { message.error(`YAML 格式错误: ${e.message}`); return; }

      const name = record?.metadata?.name;
      const ns = parsed?.metadata?.namespace || namespace || 'default';
      const url = `/api/k8s/${clusterId}/namespaces/${ns}/${kind}/${name}`;

      // Fetch latest resourceVersion to avoid conflict
      try {
        const freshRes = await request(url);
        if (freshRes.ok) {
          const fresh = await freshRes.json();
          if (fresh?.metadata?.resourceVersion) {
            if (!parsed.metadata) parsed.metadata = {};
            parsed.metadata.resourceVersion = fresh.metadata.resourceVersion;
          }
        }
      } catch { /* proceed with existing resourceVersion */ }

      const res = await request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Change-Message': encodeURIComponent(changeMessage.trim()) },
        body: JSON.stringify(parsed),
      });

      if (res.status === 409) { message.error('资源已被其他人修改，请刷新后重试'); return; }
      if (!res.ok) { const d = await res.json().catch(() => ({})); message.error(`操作失败: ${d.error || res.statusText}`); return; }

      message.success(`${kindLabel} 已更新`);
      onSuccess();
    } finally { setLoading(false); }
  };

  const handleCreate = async () => {
    if (!clusterId) return;
    setLoading(true);
    try {
      let docs: any[];
      try { docs = yaml.parseAllDocuments(yamlText).map((d) => d.toJS()); }
      catch (e: any) { message.error(`YAML 格式错误: ${e.message}`); return; }

      const results: { success: boolean; kind: string; name: string; error?: string }[] = [];

      for (const doc of docs) {
        if (!doc) continue;
        const docKind = doc.kind?.toLowerCase() + 's';
        const docNs = doc.metadata?.namespace || namespace || 'default';
        const docName = doc.metadata?.name || '';
        const clusterScoped = ['storageclasses', 'namespaces'].includes(docKind);
        const url = clusterScoped
          ? `/api/k8s/${clusterId}/${docKind}`
          : `/api/k8s/${clusterId}/namespaces/${docNs}/${docKind}`;

        const res = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(doc),
        });

        if (res.ok) { results.push({ success: true, kind: doc.kind || docKind, name: docName }); }
        else { const d = await res.json().catch(() => ({})); results.push({ success: false, kind: doc.kind || docKind, name: docName, error: d.error || res.statusText }); }
      }

      const failed = results.filter((r) => !r.success);
      const succeeded = results.filter((r) => r.success);

      if (failed.length === 0) { message.success(`${kindLabel} 创建成功`); onSuccess(); }
      else if (succeeded.length > 0) { message.warning(`部分资源创建成功，${failed.map((f) => `${f.kind} 创建失败: ${f.error}`).join('; ')}`); onSuccess(); }
      else { message.error(`操作失败: ${failed.map((f) => f.error).join('; ')}`); }
    } finally { setLoading(false); }
  };

  const templates = RESOURCE_TEMPLATES[kind] || [];

  const hasChanges = useMemo(() => yamlText !== originalYaml, [yamlText, originalYaml]);

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 600 }}>
        {currentMode === 'view' ? record?.metadata?.name || kindLabel
          : currentMode === 'edit' ? `编辑 ${record?.metadata?.name || kindLabel}`
          : `创建 ${kindLabel}`}
      </span>
      <Tag color="blue" style={{ marginLeft: 4, fontSize: 11 }}>{kindLabel}</Tag>
      {currentMode === 'view' && permissions.canUpdate && (
        <Button size="small" icon={<EditOutlined />} onClick={() => setCurrentMode('edit')}>编辑</Button>
      )}
    </div>
  );

  const footer = currentMode === 'edit' ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Input
        placeholder={kind === 'deployments' ? '变更说明（必填）' : '变更说明（选填）'}
        value={changeMessage}
        onChange={(e) => setChangeMessage(e.target.value)}
        style={{ flex: 1 }}
        maxLength={500}
      />
      <Button onClick={() => setCurrentMode('view')}>取消</Button>
      <Button type="primary" loading={loading} onClick={handleSave} disabled={!hasChanges} style={gradientBtnStyle}>保存</Button>
    </div>
  ) : currentMode === 'create' ? (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
      <Button onClick={onClose}>取消</Button>
      <Button type="primary" loading={loading} onClick={handleCreate} disabled={!yamlText.trim()} style={gradientBtnStyle}>创建</Button>
    </div>
  ) : null;

  const drawerWidth = currentMode === 'edit' ? '85vw' : 800;

  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      width={drawerWidth}
      footer={footer}
      destroyOnHidden
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', background: '#0d1117' } }}
    >
      {/* 模板选择 */}
      {currentMode === 'create' && templates.length > 0 && (
        <div style={{
          padding: '10px 16px',
          background: '#161b22',
          borderBottom: '1px solid #21262d',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ color: '#8b949e', fontSize: 12, flexShrink: 0 }}>模板</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {templates.map((t) => {
              const active = yamlText === t.yaml;
              return (
                <button
                  key={t.label}
                  onClick={() => setYamlText(t.yaml)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    border: active ? '1px solid #58a6ff' : '1px solid #30363d',
                    background: active ? 'rgba(88,166,255,0.15)' : '#21262d',
                    color: active ? '#58a6ff' : '#c9d1d9',
                    cursor: 'pointer',
                    fontWeight: 500,
                    transition: 'all 0.15s',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
            <button
              onClick={() => setYamlText('')}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                fontSize: 12,
                border: yamlText === '' ? '1px solid #58a6ff' : '1px solid #30363d',
                background: yamlText === '' ? 'rgba(88,166,255,0.15)' : '#21262d',
                color: yamlText === '' ? '#58a6ff' : '#c9d1d9',
                cursor: 'pointer',
                fontWeight: 500,
                transition: 'all 0.15s',
              }}
            >
              空白
            </button>
          </div>
        </div>
      )}

      {/* 编辑模式：分屏 */}
      {currentMode === 'edit' ? (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* 左：原始版本 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #21262d' }}>
            <div style={{
              padding: '6px 14px',
              background: '#161b22',
              borderBottom: '1px solid #21262d',
              fontSize: 11,
              color: '#8b949e',
              fontWeight: 500,
            }}>
              当前版本（只读）
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#0d1117' }}>
              <YamlEditor value={originalYaml} readOnly height="100%" />
            </div>
          </div>
          {/* 右：编辑区 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '6px 14px',
              background: '#161b22',
              borderBottom: '1px solid #21262d',
              fontSize: 11,
              color: '#58a6ff',
              fontWeight: 500,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>编辑中</span>
              {hasChanges && <span style={{ color: '#3fb950', fontSize: 10 }}>有变更</span>}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#0d1117' }}>
              <YamlEditor value={yamlText} onChange={setYamlText} diffBase={originalYaml} height="100%" />
            </div>
          </div>
        </div>
      ) : (
        /* 查看/创建模式：单编辑器 */
        <div style={{ flex: 1, overflow: 'auto', background: '#0d1117' }}>
          <YamlEditor
            value={yamlText}
            onChange={currentMode === 'create' ? setYamlText : undefined}
            readOnly={currentMode === 'view'}
            height="100%"
            placeholder={currentMode === 'create' ? '粘贴或编写 YAML...' : undefined}
          />
        </div>
      )}
    </Drawer>
  );
}
