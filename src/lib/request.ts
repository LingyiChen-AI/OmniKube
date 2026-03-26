import { message } from 'antd';

/**
 * 带错误提示的 fetch 包装
 * 非 2xx 响应自动弹出错误提示
 */
export async function request(url: string, options?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, { ...options, credentials: 'include' });

    if (!res.ok) {
      // 401 跳登录页
      if (res.status === 401) {
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
        return res;
      }

      // 尝试读取错误消息
      const data = await res.clone().json().catch(() => null);
      const errorMsg = data?.error || `请求失败 (${res.status})`;
      message.error(errorMsg);
    }

    return res;
  } catch (err: any) {
    message.error(`网络错误: ${err.message}`);
    throw err;
  }
}
