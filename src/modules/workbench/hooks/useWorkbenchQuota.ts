import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { StudioQuotaSnapshot } from '@/shared/types';

// Same cadence as the home-screen widgets; the server caches each provider for a minute anyway.
const REFRESH_MS = 60_000;

/** Used by the workbench sidebar's quota bars: Claude, Codex and DeepSeek snapshots from GET /api/studio/quota. */
export function useWorkbenchQuota() {
  // Latest snapshots; null until the first answer, and a failed refresh keeps the previous reading.
  const [snapshots, setSnapshots] = useState<StudioQuotaSnapshot[] | null>(null);

  const load = useCallback(async () => {
    const next = await api.studio.quota().then(readApiJson<StudioQuotaSnapshot[]>).catch(() => null);
    setSnapshots(previous => (Array.isArray(next) ? next : previous ?? []));
  }, []);

  useEffect(() => {
    void load();
    // A hidden tab does not poll; the next tick after it returns catches up.
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return snapshots;
}
