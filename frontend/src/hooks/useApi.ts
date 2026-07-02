import { useCallback, useEffect, useRef, useState } from 'react';

interface Options<T> {
  initial?: T;
  skip?: boolean;
}

export interface ApiResult<T> {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  reload: () => void;
  /** Refetch without toggling `loading` — for background polling (no spinner flicker). */
  reloadSilent: () => void;
}

/**
 * Tiny data-fetching hook with loading/error state and manual reload.
 * `deps` controls when the fetch re-runs (like useEffect deps).
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  options: Options<T> = {},
): ApiResult<T> {
  const [data, setData] = useState<T | undefined>(options.initial);
  const [loading, setLoading] = useState(!options.skip);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const silentRef = useRef(false);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const reloadSilent = useCallback(() => {
    silentRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (options.skip) {
      setLoading(false);
      return;
    }
    let active = true;
    const silent = silentRef.current;
    silentRef.current = false;
    if (!silent) setLoading(true);
    setError(null);
    fetcher()
      .then((res) => {
        if (active) setData(res);
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, options.skip]);

  return { data, loading, error, reload, reloadSilent };
}
