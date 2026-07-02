import { Badge, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export function formatAge(ts?: string): string {
  if (!ts) return '—';
  const d = dayjs(ts);
  if (!d.isValid()) return '—';
  return d.fromNow();
}

export function formatTime(ts?: string): string {
  if (!ts) return '—';
  const d = dayjs(ts);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—';
}

type BadgeStatus = 'success' | 'error' | 'warning' | 'processing' | 'default';

const clusterStatusMap: Record<string, BadgeStatus> = {
  Healthy: 'success',
  Unreachable: 'error',
  Unknown: 'default',
};

const KNOWN_CLUSTER_STATUS = ['Healthy', 'Unreachable', 'Unknown'];

export function ClusterStatusBadge({ status }: { status?: string }) {
  const { t } = useTranslation();
  const s = clusterStatusMap[status || ''] ?? 'default';
  const raw = status || 'Unknown';
  const text = KNOWN_CLUSTER_STATUS.includes(raw) ? t(`status.${raw}`) : raw;
  return <Badge status={s} text={text} />;
}

const okPhrases = ['Running', 'Active', 'Ready', 'Bound', 'Succeeded', 'Available'];
const badPhrases = ['Failed', 'Error', 'CrashLoopBackOff', 'Lost', 'Unknown', 'Evicted'];
const warnPhrases = ['Pending', 'ContainerCreating', 'Terminating', 'Waiting', 'NotReady', 'Released'];

export function statusColor(phase?: string): string {
  if (!phase) return 'default';
  if (okPhrases.some((p) => phase.includes(p))) return 'success';
  if (badPhrases.some((p) => phase.includes(p))) return 'error';
  if (warnPhrases.some((p) => phase.includes(p))) return 'warning';
  return 'default';
}

export function StatusTag({ phase }: { phase?: string }) {
  if (!phase) return <Tag>—</Tag>;
  const color = statusColor(phase);
  const map: Record<string, string> = {
    success: 'green',
    error: 'red',
    warning: 'gold',
    default: 'default',
  };
  return <Tag color={map[color]}>{phase}</Tag>;
}
