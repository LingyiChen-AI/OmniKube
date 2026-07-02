import { Space, Tag, Typography } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';

const { Text } = Typography;

export default function Ingresses() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.class'),
      key: 'class',
      width: 140,
      ellipsis: true,
      render: (_, r) => r.spec?.ingressClassName || '—',
    },
    {
      title: t('resource.rules'),
      key: 'rules',
      width: 360,
      render: (_, r) => {
        const rules = (r.spec?.rules || []) as any[];
        if (!rules.length) return '—';
        return (
          <Space direction="vertical" size={2}>
            {rules.flatMap((rule, ri) => {
              const paths = rule.http?.paths || [];
              return paths.map((p: any, pi: number) => {
                const svc = p.backend?.service?.name || p.backend?.serviceName || '—';
                return (
                  <span key={`${ri}-${pi}`}>
                    <Tag color="cyan">{rule.host || '*'}</Tag>
                    <Text type="secondary">{p.path || '/'}</Text>{' '}
                    <ArrowRightOutlined style={{ fontSize: 11, opacity: 0.6 }} />{' '}
                    <Tag>{svc}</Tag>
                  </span>
                );
              });
            })}
          </Space>
        );
      },
    },
  ];

  return (
    <ResourceTable
      title={t('nav.ingresses')}
      resource="ingresses"
      description={t('pages.ingresses.desc')}
      extraColumns={extra}
    />
  );
}
