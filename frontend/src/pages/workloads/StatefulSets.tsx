import { Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import WorkloadOps from '../../components/WorkloadOps';
import type { K8sObject } from '../../api/resource';

export default function StatefulSets() {
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
      title: t('resource.service'),
      key: 'svc',
      width: 200,
      ellipsis: true,
      render: (_, r) => r.spec?.serviceName || '—',
    },
  ];

  return (
    <ResourceTable
      title={t('nav.statefulsets')}
      resource="statefulsets"
      description={t('pages.statefulsets.desc')}
      extraColumns={extra}
      rowActions={(rec, reload) => (
        <WorkloadOps resource="statefulsets" rec={rec} onChanged={reload} />
      )}
      nameLink={(s) =>
        `/workloads/statefulsets/${s.metadata?.namespace}/${s.metadata?.name}`
      }
    />
  );
}
