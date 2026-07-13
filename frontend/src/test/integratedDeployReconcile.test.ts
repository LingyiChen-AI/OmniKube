import { describe, it, expect } from 'vitest';
import { baseDrifted } from '../pages/integratedDeploy/reconcile';

describe('baseDrifted — has the cluster object moved since the order snapshot', () => {
  it('not drifted when resourceVersion is unchanged', () => {
    expect(
      baseDrifted(
        { manifest_yaml: 'a: 1\n', resource_version: '100' },
        { manifest_yaml: 'a: 999\n', resource_version: '100' },
      ),
    ).toBe(false);
  });

  it('drifted when resourceVersion differs (even if content looks same)', () => {
    expect(
      baseDrifted(
        { manifest_yaml: 'a: 1\n', resource_version: '100' },
        { manifest_yaml: 'a: 1\n', resource_version: '101' },
      ),
    ).toBe(true);
  });

  it('legacy item without RV: falls back to content comparison — identical → not drifted', () => {
    expect(
      baseDrifted(
        { manifest_yaml: 'a: 1\n', resource_version: '' },
        { manifest_yaml: 'a: 1\n', resource_version: '101' },
      ),
    ).toBe(false);
  });

  it('legacy item without RV: content differs → drifted', () => {
    expect(
      baseDrifted(
        { manifest_yaml: 'a: 1\n', resource_version: '' },
        { manifest_yaml: 'a: 2\n', resource_version: '101' },
      ),
    ).toBe(true);
  });

  it('live RV missing: falls back to content comparison', () => {
    expect(
      baseDrifted(
        { manifest_yaml: 'a: 1\n', resource_version: '100' },
        { manifest_yaml: 'a: 1\n', resource_version: '' },
      ),
    ).toBe(false);
  });
});
