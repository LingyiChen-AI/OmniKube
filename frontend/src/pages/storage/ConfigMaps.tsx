import { Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';

export default function ConfigMaps() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.keys'),
      key: 'keys',
      width: 110,
      align: 'center',
      render: (_, r) => <Tag>{Object.keys(r.data || {}).length}</Tag>,
    },
  ];

  return (
    <ResourceTable
      title={t('nav.configmaps')}
      resource="configmaps"
      description={t('pages.configmaps.desc')}
      extraColumns={extra}
    />
  );
}
