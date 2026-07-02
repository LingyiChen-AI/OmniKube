import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';
import Users from '../pages/users/Users';
import { userApi } from '../api/user';
import { roleApi } from '../api/role';
import { useAuthStore } from '../store/auth';

vi.mock('../api/user', () => ({
  userApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({
      id: 5,
      username: 'jane',
      temp_password: 'Secret123!',
      must_reset: true,
    }),
    setRoles: vi.fn().mockResolvedValue({}),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../api/role', () => ({
  roleApi: {
    list: vi.fn().mockResolvedValue([
      { id: 1, name: 'Ops', description: '', rules: [], user_count: 0 },
      { id: 2, name: 'Viewer', description: '', rules: [], user_count: 0 },
    ]),
  },
}));

describe('create user with roles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: 1, username: 'admin', is_admin: true, must_reset: false, nav: { submenus: [] }, global: {} },
    });
    (roleApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, name: 'Ops', description: '', rules: [], user_count: 0 },
      { id: 2, name: 'Viewer', description: '', rules: [], user_count: 0 },
    ]);
    (userApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (userApi.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 5,
      username: 'jane',
      temp_password: 'Secret123!',
      must_reset: true,
    });
  });

  it('submits the selected role ids when creating a user', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />);

    // Open the create modal.
    await user.click(screen.getByRole('button', { name: /create user/i }));

    // Fill the username.
    const username = await screen.findByPlaceholderText('jane.doe');
    await user.type(username, 'jane');

    // Pick a role from the multi-select.
    const rolesInput = document.querySelector('[aria-label="user-roles"]')!;
    const rolesWrapper = rolesInput.closest('.ant-select')!;
    fireEvent.mouseDown(rolesWrapper.querySelector('.ant-select-selector')!);
    fireEvent.click(await screen.findByText('Ops'));

    // Submit.
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(userApi.create).toHaveBeenCalledTimes(1));
    expect(userApi.create).toHaveBeenCalledWith('jane', [1]);
  });
});
