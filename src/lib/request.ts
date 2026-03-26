/**
 * 带错误提示的 fetch 包装
 * 非 2xx 响应由调用方通过 App.useApp() 的 message 处理
 */
export async function request(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...options, credentials: 'include' });

  if (!res.ok) {
    // 401 跳登录页
    if (res.status === 401) {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
  }

  return res;
}
