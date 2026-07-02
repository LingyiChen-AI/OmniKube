import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import Login from '../pages/Login';
import { useAuthStore } from '../store/auth';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    me: vi.fn(),
    changePassword: vi.fn(),
  },
}));

import { authApi } from '../api/auth';

function renderLogin(initial = '/login') {
  return render(
    <ConfigProvider>
      <AntdApp>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<div>DASHBOARD_PAGE</div>} />
            <Route path="/change-password" element={<div>CHANGE_PW_PAGE</div>} />
          </Routes>
        </MemoryRouter>
      </AntdApp>
    </ConfigProvider>,
  );
}

async function submitLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('username'), 'alice');
  await user.type(screen.getByPlaceholderText('••••••••'), 'password1');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('Login', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    vi.clearAllMocks();
  });

  it('navigates to dashboard on success', async () => {
    (authApi.login as any).mockResolvedValue({ token: 'jwt', must_reset: false });
    (authApi.me as any).mockResolvedValue({
      id: 1,
      username: 'alice',
      is_admin: false,
      must_reset: false,
    });

    renderLogin();
    await submitLogin();

    await waitFor(() => expect(screen.getByText('DASHBOARD_PAGE')).toBeInTheDocument());
    expect(useAuthStore.getState().token).toBe('jwt');
  });

  it('redirects to change-password when must_reset is set', async () => {
    (authApi.login as any).mockResolvedValue({ token: 'jwt', must_reset: true });
    (authApi.me as any).mockResolvedValue({
      id: 1,
      username: 'alice',
      is_admin: false,
      must_reset: true,
    });

    renderLogin();
    await submitLogin();

    await waitFor(() => expect(screen.getByText('CHANGE_PW_PAGE')).toBeInTheDocument());
  });
});
