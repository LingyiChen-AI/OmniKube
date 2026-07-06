import { describe, expect, it } from 'vitest';
import { capabilityAllows } from './caps';
import type { CapabilityResources } from '../api/me';

describe('capabilityAllows', () => {
  const caps: CapabilityResources = {
    deployments: ['view', 'edit'],
    pods: [],
    customresources: ['view', 'create'],
  };

  it('uses the concrete resource entry for built-ins', () => {
    expect(capabilityAllows(caps, 'deployments', 'edit')).toBe(true);
    expect(capabilityAllows(caps, 'deployments', 'delete')).toBe(false);
  });

  it('denies a built-in with an empty action set (no customresources fallback)', () => {
    expect(capabilityAllows(caps, 'pods', 'create')).toBe(false);
  });

  it('falls back to customresources for unknown/CRD resources', () => {
    expect(capabilityAllows(caps, 'virtualservices', 'view')).toBe(true);
    expect(capabilityAllows(caps, 'virtualservices', 'create')).toBe(true);
    expect(capabilityAllows(caps, 'virtualservices', 'delete')).toBe(false);
  });

  it('returns false when resource is undefined', () => {
    expect(capabilityAllows(caps, undefined, 'view')).toBe(false);
  });
});
