import { useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Popconfirm, Space, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { integratedDeployApi, type DeployOrder } from '../../api/integratedDeploy';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';

function statusTag(status: string, t: (k: string) => string) {
  if (status === 'succeeded') return <Tag color="success">{t('integratedDeploy.statusSucceeded')}</Tag>;
  if (status === 'failed') return <Tag color="error">{t('integratedDeploy.statusFailed')}</Tag>;
  return <Tag>{t('integratedDeploy.statusDraft')}</Tag>;
}

export default function IntegratedDeploy() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user);
  const [orders, setOrders] = useState<DeployOrder[]>([]);
  const [loading, setLoading] = useState(false);

  const canCreate = canGlobal('integrated_deploy', 'create', me);
  const canEdit = canGlobal('integrated_deploy', 'edit', me);
  const canDelete = canGlobal('integrated_deploy', 'delete', me);

  const load = () => {
    setLoading(true);
    integratedDeployApi
      .list()
      .then(setOrders)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const doCopy = async (id: number) => {
    try {
      await integratedDeployApi.copy(id);
      message.success(t('integratedDeploy.copySuccess'));
      load();
    } catch {
      /* interceptor toast */
    }
  };
  const doDelete = async (id: number) => {
    try {
      await integratedDeployApi.remove(id);
      load();
    } catch {
      /* interceptor toast */
    }
  };

  const columns = [
    { title: t('integratedDeploy.orderTitle'), dataIndex: 'title' },
    { title: t('integratedDeploy.cluster'), dataIndex: 'cluster_id' },
    { title: t('integratedDeploy.namespace'), dataIndex: 'namespace' },
    {
      title: t('integratedDeploy.status'),
      dataIndex: 'status',
      render: (s: string) => statusTag(s, t),
    },
    { title: t('integratedDeploy.creator'), dataIndex: 'username' },
    { title: t('integratedDeploy.updatedAt'), dataIndex: 'updated_at' },
    {
      title: t('integratedDeploy.actions'),
      key: 'actions',
      render: (_: unknown, r: DeployOrder) => (
        <Space>
          <Button size="small" onClick={() => navigate(`/integrated-deploy/orders/${r.id}`)}>
            {canEdit ? t('integratedDeploy.edit') : t('integratedDeploy.publish')}
          </Button>
          {canCreate && (
            <Button size="small" onClick={() => doCopy(r.id)}>
              {t('integratedDeploy.copy')}
            </Button>
          )}
          {canDelete && (
            <Popconfirm title={t('integratedDeploy.deleteConfirm')} onConfirm={() => doDelete(r.id)}>
              <Button size="small" danger>
                {t('integratedDeploy.delete')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('integratedDeploy.title')}
      extra={
        canCreate && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/integrated-deploy/new')}>
            {t('integratedDeploy.newOrder')}
          </Button>
        )
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={orders}
        locale={{ emptyText: t('integratedDeploy.empty') }}
      />
    </Card>
  );
}
