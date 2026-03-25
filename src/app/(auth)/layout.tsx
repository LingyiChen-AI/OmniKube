'use client';
import { ConfigProvider, App } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#326CE5',
          borderRadius: 6,
        },
      }}
    >
      <App>
        {children}
      </App>
    </ConfigProvider>
  );
}
