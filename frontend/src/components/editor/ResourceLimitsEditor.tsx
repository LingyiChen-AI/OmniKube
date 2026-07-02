import { Input, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

export interface ResourceSpec {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

interface Props {
  value?: ResourceSpec;
  onChange: (next: ResourceSpec | undefined) => void;
}

type Tier = 'requests' | 'limits';
type Dim = 'cpu' | 'memory';

/**
 * Edits cpu/memory requests and limits as a compact matrix (rows = tier,
 * columns = dimension). Empty fields are pruned so an all-blank resources block
 * collapses to `undefined` rather than leaving empty objects behind.
 */
export default function ResourceLimitsEditor({ value, onChange }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const v = value || {};

  const set = (tier: Tier, dim: Dim, raw: string) => {
    const next: ResourceSpec = {
      requests: { ...(v.requests || {}) },
      limits: { ...(v.limits || {}) },
    };
    if (raw.trim() === '') delete next[tier]![dim];
    else next[tier]![dim] = raw;
    if (next.requests && Object.keys(next.requests).length === 0) delete next.requests;
    if (next.limits && Object.keys(next.limits).length === 0) delete next.limits;
    onChange(next.requests || next.limits ? next : undefined);
  };

  const headCell = (label: string) => (
    <Text type="secondary" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 0.3, textAlign: 'center' }}>
      {label}
    </Text>
  );
  const rowLabel = (label: string) => (
    <Text style={{ fontSize: 12.5, fontWeight: 500, color: token.colorTextSecondary }}>{label}</Text>
  );
  const cell = (tier: Tier, dim: Dim, placeholder: string) => (
    <Input
      size="small"
      style={{ width: '100%', fontFamily: token.fontFamilyCode }}
      placeholder={placeholder}
      value={v[tier]?.[dim] ?? ''}
      onChange={(e) => set(tier, dim, e.target.value)}
    />
  );

  return (
    <div
      style={{
        display: 'inline-grid',
        gridTemplateColumns: '88px 150px 150px',
        gap: 8,
        alignItems: 'center',
        padding: 12,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillQuaternary,
      }}
    >
      <span />
      {headCell(t('editor.cpu'))}
      {headCell(t('editor.memory'))}

      {rowLabel(t('editor.requests'))}
      {cell('requests', 'cpu', '100m')}
      {cell('requests', 'memory', '128Mi')}

      {rowLabel(t('editor.limits'))}
      {cell('limits', 'cpu', '500m')}
      {cell('limits', 'memory', '512Mi')}
    </div>
  );
}
