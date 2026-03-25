'use client';

import { Card, Col, Row, Statistic, List } from 'antd';
import { ClusterOutlined, RocketOutlined, CloudOutlined, CalendarOutlined } from '@ant-design/icons';

export default function DashboardPage() {
  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic title="集群" value={0} prefix={<ClusterOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="运行 Pods" value={0} prefix={<CloudOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="Deployments" value={0} prefix={<RocketOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日发布" value={0} prefix={<CalendarOutlined />} />
          </Card>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={16}>
          <Card title="最近事件">
            <List
              dataSource={[]}
              renderItem={() => null}
              locale={{ emptyText: '请先添加集群' }}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="集群状态">
            <List
              dataSource={[]}
              renderItem={() => null}
              locale={{ emptyText: '暂无集群' }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
