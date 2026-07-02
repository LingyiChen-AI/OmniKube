/**
 * 把后端的列表响应归一化为数组。
 * 后端各列表端点用命名键包裹（{clusters}/{users}/{roles}/{namespaces}/...），
 * 也可能是裸数组 / {items} / {data}。这里统一抽取出数组。
 */
export function unwrapList<T = any>(data: any): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const preferred = ['items', 'data', 'clusters', 'users', 'roles', 'namespaces', 'resources'];
    for (const k of preferred) {
      if (Array.isArray(data[k])) return data[k] as T[];
    }
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
