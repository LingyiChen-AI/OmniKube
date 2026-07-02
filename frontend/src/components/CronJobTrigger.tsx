import { useState } from 'react';
import { Button, Tooltip, App as AntApp } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { resourceApi, type K8sObject } from '../api/resource';
import { useCapabilities } from '../store/caps';

interface Props {
  rec: K8sObject;
  /** Called after a successful trigger, so the list can refresh. */
  onTriggered?: () => void;
}

/**
 * Row action: manually trigger a CronJob. The resulting run (and its Pods / logs)
 * is browsed on the CronJob detail page — open it by clicking the name.
 */
export default function CronJobTrigger({ rec, onTriggered }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { can } = useCapabilities();

  const [busy, setBusy] = useState(false);
  if (!can('cronjobs', 'edit')) return null;

  const ns = rec.metadata?.namespace || 'default';
  const name = rec.metadata?.name || '';

  const doTrigger = async () => {
    setBusy(true);
    try {
      const jobName = await resourceApi.triggerCronJob(ns, name);
      message.success(t('cronjob.triggered', { job: jobName }));
      onTriggered?.();
    } catch {
      /* interceptor toast */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip title={t('cronjob.trigger')}>
      <Button
        type="text"
        size="small"
        icon={<ThunderboltOutlined />}
        loading={busy}
        onClick={doTrigger}
      />
    </Tooltip>
  );
}
