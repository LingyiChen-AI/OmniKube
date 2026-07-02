import { useState } from 'react';
import { Button, Space, Table, Tooltip, Typography, App as AntApp } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined, CopyOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { resourceApi } from '../api/resource';
import { useCapabilities } from '../store/caps';
import { defaultPagination } from './tableConfig';

const { Text } = Typography;

const MASK = '••••••••';

interface Props {
  namespace: string;
  name: string;
  /** Base64/plain keys present on the secret (values are masked until revealed). */
  keys: string[];
}

interface Row {
  key: string;
}

/**
 * Renders secret keys masked by default. "Reveal" calls the audited
 * `/reveal` endpoint and toggles to plaintext; toggling back re-masks.
 */
export default function SecretDataView({ namespace, name, keys }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const { can } = useCapabilities();
  const canReveal = can('secrets', 'reveal');
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  const isRevealed = revealed !== null;

  const toggle = async () => {
    if (isRevealed) {
      setRevealed(null);
      return;
    }
    setLoading(true);
    try {
      const res = await resourceApi.revealSecret(namespace, name);
      setRevealed(res.data || {});
    } catch {
      /* interceptor toast */
    } finally {
      setLoading(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(t('secret.copied'));
    } catch {
      message.error(t('secret.copyFailed'));
    }
  };

  const rows: Row[] = keys.map((k) => ({ key: k }));

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        {canReveal && (
          <Button
            type={isRevealed ? 'default' : 'primary'}
            icon={isRevealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            loading={loading}
            onClick={toggle}
            aria-label={isRevealed ? t('secret.hide') : t('secret.reveal')}
          >
            {isRevealed ? t('secret.hide') : t('secret.reveal')}
          </Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('secret.auditNote')}
        </Text>
      </Space>

      <Table<Row>
        rowKey="key"
        size="small"
        pagination={{ ...defaultPagination, size: 'small' }}
        dataSource={rows}
        scroll={{ x: 580 }}
        locale={{ emptyText: t('secret.noKeys') }}
        columns={[
          {
            title: t('secret.key'),
            dataIndex: 'key',
            width: 220,
            fixed: 'left',
            ellipsis: true,
            render: (k: string) => <Text code>{k}</Text>,
          },
          {
            title: t('secret.value'),
            key: 'value',
            width: 360,
            render: (_, row) => {
              const value = isRevealed ? revealed?.[row.key] ?? '' : MASK;
              return (
                <Space>
                  <Text
                    style={{
                      fontFamily: "'Fira Code', monospace",
                      wordBreak: 'break-all',
                    }}
                    data-testid={`secret-value-${row.key}`}
                  >
                    {value}
                  </Text>
                  {isRevealed && (
                    <Tooltip title={t('secret.copy')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => copy(revealed?.[row.key] ?? '')}
                      />
                    </Tooltip>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
    </div>
  );
}
