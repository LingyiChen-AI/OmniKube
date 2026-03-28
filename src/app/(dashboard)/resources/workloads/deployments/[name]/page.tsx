'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import {
  Card, Descriptions, Table, Tag, Button, Space, Typography, Breadcrumb,
  Spin, Alert, Popconfirm, Dropdown, App,
} from 'antd';
import {
  ArrowLeftOutlined, EditOutlined, ReloadOutlined, RollbackOutlined,
  DownOutlined, CodeOutlined, FileTextOutlined,
} from '@ant-design/icons';
import { useClusterStore } from '@/hooks/use-cluster';
import { usePermissions } from '@/hooks/use-permissions';
import { useResourceWatch } from '@/hooks/use-resource-watch';
import ResourceDrawer from '@/components/resource-drawer';
import PodLogViewer from '@/components/pod-log-viewer';
import PodTerminal from '@/components/pod-terminal';
import { request } from '@/lib/request';

const { Title, Text } = Typography;

const phaseColors: Record<string, string> = {
  Running: 'green', Pending: 'gold', Succeeded: 'blue', Failed: 'red', Unknown: 'default',
};

function getAge(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export default function DeploymentDetailPage() {
  const { message } = App.useApp();
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { clusterId } = useClusterStore();
  const permissions = usePermissions('deployments');

  const name = params.name as string;
  const namespace = searchParams.get('namespace') || 'default';

  const [deployment, setDeployment] = useState<any>(null);
  const [pods, setPods] = useState<any[]>([]);
  const [loadingDeployment, setLoadingDeployment] = useState(true);
  const [loadingPods, setLoadingPods] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'view' | 'edit' | 'create' }>({ open: false, mode: 'view' });
  const [logState, setLogState] = useState<{ open: boolean; pod?: any }>({ open: false });
  const [termState, setTermState] = useState<{ open: boolean; pod?: any }>({ open: false });

  const fetchDeployment = async (silent = false) => {
    if (!clusterId) return;
    if (!silent) setLoadingDeployment(true);
    setError(null);
    try {
      const res = await request(`/api/k8s/${clusterId}/namespaces/${namespace}/deployments/${name}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Failed to fetch deployment');
        return;
      }
      const data = await res.json();
      setDeployment(data);
      await fetchPods(data, silent);
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (!silent) setLoadingDeployment(false);
    }
  };

  const fetchPods = async (dep: any, silent = false) => {
    if (!clusterId) return;
    if (!silent) setLoadingPods(true);
    try {
      const res = await request(`/api/k8s/${clusterId}/namespaces/${namespace}/pods`);
      if (!res.ok) return;
      const allPods: any[] = await res.json();
      const matchLabels: Record<string, string> = dep?.spec?.selector?.matchLabels || {};
      const filtered = allPods.filter((pod: any) => {
        const podLabels: Record<string, string> = pod.metadata?.labels || {};
        return Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
      });
      setPods(filtered);
    } catch {
      // ignore
    } finally {
      if (!silent) setLoadingPods(false);
    }
  };

  useEffect(() => {
    fetchDeployment();
  }, [clusterId, name, namespace]);

  // Watch for real-time changes
  useResourceWatch(clusterId, 'deployments', namespace, () => fetchDeployment(true));
  useResourceWatch(clusterId, 'pods', namespace, () => { if (deployment) fetchPods(deployment, true); });

  // Restart deployment (kubectl rollout restart)
  const handleRestart = async () => {
    if (!clusterId || !deployment) return;
    setRestarting(true);
    try {
      // Patch the deployment with a restart annotation
      const patch = JSON.parse(JSON.stringify(deployment));
      if (!patch.spec.template.metadata) patch.spec.template.metadata = {};
      if (!patch.spec.template.metadata.annotations) patch.spec.template.metadata.annotations = {};
      patch.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();

      const res = await request(`/api/k8s/${clusterId}/namespaces/${namespace}/deployments/${name}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Change-Message': encodeURIComponent('重新部署 (Rollout Restart)'),
        },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        message.success('重新部署已触发');
        setTimeout(fetchDeployment, 2000);
      } else {
        const d = await res.json().catch(() => ({}));
        message.error(d.error || '重新部署失败');
      }
    } finally {
      setRestarting(false);
    }
  };

  // Rollback to previous revision
  const handleRollback = async () => {
    if (!clusterId || !deployment) return;
    setRollingBack(true);
    try {
      // Get the deployment's revision history via ReplicaSets
      const res = await request(`/api/k8s/${clusterId}/namespaces/${namespace}/replicasets`);
      if (!res.ok) { message.error('获取 ReplicaSet 失败'); return; }
      const allRS: any[] = await res.json();

      // Filter RS owned by this deployment
      const matchLabels = deployment.spec?.selector?.matchLabels || {};
      const ownedRS = allRS
        .filter((rs: any) => {
          const rsLabels = rs.spec?.selector?.matchLabels || {};
          return Object.entries(matchLabels).every(([k, v]) => rsLabels[k] === v);
        })
        .filter((rs: any) => rs.metadata?.annotations?.['deployment.kubernetes.io/revision'])
        .sort((a: any, b: any) => {
          const ra = parseInt(a.metadata.annotations['deployment.kubernetes.io/revision'] || '0');
          const rb = parseInt(b.metadata.annotations['deployment.kubernetes.io/revision'] || '0');
          return rb - ra;
        });

      if (ownedRS.length < 2) {
        message.warning('没有可回滚的历史版本');
        return;
      }

      // Previous version is the second newest RS
      const previousRS = ownedRS[1];
      const previousImage = previousRS.spec?.template?.spec?.containers?.[0]?.image || 'unknown';

      // Update deployment with previous RS's template
      const patch = JSON.parse(JSON.stringify(deployment));
      patch.spec.template = previousRS.spec.template;

      const updateRes = await request(`/api/k8s/${clusterId}/namespaces/${namespace}/deployments/${name}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Change-Message': encodeURIComponent(`回滚到上一版本 (镜像: ${previousImage})`),
        },
        body: JSON.stringify(patch),
      });
      if (updateRes.ok) {
        message.success(`已回滚到上一版本 (${previousImage})`);
        setTimeout(fetchDeployment, 2000);
      } else {
        const d = await updateRes.json().catch(() => ({}));
        message.error(d.error || '回滚失败');
      }
    } catch (err: any) {
      message.error('回滚失败: ' + err.message);
    } finally {
      setRollingBack(false);
    }
  };

  const podContainers = (pod: any): string[] => {
    return (pod.spec?.containers || []).map((c: any) => c.name);
  };

  const podColumns = [
    { title: '名称', dataIndex: ['metadata', 'name'], key: 'name' },
    {
      title: '状态', key: 'phase',
      render: (_: any, r: any) => {
        const phase = r.status?.phase || 'Unknown';
        return <Tag color={phaseColors[phase] || 'default'}>{phase}</Tag>;
      },
    },
    {
      title: '重启', key: 'restarts',
      render: (_: any, r: any) => (r.status?.containerStatuses || []).reduce((s: number, c: any) => s + (c.restartCount || 0), 0),
    },
    { title: 'Pod IP', dataIndex: ['status', 'podIP'], key: 'ip', render: (v: string) => v || '-' },
    { title: '节点', dataIndex: ['spec', 'nodeName'], key: 'node', render: (v: string) => v || '-' },
    {
      title: '运行时间', key: 'age',
      render: (_: any, r: any) => r.metadata?.creationTimestamp ? getAge(r.metadata.creationTimestamp) : '-',
    },
    {
      title: '操作', key: 'actions', width: 140, fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space>
          <Button size="small" type="link" icon={<FileTextOutlined />} onClick={() => setLogState({ open: true, pod: record })}>
            日志
          </Button>
          <Button size="small" type="link" icon={<CodeOutlined />} onClick={() => setTermState({ open: true, pod: record })}>
            终端
          </Button>
        </Space>
      ),
    },
  ];

  if (loadingDeployment) {
    return <div style={{ textAlign: 'center', padding: 64 }}><Spin size="large" /></div>;
  }

  if (error) {
    return <Alert type="error" message={error} action={<Button size="small" onClick={() => router.back()}>返回</Button>} />;
  }

  const image = deployment?.spec?.template?.spec?.containers?.[0]?.image || '-';
  const readyReplicas = deployment?.status?.readyReplicas ?? 0;
  const desiredReplicas = deployment?.spec?.replicas ?? 0;
  const ready = readyReplicas === desiredReplicas && desiredReplicas > 0;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()} type="text" />
        <Breadcrumb
          items={[
            { title: <a onClick={() => router.push('/resources/workloads/deployments')}>Deployments</a> },
            { title: name },
          ]}
        />
      </div>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Title level={4} style={{ margin: 0 }}>{name}</Title>
          <Tag color={ready ? 'green' : 'orange'}>{ready ? 'Ready' : 'Updating'}</Tag>
        </Space>
        <Space>
          {permissions.canUpdate && (
            <Button
              icon={<EditOutlined />}
              onClick={() => setDrawerState({ open: true, mode: 'edit' })}
            >
              编辑
            </Button>
          )}
          {permissions.canUpdate && (
            <Popconfirm title="确认重新部署？将触发 Pod 滚动重启" onConfirm={handleRestart}>
              <Button icon={<ReloadOutlined />} loading={restarting}>重新部署</Button>
            </Popconfirm>
          )}
          {permissions.canUpdate && (
            <Popconfirm title="确认回滚到上一版本？" onConfirm={handleRollback}>
              <Button icon={<RollbackOutlined />} loading={rollingBack}>回滚</Button>
            </Popconfirm>
          )}
          <Button onClick={fetchDeployment}>刷新</Button>
        </Space>
      </div>

      {/* Deployment Info */}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="名称">{deployment?.metadata?.name}</Descriptions.Item>
          <Descriptions.Item label="命名空间">{deployment?.metadata?.namespace}</Descriptions.Item>
          <Descriptions.Item label="镜像" span={2}><Text code>{image}</Text></Descriptions.Item>
          <Descriptions.Item label="副本数">{readyReplicas} / {desiredReplicas}</Descriptions.Item>
          <Descriptions.Item label="策略">{deployment?.spec?.strategy?.type || '-'}</Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {deployment?.metadata?.creationTimestamp ? new Date(deployment.metadata.creationTimestamp).toLocaleString() : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="标签选择器">
            {Object.entries(deployment?.spec?.selector?.matchLabels || {}).map(([k, v]) => (
              <Tag key={k}>{`${k}=${v}`}</Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* Pods */}
      <Card title={`Pods (${pods.length})`}>
        <Table
          dataSource={pods}
          columns={podColumns}
          rowKey={(r) => r.metadata?.uid || r.metadata?.name}
          loading={loadingPods}
          pagination={false}
          size="middle"
          scroll={{ x: 'max-content' }}
        />
      </Card>

      {/* Edit Drawer */}
      <ResourceDrawer
        open={drawerState.open}
        mode={drawerState.mode}
        kind="deployments"
        kindLabel="Deployment"
        record={deployment}
        namespace={namespace}
        permissions={permissions}
        onClose={() => setDrawerState({ open: false, mode: 'view' })}
        onSuccess={() => { setDrawerState({ open: false, mode: 'view' }); fetchDeployment(); }}
      />

      {/* Pod Log Viewer */}
      {logState.open && logState.pod && (
        <PodLogViewer
          open={logState.open}
          onClose={() => setLogState({ open: false })}
          clusterId={clusterId!}
          namespace={namespace}
          podName={logState.pod.metadata?.name}
          containers={podContainers(logState.pod)}
        />
      )}

      {/* Pod Terminal */}
      {termState.open && termState.pod && (
        <PodTerminal
          open={termState.open}
          onClose={() => setTermState({ open: false })}
          clusterId={clusterId!}
          namespace={namespace}
          podName={termState.pod.metadata?.name}
          containers={podContainers(termState.pod)}
        />
      )}
    </div>
  );
}
