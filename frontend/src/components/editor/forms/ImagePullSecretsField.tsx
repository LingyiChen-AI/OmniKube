import { Form, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { useClusterList } from './useClusterList';

interface Props {
  /** Current imagePullSecrets: array of { name }. */
  value?: { name?: string }[];
  onChange: (next: { name: string }[]) => void;
  namespace: string;
  style?: React.CSSProperties;
}

/**
 * Pod-level image pull secrets — a multi-select of Secrets in the namespace (for
 * private registries). Still free-text so a not-yet-created secret can be named.
 */
export default function ImagePullSecretsField({ value, onChange, namespace, style }: Props) {
  const { t } = useTranslation();
  const { items: secrets } = useClusterList('secrets', namespace);
  const names = (value ?? []).map((s) => s.name).filter(Boolean) as string[];

  return (
    <Form.Item label={t('editor.imagePullSecrets')} style={{ marginBottom: 0, ...style }}>
      <Select
        mode="tags"
        allowClear
        placeholder={t('editor.imagePullSecretsHint')}
        style={{ width: '100%' }}
        value={names}
        options={secrets.map((s) => ({ value: s.metadata?.name, label: s.metadata?.name }))}
        onChange={(v: string[]) => onChange(v.map((name) => ({ name })))}
      />
    </Form.Item>
  );
}
