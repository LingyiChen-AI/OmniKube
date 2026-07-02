import client from './client';
import { unwrapList } from './normalize';
import type { RoleRef } from './role';

export interface ManagedUser {
  id: number;
  username: string;
  is_admin: boolean;
  disabled: boolean;
  must_reset?: boolean;
  roles: RoleRef[];
}

export interface CreatedUser {
  id: number;
  username: string;
  temp_password: string;
  must_reset: boolean;
}

export const userApi = {
  list: () => client.get('/users').then((r) => unwrapList<ManagedUser>(r.data)),

  create: (username: string, role_ids: number[]) =>
    client.post<CreatedUser>('/users', { username, role_ids }).then((r) => r.data),

  setRoles: (id: number, role_ids: number[]) =>
    client.put(`/users/${id}/roles`, { role_ids }).then((r) => r.data),

  disable: (id: number) => client.put(`/users/${id}/disable`).then((r) => r.data),

  enable: (id: number) => client.put(`/users/${id}/enable`).then((r) => r.data),

  /** Admin-only: reset a user's password to a fresh one-time temporary password. */
  resetPassword: (id: number) =>
    client.post<CreatedUser>(`/users/${id}/reset-password`).then((r) => r.data),

  remove: (id: number) => client.delete(`/users/${id}`).then((r) => r.data),
};
