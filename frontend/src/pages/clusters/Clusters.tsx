import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Divider,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  App as AntApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  ReloadOutlined,
  DeleteOutlined,
  EditOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { clusterApi, type Cluster } from '../../api/cluster';
import { useClusterStore } from '../../store/clusters';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';
import { ClusterStatusBadge, formatTime } from '../../utils';
import { defaultTableProps, defaultPagination, colW, tableScrollX } from '../../components/tableConfig';
import CodeBox from '../../components/editor/CodeBox';

const { Title, Text } = Typography;

type TestState = 'idle' | 'testing' | 'passed' | 'failed';

export default function Clusters() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const me = useAuthStore((s) => s.user);
  const canCreate = canGlobal('clusters', 'create', me);
  const canEdit = canGlobal('clusters', 'edit', me);
  const canDelete = canGlobal('clusters', 'delete', me);
  const [form] = Form.useForm();
  const kubeconfigVal = Form.useWatch('kubeconfig', form);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Cluster | null>(null);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { clusters, loading, load, refresh } = useClusterStore();

  useEffect(() => {
    load();
  }, [load]);

  const resetDrawer = () => {
    form.resetFields();
    setTestState('idle');
    setTestMsg('');
  };

  const openDrawer = () => {
    resetDrawer();
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (cl: Cluster) => {
    resetDrawer();
    setEditing(cl);
    form.setFieldsValue({
      id: cl.id,
      name: cl.name,
      kubeconfig: '',
      webhooks: cl.webhooks ?? [],
    });
    setOpen(true);
  };

  // Editing the kubeconfig invalidates a prior successful test.
  const onValuesChange = (changed: any) => {
    if ('kubeconfig' in changed) {
      setTestState('idle');
      setTestMsg('');
    }
  };

  const onTest = async () => {
    const kubeconfig = form.getFieldValue('kubeconfig');
    if (!kubeconfig?.trim()) {
      message.warning(t('cluster.pasteFirst'));
      return;
    }
    setTestState('testing');
    try {
      const res = await clusterApi.test(kubeconfig);
      const ok = res.ok !== false && (res.code === undefined || res.code === 0);
      if (ok) {
        setTestState('passed');
        setTestMsg(
          res.server_version
            ? t('cluster.reachable', { version: res.server_version })
            : t('cluster.connectionSuccessful'),
        );
      } else {
        setTestState('failed');
        setTestMsg(res.message || t('cluster.connectionFailed'));
      }
    } catch (e: any) {
      setTestState('failed');
      setTestMsg(e?.response?.data?.message || t('cluster.connectionFailed'));
    }
  };

  const onSubmit = async () => {
    const values = await form.validateFields();
    const kubeconfig = (values.kubeconfig || '').trim();
    // Editing without changing the kubeconfig needs no connectivity re-test.
    const needTest = editing ? !!kubeconfig : true;
    if (needTest && testState !== 'passed') {
      message.warning(t('cluster.testFirst'));
      return;
    }
    const webhooks = ((values.webhooks || []) as { type?: string; url?: string; secret?: string }[])
      .filter((w) => w.type && w.url?.trim())
      .map((w) => ({
        type: w.type as any,
        url: w.url!.trim(),
        secret: w.secret?.trim() || undefined,
      }));
    setSubmitting(true);
    try {
      if (editing) {
        await clusterApi.update(editing.id, {
          name: values.name,
          ...(kubeconfig ? { kubeconfig } : {}),
          webhooks,
        });
        message.success(t('cluster.updated'));
      } else {
        await clusterApi.create({ id: values.id, name: values.name, kubeconfig });
        // Webhooks aren't part of create — persist them right after if any.
        if (webhooks.length) await clusterApi.update(values.id, { webhooks });
        message.success(t('cluster.added'));
      }
      setOpen(false);
      resetDrawer();
      // Refresh the shared store so the TopBar dropdown updates immediately.
      refresh();
    } catch {
      /* interceptor toast */
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await clusterApi.remove(id);
      message.success(t('cluster.removed'));
      // Refresh the shared store so the TopBar dropdown updates immediately.
      refresh();
    } catch {
      /* interceptor toast */
    }
  };

  const columns: ColumnsType<Cluster> = [
    {
      title: t('cluster.name'),
      dataIndex: 'name',
      width: colW.name,
      fixed: 'left',
      ellipsis: true,
      render: (v: string, r) => (
        <Text strong ellipsis={{ tooltip: v || r.id }} style={{ maxWidth: '100%' }}>
          {v || r.id}
        </Text>
      ),
    },
    {
      title: t('cluster.id'),
      dataIndex: 'id',
      width: colW.text,
      ellipsis: true,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: t('cluster.status'),
      dataIndex: 'status',
      width: 160,
      align: 'center',
      render: (v: string) => <ClusterStatusBadge status={v} />,
    },
    {
      title: t('cluster.lastCheck'),
      dataIndex: 'last_check',
      width: 200,
      render: (v: string) => <Text type="secondary">{formatTime(v)}</Text>,
    },
    {
      title: t('cluster.actions'),
      key: 'actions',
      align: 'right',
      width: colW.actions,
      fixed: 'right',
      render: (_, r) => (
        <Space size={2}>
          {canEdit && (
            <Tooltip title={t('cluster.edit')}>
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
            </Tooltip>
          )}
          {canDelete && (
            <Popconfirm
              title={t('cluster.remove')}
              description={t('cluster.removeConfirm', { name: r.name || r.id })}
              okText={t('cluster.removeOk')}
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(r.id)}
            >
              <Tooltip title={t('resource.delete')}>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {!canEdit && !canDelete && <Text type="secondary">—</Text>}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          marginBottom: 18,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            {t('cluster.title')}
          </Title>
          <Text type="secondary">{t('cluster.subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            {t('resource.refresh')}
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openDrawer}>
              {t('cluster.add')}
            </Button>
          )}
        </Space>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<Cluster>
          rowKey="id"
          columns={columns}
          dataSource={clusters}
          loading={loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          pagination={defaultPagination}
        />
      </Card>

      <Drawer
        title={editing ? t('cluster.editTitle') : t('cluster.addTitle')}
        width="min(1100px, 92vw)"
        open={open}
        onClose={() => setOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={
                editing
                  ? !!(kubeconfigVal || '').trim() && testState !== 'passed'
                  : testState !== 'passed'
              }
              onClick={onSubmit}
            >
              {t('cluster.save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onValuesChange={onValuesChange} requiredMark>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item
              style={{ flex: 1 }}
              label={t('cluster.clusterId')}
              name="id"
              rules={[
                { required: true, message: t('cluster.errId') },
                { pattern: /^[a-z0-9][a-z0-9-]*$/, message: t('cluster.errIdPattern') },
              ]}
            >
              <Input placeholder={t('cluster.idPlaceholder')} disabled={!!editing} />
            </Form.Item>
            <Form.Item
              style={{ flex: 1 }}
              label={t('cluster.displayName')}
              name="name"
              rules={[{ required: true, message: t('cluster.errName') }]}
            >
              <Input placeholder={t('cluster.namePlaceholder')} />
            </Form.Item>
          </div>
          <Form.Item
            label={t('cluster.kubeconfig')}
            name="kubeconfig"
            initialValue=""
            rules={editing ? [] : [{ required: true, message: t('cluster.errKubeconfig') }]}
          >
            <CodeBox
              label="YAML"
              ariaLabel="kubeconfig"
              placeholder={editing ? t('cluster.kubeconfigKeep') : 'apiVersion: v1\nclusters:\n- cluster: ...'}
              height="calc(100vh - 520px)"
              minHeight={180}
            />
          </Form.Item>

          <Space style={{ marginBottom: 12 }} wrap>
            <Button
              icon={<ApiOutlined />}
              loading={testState === 'testing'}
              onClick={onTest}
            >
              {t('cluster.testConnection')}
            </Button>
            {/* Inline one-liner status instead of a big alert box. */}
            {testState === 'idle' && (
              <Text type="warning" style={{ fontSize: 12 }}>
                <ExclamationCircleOutlined /> {editing ? t('cluster.kubeconfigKeep') : t('cluster.testBeforeSave')}
              </Text>
            )}
            {testState === 'passed' && (
              <Text type="success" style={{ fontSize: 12 }}>
                <CheckCircleOutlined /> {testMsg || t('cluster.verified')}
              </Text>
            )}
            {testState === 'failed' && (
              <Text type="danger" style={{ fontSize: 12 }}>
                <CloseCircleOutlined /> {testMsg || t('cluster.connectionFailed')}
              </Text>
            )}
          </Space>

          {/* Release-notification bots */}
          <Divider style={{ margin: '4px 0 14px' }} />
          <div style={{ marginBottom: 8 }}>
            <Text strong>{t('cluster.webhooks')}</Text>
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              {t('cluster.webhooksHint')}
            </Text>
          </div>
          <Form.List name="webhooks">
            {(fields, { add, remove }) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fields.map(({ key, name, ...rest }) => (
                  <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <Form.Item {...rest} name={[name, 'type']} initialValue="dingtalk" style={{ marginBottom: 0, width: 150 }}>
                      <Select
                        options={[
                          { value: 'dingtalk', label: t('cluster.webhookDingtalk') },
                          { value: 'feishu', label: t('cluster.webhookFeishu') },
                          { value: 'wecom', label: t('cluster.webhookWecom') },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'url']} style={{ marginBottom: 0, flex: 1, minWidth: 0 }}>
                      <Input placeholder={t('cluster.webhookUrlPlaceholder')} />
                    </Form.Item>
                    <Form.Item {...rest} name={[name, 'secret']} style={{ marginBottom: 0, width: 200 }}>
                      <Input.Password
                        autoComplete="off"
                        placeholder={t('cluster.webhookSecretPlaceholder')}
                      />
                    </Form.Item>
                    <Button type="text" icon={<MinusCircleOutlined />} aria-label="remove-webhook" onClick={() => remove(name)} />
                  </div>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ type: 'dingtalk', url: '' })} style={{ alignSelf: 'flex-start' }}>
                  {t('cluster.addWebhook')}
                </Button>
              </div>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </div>
  );
}
