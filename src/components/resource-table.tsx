'use client';

import { Table, Alert } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useClusterStore } from '@/hooks/use-cluster';

interface Props {
  data: any[];
  loading: boolean;
  columns: ColumnsType<any>;
}

export default function ResourceTable({ data, loading, columns }: Props) {
  const { clusterId } = useClusterStore();

  if (!clusterId) {
    return <Alert message="请先在顶部选择一个集群" type="info" showIcon />;
  }

  return (
    <Table
      columns={columns}
      dataSource={data}
      rowKey={(record) => record.metadata?.uid || record.metadata?.name}
      loading={loading}
      size="middle"
      pagination={{ pageSize: 20 }}
      scroll={{ x: 'max-content' }}
    />
  );
}
