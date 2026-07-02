import type { ColumnsType } from 'antd/es/table';
import { Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';
import { StatusTag } from '../../utils';

const { Text } = Typography;

export default function PersistentVolumes() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.capacity'),
      key: 'capacity',
      width: 120,
      align: 'center',
      render: (_, r) => r.spec?.capacity?.storage || '—',
    },
    {
      title: t('node.accessModes'),
      key: 'accessModes',
      width: 160,
      render: (_, r) => {
        const modes = (r.spec?.accessModes ?? []) as string[];
        return modes.length ? (
          <Space size={[4, 4]} wrap>
            {modes.map((m) => (
              <Text key={m} type="secondary" style={{ fontSize: 12 }}>
                {m}
              </Text>
            ))}
          </Space>
        ) : (
          '—'
        );
      },
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: 120,
      align: 'center',
      render: (_, r) => <StatusTag phase={r.status?.phase} />,
    },
    {
      title: t('resource.storageClass'),
      key: 'sc',
      width: 160,
      ellipsis: true,
      render: (_, r) => r.spec?.storageClassName || '—',
    },
    {
      title: t('node.claim'),
      key: 'claim',
      width: 200,
      ellipsis: true,
      render: (_, r) => {
        const ref = r.spec?.claimRef as { namespace?: string; name?: string } | undefined;
        if (!ref?.name) return <Text type="secondary">—</Text>;
        return (
          <Text type="secondary" ellipsis>
            {ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name}
          </Text>
        );
      },
    },
  ];

  return (
    <ResourceTable
      title={t('nav.persistentvolumes')}
      resource="persistentvolumes"
      namespaced={false}
      description={t('pages.persistentvolumes.desc')}
      extraColumns={extra}
    />
  );
}
