/**
 * 应用构建时的 basePath（NEXT_PUBLIC_BASE_PATH），默认空字符串。
 * 用于子路径部署（如 nginx 反向代理到 /ops）。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** 给根相对路径加上 basePath 前缀 */
export function withBasePath(path: string): string {
  return path.startsWith('/') ? `${BASE_PATH}${path}` : path;
}

/**
 * 带错误提示的 fetch 包装
 * 非 2xx 响应由调用方通过 App.useApp() 的 message 处理
 */
export async function request(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(withBasePath(url), { ...options, credentials: 'include' });

  if (!res.ok) {
    // 401 跳登录页, 403 不跳（禁用用户由页面处理）
    if (res.status === 401) {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith(withBasePath('/login'))) {
        window.location.href = withBasePath('/login');
      }
    }
  }

  return res;
}
