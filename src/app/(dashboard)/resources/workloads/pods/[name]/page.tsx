'use client';

import { Card, Descriptions, Tag } from 'antd';
import { useRequest } from 'ahooks';
import { useParams, useSearchParams } from 'next/navigation';
import { useClusterStore } from '@/hooks/use-cluster';

export default function PodDetailPage() {
  const { name } = useParams<{ name: string }>();
  const searchParams = useSearchParams();
  const namespace = searchParams.get('namespace') || 'default';
  const { clusterId } = useClusterStore();

  const { data: pod, loading } = useRequest(
    async () => {
      if (!clusterId) return null;
      const res = await fetch(
        `/api/k8s/${clusterId}/namespaces/${namespace}/pods/${name}`,
      );
      if (!res.ok) return null;
      return res.json();
    },
    { ready: !!clusterId },
  );

  if (loading || !pod) return <Card loading />;

  const phase = pod.status?.phase || 'Unknown';
  const phaseColors: Record<string, string> = {
    Running: 'green', Pending: 'gold', Succeeded: 'blue', Failed: 'red',
  };

  return (
    <div>
      <Card title={`Pod: ${pod.metadata?.name}`} style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.Item label="命名空间">{pod.metadata?.namespace}</Descriptions.Item>
          <Descriptions.Item label="节点">{pod.spec?.nodeName || '-'}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={phaseColors[phase] || 'default'}>{phase}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Pod IP">{pod.status?.podIP || '-'}</Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {pod.metadata?.creationTimestamp
              ? new Date(pod.metadata.creationTimestamp).toLocaleString()
              : '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="容器">
        {(pod.spec?.containers || []).map((c: any) => (
          <Card.Grid key={c.name} style={{ width: '100%' }}>
            <p><strong>名称:</strong> {c.name}</p>
            <p><strong>镜像:</strong> {c.image}</p>
          </Card.Grid>
        ))}
      </Card>
    </div>
  );
}
