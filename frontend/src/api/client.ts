import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { message } from 'antd';
import { getToken, useAuthStore } from '../store/auth';
import { getCurrentCluster } from '../store/ctx';

// Prod builds are served by the backend on the same origin → use relative paths
// (`/api/v1`), so the app works behind any host/port. Dev points at :8080.
// An explicit VITE_API_BASE always wins (use it to target a remote backend).
export const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? '' : 'http://localhost:8080');
export const API_PREFIX = '/api/v1';

/** Paths that need the X-Cluster-ID header (resource / namespace / capability calls). */
function needsClusterHeader(url?: string): boolean {
  if (!url) return false;
  return (
    /\/(resources|namespaces|metrics)\b/.test(url) ||
    url.includes('/namespaces') ||
    url.includes('/me/capabilities')
  );
}

export interface ApiError {
  code: number;
  message: string;
}

let redirecting = false;

const client: AxiosInstance = axios.create({
  baseURL: `${API_BASE}${API_PREFIX}`,
  timeout: 30000,
});

client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  if (needsClusterHeader(config.url)) {
    const cluster = getCurrentCluster();
    if (cluster) config.headers.set('X-Cluster-ID', cluster);
  }
  return config;
});

client.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status;
    const data = error?.response?.data as Partial<ApiError> | undefined;
    const msg = data?.message || error?.message || 'Request failed';

    // Key off the REQUEST url, not the browser path: a bad-credentials 401 comes
    // from the auth submit (POST /login or /change-password). The bootstrap
    // hydration (GET /me) can also fire while sitting on /login with a stale
    // token — that 401 must fall through to logout, or the app deadlocks on the
    // loader (token present, user never hydrates).
    const reqUrl = error?.config?.url ?? '';
    const isAuthSubmit = /\/(login|change-password)$/.test(reqUrl);

    if (status === 401 && isAuthSubmit) {
      // Failed sign-in / change-password attempt (wrong password / captcha),
      // NOT an expired session — surface the server's reason.
      message.error(msg);
    } else if (status === 401) {
      useAuthStore.getState().logout();
      if (!redirecting) {
        redirecting = true;
        message.error('Session expired, please sign in again');
        window.location.assign('/login');
        // reset after navigation tick so future 401s can redirect again
        setTimeout(() => {
          redirecting = false;
        }, 1000);
      }
    } else {
      // Surface a unified toast for all other errors.
      message.error(msg);
    }
    return Promise.reject(error);
  },
);

export default client;
