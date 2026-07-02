import { useState } from 'react';
import { Button, Drawer, Tag, Tooltip, Typography } from 'antd';
import { UnlockOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import SecretDataView from '../../components/SecretDataView';
import type { K8sObject } from '../../api/resource';
import { useCtxStore } from '../../store/ctx';
import { useCapabilities } from '../../store/caps';

const { Text } = Typography;

export default function Secrets() {
  const { t } = useTranslation();
  const { currentNamespace } = useCtxStore();
  const { can } = useCapabilities();
  const canReveal = can('secrets', 'reveal');
  const [active, setActive] = useState<K8sObject | null>(null);

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.type'),
      key: 'type',
      width: 240,
      ellipsis: true,
      render: (_, r) => <Text type="secondary">{r.type || 'Opaque'}</Text>,
    },
    {
      title: t('resource.keys'),
      key: 'keys',
      width: 100,
      align: 'center',
      render: (_, r) => <Tag>{Object.keys(r.data || {}).length}</Tag>,
    },
  ];

  const rowActions = canReveal
    ? (rec: K8sObject) => (
        <Tooltip title={t('secret.reveal')}>
          <Button
            type="text"
            size="small"
            icon={<UnlockOutlined />}
            onClick={() => setActive(rec)}
          />
        </Tooltip>
      )
    : undefined;

  return (
    <>
      <ResourceTable
        title={t('nav.secrets')}
        resource="secrets"
        description={t('pages.secrets.desc')}
        extraColumns={extra}
        rowActions={rowActions}
      />

      <Drawer
        open={!!active}
        onClose={() => setActive(null)}
        width={640}
        destroyOnClose
        title={`${t('secret.secretTitle')} · ${active?.metadata?.name}`}
      >
        {active && (
          <SecretDataView
            namespace={active.metadata?.namespace || currentNamespace || 'default'}
            name={active.metadata?.name || ''}
            keys={Object.keys(active.data || {})}
          />
        )}
      </Drawer>
    </>
  );
}
