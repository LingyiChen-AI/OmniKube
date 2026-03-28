'use client';

import { useEffect, useRef, useCallback } from 'react';
import { request } from '@/lib/request';

/**
 * Subscribe to K8s resource changes via WebSocket Watch API.
 * Calls `onChanged` when resources of the given kind are added/modified/deleted.
 */
export function useResourceWatch(
  clusterId: string | null,
  kind: string,
  namespace: string | undefined,
  onChanged: () => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Debounce: multiple rapid changes → single refresh
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChangedRef.current();
    }, 500);
  }, []);

  useEffect(() => {
    if (!clusterId || !kind) return;

    let cancelled = false;

    async function connect() {
      try {
        const tokenRes = await request('/api/auth/me', { credentials: 'include' });
        if (!tokenRes.ok || cancelled) return;
        const { wsToken } = await tokenRes.json();
        if (!wsToken || cancelled) return;

        const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
        if (!wsUrl || cancelled) return;

        const ws = new WebSocket(`${wsUrl}?token=${wsToken}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) { ws.close(); return; }
          ws.send(JSON.stringify({
            type: 'subscribe-watch',
            clusterId,
            namespace: namespace || undefined,
            kind,
          }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'resource-changed') {
              debouncedRefresh();
            }
          } catch {}
        };

        ws.onclose = () => {
          // Auto-reconnect after 5s unless cancelled
          if (!cancelled) {
            setTimeout(connect, 5000);
          }
        };
      } catch {}
    }

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [clusterId, kind, namespace, debouncedRefresh]);
}
