import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ConfigProvider>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </I18nextProvider>
  );
}

export function renderWithProviders(ui: ReactElement) {
  return render(<Providers>{ui}</Providers>);
}
