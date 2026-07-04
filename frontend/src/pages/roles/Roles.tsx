import { Fragment, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Divider,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Radio,
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
  EyeOutlined,
  MinusCircleOutlined,
  SafetyOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  roleApi,
  cleanOperations,
  cleanGlobalPerms,
  actionsForResource,
  actionAppliesToResource,
  actionsForGlobalArea,
  ALL_RESOURCES,
  TREE_ACTIONS,
  BASE_ACTIONS,
  MODULE_KEYS,
  MODULE_RESOURCES,
  isClusterScopedResource,
  stripClusterScopedOps,
  SYSTEM_AREAS,
  ALL_CLUSTERS,
  type RoleView,
  type RoleRulePayload,
  type RuleScope,
  type Operations,
  type GlobalPerms,
  type GlobalArea,
  type ModuleKey,
  type TreeAction,
} from '../../api/role';
import type { Cluster } from '../../api/cluster';
import { resourceApi } from '../../api/resource';
import { useApi } from '../../hooks/useApi';
import { useClusterStore } from '../../store/clusters';
import { useCtxStore } from '../../store/ctx';
import { useAuthStore } from '../../store/auth';
import { canGlobal } from '../../nav';
import { roleName, roleDesc } from '../../roleLabels';
import { defaultTableProps, defaultPagination, tableScrollX } from '../../components/tableConfig';

const { Title, Text } = Typography;

/** A draft rule in the builder: a single cluster with a per-resource operations matrix. */
export interface RuleDraft {
  cluster_id: string; // '' until chosen, '*' = all clusters
  scope: RuleScope;
  namespaces: string[];
  operations: Operations;
}

function emptyRule(): RuleDraft {
  return { cluster_id: '', scope: 'cluster', namespaces: [], operations: {} };
}

/** Deep-clone a rule's config (scope/namespaces/operations) onto a fresh, cluster-less card. */
export function cloneRuleConfig(src: RuleDraft): RuleDraft {
  const operations: Operations = {};
  for (const [res, acts] of Object.entries(src.operations)) {
    if (acts?.length) operations[res] = [...acts];
  }
  return {
    cluster_id: '',
    scope: src.scope,
    namespaces: [...src.namespaces],
    operations,
  };
}

/** The display modules this role grants any action on (drives the table summary). */
function grantedModules(role: RoleView): ModuleKey[] {
  const set = new Set<ModuleKey>();
  for (const rule of role.rules) {
    for (const m of MODULE_KEYS) {
      if (MODULE_RESOURCES[m].some((res) => (rule.operations?.[res]?.length ?? 0) > 0)) {
        set.add(m);
      }
    }
  }
  return MODULE_KEYS.filter((m) => set.has(m));
}

/** The global areas this role grants any action on. */
function grantedGlobalAreas(role: RoleView): string[] {
  return Object.entries(role.global_perms ?? {})
    .filter(([, acts]) => (acts?.length ?? 0) > 0)
    .map(([area]) => area);
}

/** Map a role's backend rules into builder drafts (one card per single cluster). */
function rulesFromRole(role: RoleView): RuleDraft[] {
  return role.rules.map((r) => ({
    cluster_id: r.cluster_id,
    scope: r.scope,
    namespaces: [...(r.namespaces ?? [])],
    operations: { ...(r.operations ?? {}) },
  }));
}

export default function Roles() {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<RoleView | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const [saving, setSaving] = useState(false);

  const me = useAuthStore((s) => s.user);
  const canCreate = canGlobal('roles', 'create', me);
  const canEdit = canGlobal('roles', 'edit', me);
  const canDelete = canGlobal('roles', 'delete', me);

  const roles = useApi<RoleView[]>(() => roleApi.list(), [], { initial: [] });
  const { clusters, load: loadClusters } = useClusterStore();

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);

  const openCreate = () => {
    setEditing(null);
    setReadonly(false);
    form.setFieldsValue({ name: '', description: '', global_perms: {}, rules: [emptyRule()] });
    setDrawerOpen(true);
  };

  // 复制角色：以现有角色的配置预填创建抽屉（editing=null → POST 新建）。
  const openCopy = (role: RoleView) => {
    setEditing(null);
    setReadonly(false);
    const rules = rulesFromRole(role);
    form.setFieldsValue({
      name: t('role.copyName', { name: roleName(t, role) }),
      description: roleDesc(t, role),
      global_perms: role.global_perms ?? {},
      rules: rules.length ? rules : [emptyRule()],
    });
    setDrawerOpen(true);
  };

  // System 预设角色只能查看（readonly）；自定义角色可编辑。
  const openEdit = (role: RoleView) => {
    setEditing(role);
    setReadonly(!!role.system || !canEdit);
    const rules = rulesFromRole(role);
    form.setFieldsValue({
      name: roleName(t, role),
      description: roleDesc(t, role),
      global_perms: role.global_perms ?? {},
      rules: rules.length ? rules : [emptyRule()],
    });
    setDrawerOpen(true);
  };

  const onSubmit = async () => {
    const values = await form.validateFields();
    const rules: RoleRulePayload[] = (values.rules as RuleDraft[]).map((r) => {
      const scope: RuleScope = r.cluster_id === ALL_CLUSTERS ? 'cluster' : r.scope;
      return {
        cluster_id: r.cluster_id,
        scope,
        namespaces: scope === 'namespace' ? r.namespaces : [],
        operations: cleanOperations(r.operations),
      };
    });
    const payload = {
      name: values.name.trim(),
      description: values.description || '',
      global_perms: cleanGlobalPerms((values.global_perms as GlobalPerms) ?? {}),
      rules,
    };
    setSaving(true);
    try {
      if (editing) {
        await roleApi.update(editing.id, payload);
        message.success(t('role.updated'));
      } else {
        await roleApi.create(payload);
        message.success(t('role.created'));
      }
      setDrawerOpen(false);
      roles.reload();
    } catch {
      /* interceptor toast */
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (role: RoleView) => {
    try {
      await roleApi.remove(role.id);
      message.success(t('role.deleted'));
      roles.reload();
    } catch {
      /* interceptor toast */
    }
  };

  const columns: ColumnsType<RoleView> = [
    {
      title: t('role.name'),
      dataIndex: 'name',
      width: 280,
      fixed: 'left',
      render: (_v: string, role) => {
        const name = roleName(t, role);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <SafetyOutlined style={{ color: '#0EA5E9', flex: '0 0 auto' }} />
            {/* truncate long (translated) names; full name on hover */}
            <Text strong ellipsis={{ tooltip: name }} style={{ flex: '1 1 auto', minWidth: 0 }}>
              {name}
            </Text>
            {role.system && (
              <Tag color="gold" style={{ flex: '0 0 auto', marginInlineEnd: 0 }}>
                {t('role.systemTag')}
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      title: t('role.accessCol'),
      key: 'access',
      width: 320,
      render: (_, role) => {
        const items = [
          ...grantedGlobalAreas(role).map((a) => ({ key: `g-${a}`, label: t(`nav.${a}`) })),
          ...grantedModules(role).map((m) => ({ key: m, label: t(`role.module.${m}`) })),
        ];
        if (!items.length) return <Text type="secondary">—</Text>;
        const MAX = 4;
        const shown = items.slice(0, MAX);
        const rest = items.length - shown.length;
        return (
          <Space size={[4, 4]} wrap>
            {shown.map((it) => (
              <Tag key={it.key} color="cyan" style={{ marginInlineEnd: 0 }}>
                {it.label}
              </Tag>
            ))}
            {rest > 0 && (
              <Tooltip title={items.map((it) => it.label).join('  ·  ')}>
                <Tag style={{ marginInlineEnd: 0 }}>+{rest}</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: t('role.rulesCount'),
      dataIndex: 'rules',
      width: 100,
      align: 'center',
      render: (rules: RoleView['rules']) => <Tag color="blue">{rules.length}</Tag>,
    },
    {
      title: t('role.boundUsers'),
      dataIndex: 'user_count',
      width: 100,
      align: 'center',
      render: (n: number) => <Tag>{n}</Tag>,
    },
    {
      title: t('role.actions'),
      key: 'actions',
      align: 'right',
      width: 150,
      fixed: 'right',
      render: (_, role) => {
        const editable = canEdit && !role.system;
        return (
          <Space size={2}>
            <Tooltip title={editable ? t('role.edit') : t('role.view')}>
              <Button
                type="text"
                size="small"
                icon={editable ? <EditOutlined /> : <EyeOutlined />}
                onClick={() => openEdit(role)}
              />
            </Tooltip>
            {canCreate && (
              <Tooltip title={t('role.copy')}>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={`copy-role-${role.id}`}
                  onClick={() => openCopy(role)}
                />
              </Tooltip>
            )}
            {role.system || !canDelete ? (
              <Tooltip title={t('role.systemNoDelete')}>
                <Button
                  type="text"
                  size="small"
                  danger
                  disabled
                  aria-label={`delete-role-${role.id}`}
                  icon={<DeleteOutlined />}
                />
              </Tooltip>
            ) : (
              <Popconfirm
                title={t('role.deleteTitle')}
                description={t('role.deleteConfirm', { name: role.name })}
                okText={t('resource.delete')}
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(role)}
              >
                <Tooltip title={t('resource.delete')}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    aria-label={`delete-role-${role.id}`}
                    icon={<DeleteOutlined />}
                  />
                </Tooltip>
              </Popconfirm>
            )}
          </Space>
        );
      },
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
            {t('role.title')}
          </Title>
          <Text type="secondary">{t('role.subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={roles.reload} loading={roles.loading}>
            {t('resource.refresh')}
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {t('role.create')}
            </Button>
          )}
        </Space>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<RoleView>
          rowKey="id"
          columns={columns}
          dataSource={roles.data}
          loading={roles.loading}
          {...defaultTableProps}
          scroll={tableScrollX(columns)}
          pagination={defaultPagination}
        />
      </Card>

      <Drawer
        title={readonly ? t('role.viewTitle') : editing ? t('role.editTitle') : t('role.createTitle')}
        width="70%"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnClose
        extra={
          readonly ? (
            <Button onClick={() => setDrawerOpen(false)}>{t('common.close')}</Button>
          ) : (
            <Space>
              <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" loading={saving} onClick={onSubmit}>
                {t('role.save')}
              </Button>
            </Space>
          )
        }
      >
        {readonly && (
          <Alert
            type="info"
            showIcon
            icon={<EyeOutlined />}
            className="ok-readonly-banner"
            style={{ marginBottom: 18 }}
            message={t('role.systemReadonly')}
          />
        )}
        <ConfigProvider componentDisabled={readonly}>
          <Form form={form} layout="vertical" requiredMark={false}>
            <Form.Item
              label={t('role.name')}
              name="name"
              rules={[{ required: true, message: t('role.errName') }]}
            >
              <Input placeholder={t('role.namePlaceholder')} maxLength={64} />
            </Form.Item>
            <Form.Item label={t('role.description')} name="description">
              <Input.TextArea placeholder={t('role.descPlaceholder')} rows={2} maxLength={256} />
            </Form.Item>

            <Divider orientation="left" style={{ margin: '8px 0 16px' }}>
              {t('role.globalSection')}
            </Divider>
            <Form.Item name="global_perms" noStyle>
              <GlobalPermsMatrix disabled={readonly} />
            </Form.Item>

            <Divider orientation="left" style={{ margin: '20px 0 16px' }}>
              {t('role.clusterSection')}
            </Divider>
            <Form.Item
              name="rules"
              noStyle
              rules={[{ validator: (_, v) => validateRules(v, t) }]}
            >
              <RuleBuilder clusters={clusters} disabled={readonly} />
            </Form.Item>
          </Form>
        </ConfigProvider>
      </Drawer>
    </div>
  );
}

/** Validate the rules array; throws a localized message on the first problem. */
async function validateRules(
  rules: RuleDraft[] | undefined,
  t: (k: string) => string,
): Promise<void> {
  if (!rules || rules.length === 0) {
    return Promise.reject(new Error(t('role.errNoRules')));
  }
  for (const r of rules) {
    if (!r.cluster_id) {
      return Promise.reject(new Error(t('role.errNoCluster')));
    }
    if (r.cluster_id !== ALL_CLUSTERS && r.scope === 'namespace' && (!r.namespaces || r.namespaces.length === 0)) {
      return Promise.reject(new Error(t('role.errNoNamespaces')));
    }
  }
  return Promise.resolve();
}

interface GlobalPermsMatrixProps {
  value?: GlobalPerms;
  onChange?: (value: GlobalPerms) => void;
  disabled?: boolean;
}

/**
 * The 全局权限 matrix: same layout as the per-cluster resource matrix, so both
 * sections read consistently. Rows are the platform areas — 系统管理 (集群/用户/
 * 角色, each view/create/edit/delete) as a group, plus 发布记录 (view only) — and
 * columns are the base actions. Maps to/from `global_perms`.
 */
export function GlobalPermsMatrix({ value = {}, onChange, disabled }: GlobalPermsMatrixProps) {
  const { t } = useTranslation();
  const gp = value;
  const allAreas: GlobalArea[] = [...SYSTEM_AREAS, 'integrated_deploy', 'releases', 'audit'];

  const applies = (area: GlobalArea, a: TreeAction) => actionsForGlobalArea(area).includes(a);
  const has = (area: GlobalArea, a: TreeAction) => (gp[area] ?? []).includes(a);

  const apply = (mutate: (next: GlobalPerms) => void) => {
    const next: GlobalPerms = {};
    for (const [k, v] of Object.entries(gp)) next[k as GlobalArea] = [...(v ?? [])];
    mutate(next);
    onChange?.(cleanGlobalPerms(next));
  };
  const setCell = (area: GlobalArea, a: TreeAction, on: boolean) =>
    apply((next) => {
      const set = new Set(next[area] ?? []);
      if (on) set.add(a);
      else set.delete(a);
      next[area] = [...set];
    });
  const setRow = (area: GlobalArea, on: boolean) =>
    apply((next) => {
      next[area] = on ? actionsForGlobalArea(area) : [];
    });
  const setAreas = (list: readonly GlobalArea[], a: TreeAction | 'all', on: boolean) =>
    apply((next) => {
      for (const area of list) {
        if (a === 'all') {
          next[area] = on ? actionsForGlobalArea(area) : [];
          continue;
        }
        if (!applies(area, a)) continue;
        const set = new Set(next[area] ?? []);
        if (on) set.add(a);
        else set.delete(a);
        next[area] = [...set];
      }
    });

  const triState = (total: number, on: number) => ({
    checked: total > 0 && on === total,
    indeterminate: on > 0 && on < total,
  });
  const rowState = (area: GlobalArea) => {
    const acts = actionsForGlobalArea(area);
    return triState(acts.length, acts.filter((a) => has(area, a)).length);
  };
  const groupState = (list: readonly GlobalArea[], a?: TreeAction) => {
    let total = 0;
    let on = 0;
    for (const area of list) {
      const acts = a ? (applies(area, a) ? [a] : []) : actionsForGlobalArea(area);
      total += acts.length;
      on += acts.filter((x) => has(area, x)).length;
    }
    return triState(total, on);
  };

  const areaRow = (area: GlobalArea) => {
    const rs = rowState(area);
    return (
      <tr key={area} className="ok-ops-res">
        <td>
          <Checkbox
            aria-label={`gp-row-${area}`}
            disabled={disabled}
            checked={rs.checked}
            indeterminate={rs.indeterminate}
            onChange={(e) => setRow(area, e.target.checked)}
          >
            {t(`nav.${area}`)}
          </Checkbox>
        </td>
        {BASE_ACTIONS.map((a) => {
          const ok = applies(area, a);
          // For the `ai` area the `create` column means the AI enable/disable switch,
          // not a generic 'create' — clarify with a tooltip.
          const hint = area === 'ai' && a === 'create' ? t('ai.enableAction') : undefined;
          const cb = (
            <Checkbox
              aria-label={`gp-${area}-${a}`}
              disabled={disabled || !ok}
              checked={ok && has(area, a)}
              onChange={(e) => setCell(area, a, e.target.checked)}
            />
          );
          return (
            <td key={a} className={ok ? undefined : 'ok-ops-na'}>
              {hint ? <Tooltip title={hint}>{cb}</Tooltip> : cb}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <table className="ok-ops-matrix">
      <thead>
        <tr>
          <th>
            <Checkbox
              aria-label="gp-all"
              disabled={disabled}
              checked={groupState(allAreas).checked}
              indeterminate={groupState(allAreas).indeterminate}
              onChange={(e) => setAreas(allAreas, 'all', e.target.checked)}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('role.allAreas')}
              </Text>
            </Checkbox>
          </th>
          {BASE_ACTIONS.map((a) => {
            const cs = groupState(allAreas, a);
            return (
              <th key={a}>
                <div className="ok-ops-colhead">
                  <Checkbox
                    aria-label={`gp-col-${a}`}
                    disabled={disabled}
                    checked={cs.checked}
                    indeterminate={cs.indeterminate}
                    onChange={(e) => setAreas(allAreas, a, e.target.checked)}
                  />
                  <span>{t(`role.action.${a}`)}</span>
                </div>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {/* 系统管理 group: master over clusters/users/roles. */}
        <tr className="ok-ops-group">
          <td>
            <Checkbox
              aria-label="gp-group-system"
              disabled={disabled}
              checked={groupState(SYSTEM_AREAS).checked}
              indeterminate={groupState(SYSTEM_AREAS).indeterminate}
              onChange={(e) => setAreas(SYSTEM_AREAS, 'all', e.target.checked)}
            >
              <Text strong>{t('role.systemMgmt')}</Text>
            </Checkbox>
          </td>
          <td colSpan={BASE_ACTIONS.length} />
        </tr>
        {SYSTEM_AREAS.map((area) => areaRow(area))}
        {areaRow('integrated_deploy')}
        {/* 发布记录 / 审计日志: standalone, view-only. */}
        {areaRow('releases')}
        {areaRow('audit')}
      </tbody>
    </table>
  );
}

interface RuleBuilderProps {
  value?: RuleDraft[];
  onChange?: (value: RuleDraft[]) => void;
  clusters: Cluster[];
  disabled?: boolean;
}

/**
 * Custom form control: a repeatable list of per-cluster permission cards. Each
 * card binds a single cluster (or all clusters) to a scope and a hierarchical
 * resource operations tree. Supports adding a card and reusing the first card's
 * config into a new card.
 */
export function RuleBuilder({ value = [], onChange, clusters, disabled }: RuleBuilderProps) {
  const { t } = useTranslation();
  const rules = value;

  const update = (idx: number, patch: Partial<RuleDraft>) => {
    onChange?.(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const add = () => onChange?.([...rules, emptyRule()]);
  const remove = (idx: number) => onChange?.(rules.filter((_, i) => i !== idx));
  const reuseFirst = () => {
    if (!rules.length) return;
    onChange?.([...rules, cloneRuleConfig(rules[0])]);
  };

  return (
    <div>
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        {rules.map((rule, idx) => (
          <RuleRow
            key={idx}
            index={idx}
            rule={rule}
            clusters={clusters}
            disabled={disabled}
            canRemove={rules.length > 1}
            onChange={(patch) => update(idx, patch)}
            onRemove={() => remove(idx)}
          />
        ))}
      </Space>
      <Space style={{ marginTop: 12 }} wrap>
        <Button type="dashed" icon={<PlusOutlined />} onClick={add} disabled={disabled}>
          {t('role.addCluster')}
        </Button>
        <Button
          icon={<CopyOutlined />}
          onClick={reuseFirst}
          disabled={disabled || rules.length === 0}
        >
          {t('role.reuseFirst')}
        </Button>
      </Space>
    </div>
  );
}

interface RuleRowProps {
  index: number;
  rule: RuleDraft;
  clusters: Cluster[];
  canRemove: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<RuleDraft>) => void;
  onRemove: () => void;
}

function RuleRow({ index, rule, clusters, canRemove, disabled, onChange, onRemove }: RuleRowProps) {
  const { t } = useTranslation();
  const { currentCluster } = useCtxStore();
  const [nsOptions, setNsOptions] = useState<string[]>([]);

  const isAllClusters = rule.cluster_id === ALL_CLUSTERS;

  const onClusterChange = (cluster_id: string) => {
    if (cluster_id === ALL_CLUSTERS) {
      // "All clusters" only supports whole-cluster scope.
      onChange({ cluster_id, scope: 'cluster', namespaces: [] });
    } else {
      onChange({ cluster_id });
    }
  };

  const onScopeChange = (scope: RuleScope) => {
    onChange({
      scope,
      namespaces: scope === 'cluster' ? [] : rule.namespaces,
      // Namespace scope can't grant cluster-scoped resources — drop stale grants.
      operations: scope === 'namespace' ? stripClusterScopedOps(rule.operations) : rule.operations,
    });
  };

  // Best-effort namespace suggestions: /namespaces resolves the current cluster
  // (X-Cluster-ID header), so only offer options when this row targets it.
  useEffect(() => {
    if (rule.scope !== 'namespace' || !currentCluster || rule.cluster_id !== currentCluster) {
      setNsOptions([]);
      return;
    }
    resourceApi.namespaces().then(setNsOptions).catch(() => setNsOptions([]));
  }, [rule.scope, rule.cluster_id, currentCluster]);

  const clusterOptions = [
    { value: ALL_CLUSTERS, label: t('role.allClusters') },
    ...clusters.map((c) => ({ value: c.id, label: c.name || c.id })),
  ];

  return (
    <Card
      size="small"
      title={
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('role.clusterCardTitle', { n: index + 1 })}
        </Text>
      }
      extra={
        canRemove ? (
          <Button
            type="text"
            danger
            size="small"
            icon={<MinusCircleOutlined />}
            onClick={onRemove}
            disabled={disabled}
            aria-label={`remove-rule-${index}`}
          >
            {t('role.removeRule')}
          </Button>
        ) : undefined
      }
      styles={{ body: { padding: 14 } }}
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('role.cluster')}
          </Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            placeholder={t('role.selectCluster')}
            aria-label="rule-cluster"
            virtual={false}
            value={rule.cluster_id || undefined}
            onChange={onClusterChange}
            options={clusterOptions}
          />
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('role.scope')}
          </Text>
          <div style={{ marginTop: 4 }}>
            <Radio.Group
              value={rule.scope}
              onChange={(e) => onScopeChange(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="cluster">{t('role.scopeCluster')}</Radio.Button>
              <Radio.Button value="namespace" disabled={isAllClusters}>
                {t('role.scopeNamespace')}
              </Radio.Button>
            </Radio.Group>
          </div>
        </div>

        {rule.scope === 'namespace' && !isAllClusters && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('role.namespaces')}
            </Text>
            <Select
              mode="tags"
              style={{ width: '100%', marginTop: 4 }}
              placeholder={t('role.nsPlaceholder')}
              aria-label="rule-namespaces"
              value={rule.namespaces}
              onChange={(namespaces) => onChange({ namespaces })}
              options={nsOptions.map((n) => ({ value: n, label: n }))}
            />
          </div>
        )}

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('role.operations')}
          </Text>
          <ResourceOpsMatrix
            operations={rule.operations}
            disabled={disabled}
            nsScoped={rule.scope === 'namespace'}
            onChange={(operations) => onChange({ operations })}
          />
        </div>
      </Space>
    </Card>
  );
}

interface ResourceOpsMatrixProps {
  operations: Operations;
  onChange: (operations: Operations) => void;
  disabled?: boolean;
  /** Rule is scoped to specific namespaces → cluster-scoped resources (nodes,
   *  PVs) can't be granted, so their rows are disabled and excluded from
   *  bulk toggles. */
  nsScoped?: boolean;
}

/**
 * Per-cluster resource operations as a single compact permission matrix:
 * resource rows (grouped by module) × action columns. Far more scannable than
 * a deep tree — every resource is one row instead of a 4-deep stack. Three
 * levels of bulk selection: a column header toggles that action across every
 * resource; a module group-row toggles every action in that module; a resource
 * row toggles every applicable action for it. Inapplicable cells (e.g. `exec`
 * on non-pods, `reveal` on non-secrets) show a disabled, muted checkbox.
 */
export function ResourceOpsMatrix({ operations, onChange, disabled, nsScoped }: ResourceOpsMatrixProps) {
  const { t } = useTranslation();

  // A resource whose grant would silently do nothing under this rule's scope.
  const resBlocked = (res: string) => !!nsScoped && isClusterScopedResource(res);
  // Effective resource list for bulk toggles / aggregate state — excludes
  // blocked (cluster-scoped) resources so "select all" never grants them.
  const usable = (list: readonly string[]) => list.filter((r) => !resBlocked(r));

  const has = (res: string, a: TreeAction) => (operations[res] ?? []).includes(a);

  // Clone, mutate, normalise — keeps the change immutable + drops empties.
  const apply = (mutate: (next: Operations) => void) => {
    const next: Operations = {};
    for (const [k, v] of Object.entries(operations)) next[k] = [...v];
    mutate(next);
    onChange(cleanOperations(next));
  };
  const setCell = (res: string, a: TreeAction, on: boolean) =>
    apply((next) => {
      const set = new Set(next[res] ?? []);
      if (on) set.add(a);
      else set.delete(a);
      next[res] = [...set];
    });
  const setRow = (res: string, on: boolean) =>
    apply((next) => {
      next[res] = on ? actionsForResource(res) : [];
    });
  const setResources = (list: readonly string[], a: TreeAction | 'all', on: boolean) =>
    apply((next) => {
      for (const r of list) {
        if (a === 'all') {
          next[r] = on ? actionsForResource(r) : [];
          continue;
        }
        if (!actionAppliesToResource(r, a)) continue;
        const set = new Set(next[r] ?? []);
        if (on) set.add(a);
        else set.delete(a);
        next[r] = [...set];
      }
    });

  const triState = (total: number, on: number) => ({
    checked: total > 0 && on === total,
    indeterminate: on > 0 && on < total,
  });
  const rowState = (res: string) => {
    const all = actionsForResource(res);
    return triState(all.length, all.filter((a) => has(res, a)).length);
  };
  // Aggregate state for a set of resources, optionally limited to one action.
  const groupState = (list: readonly string[], a?: TreeAction) => {
    let total = 0;
    let on = 0;
    for (const r of list) {
      const acts = a ? (actionAppliesToResource(r, a) ? [a] : []) : actionsForResource(r);
      total += acts.length;
      on += acts.filter((x) => has(r, x)).length;
    }
    return triState(total, on);
  };

  return (
    <table className="ok-ops-matrix">
      <thead>
        <tr>
          <th>
            {/* Grand master: every applicable cell in the whole matrix. */}
            <Checkbox
              aria-label="op-all"
              disabled={disabled}
              checked={groupState(usable(ALL_RESOURCES)).checked}
              indeterminate={groupState(usable(ALL_RESOURCES)).indeterminate}
              onChange={(e) => setResources(usable(ALL_RESOURCES), 'all', e.target.checked)}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('role.allResources')}
              </Text>
            </Checkbox>
          </th>
          {TREE_ACTIONS.map((a) => {
            const cs = groupState(usable(ALL_RESOURCES), a);
            const label =
              a === 'reveal' ? (
                <Tooltip title={t('role.action.revealHint')}>
                  <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>
                    {t(`role.action.${a}`)}
                  </span>
                </Tooltip>
              ) : (
                t(`role.action.${a}`)
              );
            return (
              <th key={a}>
                <div className="ok-ops-colhead">
                  <Checkbox
                    aria-label={`op-col-${a}`}
                    disabled={disabled}
                    checked={cs.checked}
                    indeterminate={cs.indeterminate}
                    onChange={(e) => setResources(usable(ALL_RESOURCES), a, e.target.checked)}
                  />
                  <span>{label}</span>
                </div>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {MODULE_KEYS.map((m) => {
          const resources = MODULE_RESOURCES[m];
          const gs = groupState(usable(resources));
          const groupBlocked = usable(resources).length === 0; // whole module cluster-scoped (nodes)
          return (
            <Fragment key={m}>
              {/* Module group row: master checkbox for the whole module. */}
              <tr className="ok-ops-group">
                <td>
                  <Checkbox
                    aria-label={`op-module-${m}`}
                    disabled={disabled || groupBlocked}
                    checked={gs.checked}
                    indeterminate={gs.indeterminate}
                    onChange={(e) => setResources(usable(resources), 'all', e.target.checked)}
                  >
                    <Text strong>{t(`role.module.${m}`)}</Text>
                  </Checkbox>
                </td>
                <td colSpan={TREE_ACTIONS.length} />
              </tr>
              {resources.map((res) => {
                const rs = rowState(res);
                const blocked = resBlocked(res);
                const label = blocked ? (
                  <Tooltip title={t('role.clusterScopedHint')}>
                    <span style={{ color: 'var(--ant-color-text-quaternary)' }}>
                      {t(`role.resource.${res}`)}
                    </span>
                  </Tooltip>
                ) : (
                  t(`role.resource.${res}`)
                );
                return (
                  <tr key={res} className="ok-ops-res">
                    <td>
                      <Checkbox
                        aria-label={`op-row-${res}`}
                        disabled={disabled || blocked}
                        checked={!blocked && rs.checked}
                        indeterminate={!blocked && rs.indeterminate}
                        onChange={(e) => setRow(res, e.target.checked)}
                      >
                        {label}
                      </Checkbox>
                    </td>
                    {TREE_ACTIONS.map((a) => {
                      const applicable = actionAppliesToResource(res, a);
                      return (
                        <td key={a} className={applicable && !blocked ? undefined : 'ok-ops-na'}>
                          <Checkbox
                            aria-label={`op-${res}-${a}`}
                            disabled={disabled || blocked || !applicable}
                            checked={!blocked && applicable && has(res, a)}
                            onChange={(e) => setCell(res, a, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
