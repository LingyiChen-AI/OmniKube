import { Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import { JobPodsAction } from '../../components/JobPods';
import type { K8sObject } from '../../api/resource';

export default function Jobs() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.completions'),
      key: 'completions',
      width: 130,
      align: 'center',
      render: (_, r) => {
        const succeeded = r.status?.succeeded ?? 0;
        const desired = r.spec?.completions ?? 1;
        return `${succeeded}/${desired}`;
      },
    },
    {
      title: t('resource.status'),
      key: 'status',
      width: 140,
      align: 'center',
      render: (_, r) => {
        if (r.status?.succeeded) return <Tag color="green">{t('resource.complete')}</Tag>;
        if (r.status?.failed) return <Tag color="red">{t('resource.failed')}</Tag>;
        if (r.status?.active) return <Tag color="blue">{t('resource.running')}</Tag>;
        return <Tag>{t('resource.pending')}</Tag>;
      },
    },
  ];

  return (
    <ResourceTable
      title={t('nav.jobs')}
      resource="jobs"
      description={t('pages.jobs.desc')}
      extraColumns={extra}
      rowActions={(rec) => <JobPodsAction rec={rec} />}
    />
  );
}
