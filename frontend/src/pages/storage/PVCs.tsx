import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import type { K8sObject } from '../../api/resource';
import { StatusTag } from '../../utils';

export default function PVCs() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.status'),
      key: 'status',
      width: 130,
      align: 'center',
      render: (_, r) => <StatusTag phase={r.status?.phase} />,
    },
    {
      title: t('resource.capacity'),
      key: 'capacity',
      width: 120,
      align: 'center',
      render: (_, r) =>
        r.status?.capacity?.storage || r.spec?.resources?.requests?.storage || '—',
    },
    {
      title: t('resource.storageClass'),
      key: 'sc',
      width: 180,
      ellipsis: true,
      render: (_, r) => r.spec?.storageClassName || '—',
    },
  ];

  return (
    <ResourceTable
      title={t('pages.pvcs.title')}
      resource="persistentvolumeclaims"
      description={t('pages.pvcs.desc')}
      extraColumns={extra}
    />
  );
}
