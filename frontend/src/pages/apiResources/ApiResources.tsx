import { useEffect, useMemo, useState } from 'react';
import { Card, Checkbox, Empty, Select, Space, Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import { apiResourcesApi, apiVersionOf, type ApiResourceType } from '../../api/apiResources';
import { useCtxStore } from '../../store/ctx';

const { Title, Text } = Typography;

/** 通用资源浏览器:发现集群里的任意资源类型(含 CRD),选中后复用 ResourceTable。 */
export default function ApiResources() {
  const { t } = useTranslation();
  const { currentCluster } = useCtxStore();
  const [types, setTypes] = useState<ApiResourceType[]>([]);
  const [loading, setLoading] = useState(false);
  const [hideBuiltin, setHideBuiltin] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const keyOf = (r: ApiResourceType) => `${r.group}/${r.version}/${r.resource}`;

  useEffect(() => {
    if (!currentCluster) {
      setTypes([]);
      setSelected(null);
      setLoading(false); // clear any in-flight spinner when the cluster is lost
      return;
    }
    let active = true;
    setLoading(true);
    apiResourcesApi
      .list()
      .then((list) => {
        if (!active) return;
        setTypes(list);
      })
      .catch(() => {
        if (active) setTypes([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentCluster]);

  useEffect(() => {
    if (selected && !types.some((r) => keyOf(r) === selected)) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types]);

  const visible = useMemo(
    () => types.filter((r) => (hideBuiltin ? !r.builtin : true)),
    [types, hideBuiltin],
  );

  const options = useMemo(() => {
    const byGroup = new Map<string, ApiResourceType[]>();
    for (const r of visible) {
      const g = r.group || 'core';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    return Array.from(byGroup.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, rs]) => ({
        label: g,
        options: rs.map((r) => ({
          value: keyOf(r),
          label: `${r.kind} · ${r.resource}`,
        })),
      }));
  }, [visible]);

  const sel = useMemo(() => types.find((r) => keyOf(r) === selected) ?? null, [types, selected]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Title level={4} style={{ margin: 0 }}>
          <ApiOutlined /> {t('apiResources.title')}
        </Title>
        <Text type="secondary">{t('apiResources.desc')}</Text>
      </div>
      <Card>
        <Space wrap size="middle" style={{ width: '100%' }}>
          <Select
            style={{ minWidth: 360 }}
            loading={loading}
            showSearch
            placeholder={t('apiResources.pickType')}
            value={selected ?? undefined}
            onChange={(v) => setSelected(v)}
            options={options}
            optionFilterProp="label"
            disabled={!currentCluster}
          />
          <Checkbox checked={hideBuiltin} onChange={(e) => setHideBuiltin(e.target.checked)}>
            {t('apiResources.hideBuiltin')}
          </Checkbox>
        </Space>
      </Card>
      {sel ? (
        <ResourceTable
          key={selected ?? undefined}
          title={`${sel.kind} · ${sel.resource}`}
          resource={sel.resource}
          namespaced={sel.namespaced}
          kind={sel.kind}
          apiVersion={apiVersionOf(sel)}
        />
      ) : (
        <Card>
          <Empty description={t('apiResources.pickType')} />
        </Card>
      )}
    </div>
  );
}
