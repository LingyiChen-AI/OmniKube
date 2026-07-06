import client from './client';

/** 一种集群资源类型的元数据(来自 GET /api-resources)。 */
export interface ApiResourceType {
  group: string;
  version: string;
  resource: string; // 复数名,用于通用 CRUD
  kind: string;
  namespaced: boolean;
  builtin: boolean; // 现有 13 种内置资源(前端默认隐藏)
  verbs: string[];
}

/** group/version 拼成 apiVersion:core 组无 group,直接用 version。 */
export function apiVersionOf(t: ApiResourceType): string {
  return t.group ? `${t.group}/${t.version}` : t.version;
}

export const apiResourcesApi = {
  list: () =>
    client.get<{ resources: ApiResourceType[] }>('/api-resources').then((r) => r.data.resources ?? []),
};
