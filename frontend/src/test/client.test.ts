import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';
import client from '../api/client';
import { useAuthStore } from '../store/auth';
import { useCtxStore } from '../store/ctx';

// Echo adapter: resolve immediately, returning the outgoing config so we can
// inspect the headers the request interceptor produced.
function echoAdapter(): AxiosAdapter {
  return async (config) => ({
    data: {},
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  });
}

describe('axios client interceptors', () => {
  beforeEach(() => {
    useAuthStore.getState().setToken(null);
    useCtxStore.getState().setCluster(null);
  });

  it('injects Bearer token and X-Cluster-ID on resource calls', async () => {
    useAuthStore.getState().setToken('tok-123');
    useCtxStore.getState().setCluster('cluster-a');
    client.defaults.adapter = echoAdapter();

    const resp = await client.get('/resources/pods');
    const headers = resp.config.headers;

    expect(headers.get('Authorization')).toBe('Bearer tok-123');
    expect(headers.get('X-Cluster-ID')).toBe('cluster-a');
  });

  it('does not add X-Cluster-ID on non-resource calls', async () => {
    useAuthStore.getState().setToken('tok-123');
    useCtxStore.getState().setCluster('cluster-a');
    client.defaults.adapter = echoAdapter();

    const resp = await client.post('/login', {});
    const headers = resp.config.headers;

    expect(headers.get('Authorization')).toBe('Bearer tok-123');
    expect(headers.get('X-Cluster-ID')).toBeFalsy();
  });

  it('clears token and redirects to /login on 401', async () => {
    useAuthStore.getState().setToken('tok-123');

    const assignMock = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { pathname: '/dashboard', assign: assignMock },
    });

    client.defaults.adapter = async (config) =>
      Promise.reject({
        isAxiosError: true,
        config,
        response: { status: 401, data: { code: 1, message: 'unauthorized' } },
        message: 'unauthorized',
      });

    await expect(client.get('/resources/pods')).rejects.toBeTruthy();

    expect(useAuthStore.getState().token).toBeNull();
    expect(assignMock).toHaveBeenCalledWith('/login');
  });
});
