import yaml from 'js-yaml';
import type { K8sObject } from '../../api/resource';

/** Deep clone that works in browsers and jsdom (Node 18+). */
export function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Immutable update helper: clones `draft`, runs `mutator` over the copy and
 * returns it. Untouched fields are preserved by the clone, so forms only need
 * to mutate the "common" paths they care about.
 */
export function update<T>(draft: T, mutator: (next: T) => void): T {
  const next = clone(draft);
  mutator(next);
  return next;
}

/** Dump a manifest to YAML using the project's conventions. */
export function toYAML(obj: unknown): string {
  return yaml.dump(obj, { noRefs: true, sortKeys: false, lineWidth: 120 });
}

/** Parse YAML to an object, throwing on invalid input or non-objects. */
export function fromYAML(text: string): K8sObject {
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('YAML did not produce an object');
  }
  return parsed as K8sObject;
}

/** Decode a base64 string to UTF-8 text; returns the input unchanged on error. */
export function decodeBase64(s: string): string {
  try {
    const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return s;
  }
}

/** Encode UTF-8 text to a base64 string. */
export function encodeBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

/**
 * Force the immutable primary keys (apiVersion / kind / metadata.name /
 * metadata.namespace) on `obj` to match `original`, so an edit can never
 * rename or retype a resource. Returns a new object.
 */
export function forcePrimaryKeys(obj: K8sObject, original: K8sObject): K8sObject {
  const next = clone(obj);
  next.apiVersion = original.apiVersion;
  next.kind = original.kind;
  next.metadata = {
    ...(next.metadata || {}),
    name: original.metadata?.name,
    namespace: original.metadata?.namespace,
  };
  return next;
}
