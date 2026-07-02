import { Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import WorkloadOps from '../../components/WorkloadOps';
import type { K8sObject } from '../../api/resource';

export default function Deployments() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.ready'),
      key: 'ready',
      width: 120,
      align: 'center',
      render: (_, r) => {
        const ready = r.status?.readyReplicas ?? 0;
        const desired = r.spec?.replicas ?? r.status?.replicas ?? 0;
        const ok = ready === desired && desired > 0;
        return <Tag color={ok ? 'green' : ready === 0 ? 'red' : 'gold'}>{`${ready}/${desired}`}</Tag>;
      },
    },
    {
      title: t('resource.upToDate'),
      key: 'updated',
      width: 120,
      align: 'center',
      render: (_, r) => r.status?.updatedReplicas ?? 0,
    },
    {
      title: t('resource.available'),
      key: 'available',
      width: 120,
      align: 'center',
      render: (_, r) => r.status?.availableReplicas ?? 0,
    },
  ];

  return (
    <ResourceTable
      title={t('nav.deployments')}
      resource="deployments"
      description={t('pages.deployments.desc')}
      extraColumns={extra}
      rowActions={(rec, reload) => (
        <WorkloadOps resource="deployments" rec={rec} onChanged={reload} />
      )}
      nameLink={(d) =>
        `/workloads/deployments/${d.metadata?.namespace}/${d.metadata?.name}`
      }
    />
  );
}
