import client from './client';
import type { User } from '../store/auth';

export interface LoginResp {
  token: string;
  must_reset: boolean;
}

export interface CaptchaResp {
  id: string;
  image: string; // data:image/png;base64,...
}

export const authApi = {
  login: (username: string, password: string, captchaId?: string, captchaCode?: string) =>
    client
      .post<LoginResp>('/login', {
        username,
        password,
        captcha_id: captchaId,
        captcha_code: captchaCode,
      })
      .then((r) => r.data),

  captcha: () => client.get<CaptchaResp>('/captcha').then((r) => r.data),

  changePassword: (old_password: string, new_password: string) =>
    client.post('/change-password', { old_password, new_password }).then((r) => r.data),

  /** Fetch the current user. Pass `token` right after login to authenticate the
   *  call before the token is committed to the store (avoids a loader flash). */
  me: (token?: string) =>
    client
      .get<User>('/me', token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .then((r) => r.data),
};
