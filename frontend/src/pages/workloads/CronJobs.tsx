import { Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import ResourceTable from '../../components/ResourceTable';
import CronJobTrigger from '../../components/CronJobTrigger';
import type { K8sObject } from '../../api/resource';
import { formatAge } from '../../utils';

const { Text } = Typography;

export default function CronJobs() {
  const { t } = useTranslation();

  const extra: ColumnsType<K8sObject> = [
    {
      title: t('resource.schedule'),
      key: 'schedule',
      width: 170,
      render: (_, r) => <Text code>{r.spec?.schedule || '—'}</Text>,
    },
    {
      title: t('resource.suspend'),
      key: 'suspend',
      width: 110,
      align: 'center',
      render: (_, r) =>
        r.spec?.suspend ? (
          <Tag color="orange">{t('common.yes')}</Tag>
        ) : (
          <Tag color="green">{t('common.no')}</Tag>
        ),
    },
    {
      title: t('resource.activeJobs'),
      key: 'active',
      width: 100,
      align: 'center',
      render: (_, r) => (r.status?.active?.length ?? 0) as number,
    },
    {
      title: t('resource.lastSchedule'),
      key: 'lastSchedule',
      width: 150,
      render: (_, r) => formatAge(r.status?.lastScheduleTime),
    },
  ];

  return (
    <ResourceTable
      title={t('nav.cronjobs')}
      resource="cronjobs"
      description={t('pages.cronjobs.desc')}
      extraColumns={extra}
      rowActions={(rec, reload) => <CronJobTrigger rec={rec} onTriggered={reload} />}
      nameLink={(r) => `/workloads/cronjobs/${r.metadata?.namespace}/${r.metadata?.name}`}
    />
  );
}
