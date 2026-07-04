import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
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
  SafetyCertificateOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { useTranslation, Trans } from 'react-i18next';
import { userApi, type ManagedUser, type CreatedUser } from '../../api/user';
import { roleApi, type RoleView } from '../../api/role';
import { roleName } from '../../roleLabels';
import { useApi } from '../../hooks/useApi';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';
import { defaultTableProps, defaultPagination, colW, tableScrollX } from '../../components/tableConfig';

const { Title, Text, Paragraph } = Typography;

export default function Users() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const me = useAuthStore((s) => s.user);
  const canCreate = canGlobal('users', 'create', me);
  const canEdit = canGlobal('users', 'edit', me);
  const canDelete = canGlobal('users', 'delete', me);
  // Resetting a password is a sensitive op — only system administrators.
  const isAdmin = !!me?.is_admin;
  const [createForm] = Form.useForm();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tempUser, setTempUser] = useState<CreatedUser | null>(null);
  // Whether the temp-password modal reflects a reset (vs. a fresh create).
  const [tempReset, setTempReset] = useState(false);
  const [rolesUser, setRolesUser] = useState<ManagedUser | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const usersPaged = useApi(
    () => userApi.listPaged({ limit: pageSize, offset: (page - 1) * pageSize }),
    [page, pageSize],
    { initial: { users: [], total: 0 } },
  );
  const users = {
    data: usersPaged.data?.users ?? [],
    loading: usersPaged.loading,
    reload: usersPaged.reload,
  };
  // Role-assignment dropdown keeps the full unpaged list (all roles).
  const roles = useApi<RoleView[]>(() => roleApi.list(), [], { initial: [] });

  const roleOptions = (roles.data ?? []).map((r) => ({ value: r.id, label: roleName(t, r) }));

  const onCreate = async () => {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      const created = await userApi.create(values.username, values.role_ids ?? []);
      setCreateOpen(false);
      createForm.resetFields();
      setTempReset(false);
      setTempUser(created);
      users.reload();
    } catch {
      /* interceptor toast */
    } finally {
      setCreating(false);
    }
  };

  const onToggle = async (u: ManagedUser) => {
    try {
      await (u.disabled ? userApi.enable(u.id) : userApi.disable(u.id));
      message.success(u.disabled ? t('user.userEnabled') : t('user.userDisabled'));
      users.reload();
    } catch {
      /* interceptor toast */
    }
  };

  const onDelete = async (u: ManagedUser) => {
    try {
      await userApi.remove(u.id);
      message.success(t('user.deleted'));
      users.reload();
    } catch {
      /* interceptor toast */
    }
  };

  const onReset = async (u: ManagedUser) => {
    try {
      const res = await userApi.resetPassword(u.id);
      setTempReset(true);
      setTempUser(res); // reuse the one-time temp-password reveal modal
      users.reload();
    } catch {
      /* interceptor toast */
    }
  };

  const copyTemp = async () => {
    if (!tempUser) return;
    try {
      await navigator.clipboard.writeText(tempUser.temp_password);
      message.success(t('user.tempCopied'));
    } catch {
      message.error(t('secret.copyFailed'));
    }
  };

  const columns: ColumnsType<ManagedUser> = [
    {
      title: t('user.username'),
      dataIndex: 'username',
      width: colW.name,
      fixed: 'left',
      ellipsis: true,
      render: (v: string) => (
        <Text strong ellipsis={{ tooltip: v }} style={{ maxWidth: '100%' }}>
          {v}
        </Text>
      ),
    },
    {
      title: t('user.kind'),
      dataIndex: 'is_admin',
      width: 130,
      align: 'center',
      render: (admin: boolean) =>
        admin ? <Tag color="geekblue">{t('user.administrator')}</Tag> : <Tag>{t('user.member')}</Tag>,
    },
    {
      title: t('user.roles'),
      dataIndex: 'roles',
      width: 260,
      render: (rs: ManagedUser['roles'], u) =>
        u.is_admin ? (
          <Tag color="geekblue">{t('user.allAccess')}</Tag>
        ) : rs && rs.length ? (
          <Space size={4} wrap>
            {rs.map((r) => (
              <Tag color="cyan" key={r.id}>
                {roleName(t, r)}
              </Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">{t('user.noRoles')}</Text>
        ),
    },
    {
      title: t('user.status'),
      dataIndex: 'disabled',
      width: 120,
      align: 'center',
      render: (disabled: boolean) =>
        disabled ? <Tag color="red">{t('user.disabled')}</Tag> : <Tag color="green">{t('user.active')}</Tag>,
    },
    {
      title: t('user.actions'),
      key: 'actions',
      align: 'right',
      width: colW.actions,
      fixed: 'right',
      render: (_, u) => (
        <Space size={2}>
          {canEdit && (
            <Tooltip title={t('user.editRoles')}>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                disabled={u.is_admin}
                onClick={() => setRolesUser(u)}
              />
            </Tooltip>
          )}
          {canEdit && (
            <Tooltip title={u.disabled ? t('user.enable') : t('user.disable')}>
              <Button
                type="text"
                size="small"
                icon={u.disabled ? <CheckCircleOutlined /> : <StopOutlined />}
                onClick={() => onToggle(u)}
              />
            </Tooltip>
          )}
          {isAdmin && !u.is_admin && (
            <Popconfirm
              title={t('user.resetPassword')}
              description={t('user.resetConfirm', { name: u.username })}
              okText={t('user.resetPassword')}
              onConfirm={() => onReset(u)}
            >
              <Tooltip title={t('user.resetPassword')}>
                <Button type="text" size="small" icon={<KeyOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {canDelete && (
            <Popconfirm
              title={t('user.deleteUser')}
              description={t('user.deleteConfirm', { name: u.username })}
              okText={t('resource.delete')}
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(u)}
            >
              <Tooltip title={t('resource.delete')}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
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
            {t('user.title')}
          </Title>
          <Text type="secondary">{t('user.subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={users.reload} loading={users.loading}>
            {t('resource.refresh')}
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('user.create')}
            </Button>
          )}
        </Space>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<ManagedUser>
          rowKey="id"
          columns={columns}
          dataSource={users.data}
          loading={users.loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          pagination={{
            ...defaultPagination,
            current: page,
            pageSize,
            total: usersPaged.data?.total ?? 0,
            showSizeChanger: true,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </Card>

      {/* Create user */}
      <Modal
        title={t('user.createTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={onCreate}
        confirmLoading={creating}
        okText={t('user.createOk')}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" requiredMark={false}>
          <Form.Item
            label={t('user.username')}
            name="username"
            rules={[
              { required: true, message: t('user.errUsername') },
              { pattern: /^[a-zA-Z0-9._-]{3,}$/, message: t('user.errUsernamePattern') },
            ]}
          >
            <Input placeholder={t('user.usernamePlaceholder')} autoFocus />
          </Form.Item>
          <Form.Item label={t('user.roles')} name="role_ids" extra={t('user.rolesHint')}>
            <Select
              mode="multiple"
              allowClear
              placeholder={t('user.selectRoles')}
              aria-label="user-roles"
              options={roleOptions}
              loading={roles.loading}
            />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('user.tempHint')}
          </Text>
        </Form>
      </Modal>

      {/* One-time temp password */}
      <Modal
        title={
          <Space>
            <KeyOutlined />
            {t('user.tempTitle')}
          </Space>
        }
        open={!!tempUser}
        onCancel={() => setTempUser(null)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={copyTemp}>
            {t('user.copy')}
          </Button>,
          <Button key="done" type="primary" onClick={() => setTempUser(null)}>
            {t('user.done')}
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('user.shownOnce')}
          description={t('user.tempWarnDesc')}
        />
        <Paragraph>
          <Trans
            i18nKey={tempReset ? 'user.passwordReset' : 'user.userCreated'}
            values={{ name: tempUser?.username }}
            components={{ b: <Text strong /> }}
          />
        </Paragraph>
        <Input.Group compact>
          <Input
            readOnly
            value={tempUser?.temp_password}
            style={{
              width: 'calc(100% - 90px)',
              fontFamily: "'Fira Code', monospace",
              fontSize: 15,
            }}
          />
          <Button type="primary" style={{ width: 90 }} icon={<CopyOutlined />} onClick={copyTemp}>
            {t('user.copy')}
          </Button>
        </Input.Group>
      </Modal>

      {/* Edit roles */}
      <Drawer
        title={
          <Space>
            <SafetyCertificateOutlined />
            {t('user.editRolesTitle')} · {rolesUser?.username}
          </Space>
        }
        width={480}
        open={!!rolesUser}
        onClose={() => setRolesUser(null)}
        destroyOnClose
      >
        {rolesUser && (
          <EditRolesPanel
            user={rolesUser}
            roleOptions={roleOptions}
            loading={roles.loading}
            onSaved={() => {
              setRolesUser(null);
              users.reload();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

interface EditRolesPanelProps {
  user: ManagedUser;
  roleOptions: { value: number; label: string }[];
  loading: boolean;
  onSaved: () => void;
}

function EditRolesPanel({ user, roleOptions, loading, onSaved }: EditRolesPanelProps) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [roleIds, setRoleIds] = useState<number[]>(user.roles?.map((r) => r.id) ?? []);
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    setSaving(true);
    try {
      await userApi.setRoles(user.id, roleIds);
      message.success(t('user.rolesUpdated'));
      onSaved();
    } catch {
      /* interceptor toast */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Text type="secondary">{t('user.editRolesHint')}</Text>
      <div style={{ marginTop: 12 }}>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder={t('user.selectRoles')}
          aria-label="edit-user-roles"
          value={roleIds}
          onChange={setRoleIds}
          options={roleOptions}
          loading={loading}
        />
      </div>
      <div style={{ marginTop: 20 }}>
        <Button type="primary" loading={saving} onClick={onSave}>
          {t('user.saveRoles')}
        </Button>
      </div>
    </div>
  );
}
