import client from './client';
import { unwrapList } from './normalize';

/** One release-record audit row as returned by GET /releases. */
export interface ReleaseRecord {
  id: number;
  user_id: number;
  username: string;
  cluster_id: string;
  namespace: string;
  kind: string;
  name: string;
  image_before: string;
  image_after: string;
  comment: string;
  via_ai?: boolean; // 由 AI 助手确认执行的发布
  source?: string; // 记录来源: resource(单资源发布) / integrated_deploy(集成部署)
  created_at: string;
}

export interface ReleaseListParams {
  cluster_id?: string;
  namespace?: string;
  limit?: number;
}

export const releaseApi = {
  /** List release records (newest first), optionally scoped by cluster/namespace. */
  list: (params: ReleaseListParams = {}) =>
    client
      .get<{ releases: ReleaseRecord[] }>('/releases', { params })
      .then((r) => unwrapList<ReleaseRecord>(r.data)),
};

/** True if an ISO timestamp falls on the same local calendar day as `ref`. */
export function isSameLocalDay(iso: string | undefined, ref: Date = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

/** Count release records created today (local calendar day). */
export function countTodayReleases(records: ReleaseRecord[], ref: Date = new Date()): number {
  return records.reduce((n, r) => (isSameLocalDay(r.created_at, ref) ? n + 1 : n), 0);
}

/**
 * Split an image ref into `{ repo, tag }`. The tag is the part after the last
 * colon *only* when no `/` follows it (otherwise that colon is a registry port,
 * e.g. `registry:5000/app`). `repo` keeps the full path incl. registry/host.
 */
export function splitImageTag(image: string): { repo: string; tag: string } {
  const colon = image.lastIndexOf(':');
  if (colon === -1 || image.indexOf('/', colon) !== -1) {
    return { repo: image, tag: '' };
  }
  return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
}

/** Parse a "name=image;name=image" string into [name, image] pairs. */
export function parseImageList(s: string): { name: string; image: string }[] {
  if (!s) return [];
  return s
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      return idx === -1
        ? { name: '', image: part }
        : { name: part.slice(0, idx), image: part.slice(idx + 1) };
    });
}
