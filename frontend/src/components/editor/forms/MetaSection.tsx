import { useEffect, useState, type ReactNode } from 'react';
import { AutoComplete, Card, Form, Input, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../../../api/resource';
import { update } from '../util';

interface Props {
  draft: K8sObject;
  onChange: (next: K8sObject) => void;
  /** Hide the namespace field for cluster-scoped resources. */
  namespaced?: boolean;
  /**
   * Create mode → name + namespace are editable (namespace is a live dropdown).
   * Otherwise they are immutable primary keys, shown read-only.
   */
  creating?: boolean;
  /** Extra Form.Item(s) rendered inline after namespace (e.g. replicas). */
  extra?: ReactNode;
}

/**
 * "Basic info" section: name + namespace. On create these are editable so a
 * resource can be fully authored in the visual form; on view/edit they are the
 * object's immutable identity, shown read-only.
 */
export default function MetaSection({ draft, onChange, namespaced = true, creating = false, extra }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const meta = draft.metadata || {};
  const [namespaces, setNamespaces] = useState<string[]>([]);

  useEffect(() => {
    if (!namespaced || !creating) return;
    let cancelled = false;
    resourceApi
      .namespaces()
      .then((ns) => {
        if (!cancelled) setNamespaces(ns);
      })
      .catch(() => {
        if (!cancelled) setNamespaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [namespaced, creating]);

  const mono = { fontFamily: token.fontFamilyCode };

  return (
    <Card size="small" title={t('editor.basicInfo')}>
      <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
        {/* Name + namespace share one row with capped widths (full-width
            inputs read as "too long"). */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Form.Item
            label={t('editor.name')}
            required={creating}
            style={{ marginBottom: 0, flex: '1 1 0', minWidth: 180 }}
          >
            <Input
              value={meta.name ?? ''}
              disabled={!creating}
              placeholder={t('editor.namePlaceholder')}
              style={mono}
              onChange={(e) =>
                onChange(
                  update(draft, (d) => {
                    d.metadata = d.metadata || {};
                    d.metadata.name = e.target.value;
                  }),
                )
              }
            />
          </Form.Item>
          {namespaced && (
            <Form.Item
              label={t('editor.namespace')}
              style={{ marginBottom: 0, flex: '1 1 0', minWidth: 180 }}
            >
              {creating ? (
                <AutoComplete
                  value={meta.namespace ?? ''}
                  placeholder="default"
                  style={{ width: '100%', ...mono }}
                  options={namespaces.map((n) => ({ value: n }))}
                  filterOption={(input, opt) =>
                    String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  onChange={(v) =>
                    onChange(
                      update(draft, (d) => {
                        d.metadata = d.metadata || {};
                        d.metadata.namespace = v;
                      }),
                    )
                  }
                />
              ) : (
                <Input value={meta.namespace ?? ''} disabled style={{ width: '100%', ...mono }} />
              )}
            </Form.Item>
          )}
          {extra}
        </div>
      </Form>
    </Card>
  );
}
