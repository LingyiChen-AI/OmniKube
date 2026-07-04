import type { K8sObject } from '../../api/resource';

export interface Mount {
  kind: 'configmaps' | 'secrets';
  name: string;
}

/**
 * Collect referenced ConfigMap/Secret names from a workload manifest. Handles
 * the CronJob `spec.jobTemplate.spec` unwrap; returns [] for non-workloads or
 * odd shapes. Results are de-duped by `kind:name`.
 */
export function extractMounts(obj: K8sObject | undefined): Mount[] {
  const out: Mount[] = [];
  // Workloads keep the pod template at spec.template.spec; CronJob nests one
  // more level under spec.jobTemplate.
  const podSpec = obj?.spec?.template?.spec ?? obj?.spec?.jobTemplate?.spec?.template?.spec;
  const push = (kind: Mount['kind'], name: string | undefined) => {
    if (name) out.push({ kind, name });
  };
  for (const v of podSpec?.volumes ?? []) {
    push('configmaps', v?.configMap?.name);
    push('secrets', v?.secret?.secretName);
  }
  for (const c of podSpec?.containers ?? []) {
    for (const e of c?.envFrom ?? []) {
      push('configmaps', e?.configMapRef?.name);
      push('secrets', e?.secretRef?.name);
    }
    for (const e of c?.env ?? []) {
      push('configmaps', e?.valueFrom?.configMapKeyRef?.name);
      push('secrets', e?.valueFrom?.secretKeyRef?.name);
    }
  }
  return Array.from(new Map(out.map((m) => [`${m.kind}:${m.name}`, m])).values());
}
