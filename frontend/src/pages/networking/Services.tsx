import { Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';

const { Text } = Typography;

export default function Services() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.type'),
      key: 'type',
      width: 130,
      align: 'center',
      render: (_, r) => <Tag color="geekblue">{r.spec?.type || 'ClusterIP'}</Tag>,
    },
    {
      title: t('resource.clusterIp'),
      key: 'clusterip',
      width: 160,
      ellipsis: true,
      render: (_, r) => <Text type="secondary">{r.spec?.clusterIP || '—'}</Text>,
    },
    {
      title: t('resource.ports'),
      key: 'ports',
      width: 240,
      render: (_, r) => {
        const ports = (r.spec?.ports || []) as any[];
        if (!ports.length) return '—';
        return (
          <Space size={[4, 4]} wrap>
            {ports.map((p, i) => (
              <Tag key={i} style={{ margin: 0 }}>
                {p.port}
                {p.nodePort ? `:${p.nodePort}` : ''}/{p.protocol || 'TCP'}
              </Tag>
            ))}
          </Space>
        );
      },
    },
  ];

  return (
    <ResourceTable
      title={t('nav.services')}
      resource="services"
      description={t('pages.services.desc')}
      extraColumns={extra}
    />
  );
}
