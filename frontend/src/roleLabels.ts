import type { TFunction } from 'i18next';

/**
 * Display name for a role. Preset/system roles carry a stable `key` so their
 * label can be localized (`role.preset.<key>.name`); the stored name is the
 * fallback. Custom roles (no key) always show their stored name.
 */
export function roleName(t: TFunction, role: { key?: string; name: string }): string {
  if (role.key) return t(`role.preset.${role.key}.name`, { defaultValue: role.name });
  return role.name;
}

/** Localized description for a preset role, falling back to the stored value. */
export function roleDesc(t: TFunction, role: { key?: string; description?: string }): string {
  const desc = role.description ?? '';
  if (role.key) return t(`role.preset.${role.key}.desc`, { defaultValue: desc });
  return desc;
}
