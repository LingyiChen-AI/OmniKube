import client from './client';
import type { Operations } from './role';

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
}

export interface AiConfig {
  enabled: boolean;
  base_url: string;
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
  has_key: boolean;
}

export interface AiConfigInput {
  enabled: boolean;
  base_url: string;
  api_key?: string; // omit/empty = keep existing
  model_id: string;
  temperature: number;
  system_prompt: string;
  max_steps: number;
}

export const aiApi = {
  status: () => client.get<AiStatus>('/ai/status').then((r) => r.data),
  getConfig: () => client.get<AiConfig>('/ai/config').then((r) => r.data),
  putConfig: (body: AiConfigInput) => client.put('/ai/config', body).then((r) => r.data),
  getGrants: (clusterId: string) =>
    client
      .get<{ cluster_id: string; operations: Operations }>('/ai/grants', { params: { cluster_id: clusterId } })
      .then((r) => r.data.operations ?? {}),
  putGrants: (clusterId: string, operations: Operations) =>
    client.put('/ai/grants', { operations }, { params: { cluster_id: clusterId } }).then((r) => r.data),
};
