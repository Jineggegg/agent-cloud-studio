import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebPush } from '@/shared/hooks/useWebPush';
import type { StudioPushStatus } from '@/shared/types';

// Whether automations can reach this device, and if not, what stands in the way.
type PushState = 'needs-install' | 'unsupported' | 'default' | 'denied' | 'off-here' | 'off-server' | 'on';

// iPhone and iPad (which reports itself as a Mac with touch) only allow Web Push from a home-screen web app.
function isAppleMobile() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
const readServerStatus = () => api.studio.automations.push().then(readApiJson<StudioPushStatus>);

function isStandalone() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone);
}

/**
 * Used by the 自动化 tab's notification check: whether automations can reach this device, as one state —
 * 'needs-install' (iPad/iPhone Safari outside the home screen), 'unsupported', 'default' (never asked), 'denied',
 * 'off-here' (allowed but this device is not subscribed), 'off-server' (push switched off for the owner), 'on' —
 * plus the actions that fix it and a test notification.
 */
export function useStudioPush() {
  const push = useWebPush();
  // The owner's Web Push switch and subscribed devices from the server; null until read (or when it failed).
  const [server, setServer] = useState<StudioPushStatus | null>(null);
  // The answer to the last test notification ('' before one was sent).
  const [testResult, setTestResult] = useState('');
  // Disables the test button while the server sends it.
  const [testing, setTesting] = useState(false);

  const loadServer = useCallback(async () => {
    try { setServer(await readServerStatus()); } catch { setServer(null); }
  }, []);
  useEffect(() => {
    let active = true;
    void readServerStatus().then(value => { if (active) setServer(value); }).catch(() => { if (active) setServer(null); });
    return () => { active = false; };
  }, []);

  const state: PushState = push.permission === 'unsupported' ? (isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported')
    : push.permission === 'denied' ? 'denied'
      : push.permission === 'default' ? 'default'
        : !push.isSubscribed ? 'off-here'
          : server && !server.enabled ? 'off-server' : 'on';

  async function enable() {
    setTestResult('');
    if (await push.subscribe()) await loadServer();
  }
  async function sendTest() {
    setTesting(true);
    setTestResult('');
    try {
      const result = await api.studio.automations.testPush().then(readApiJson<StudioPushStatus & { delivered: number }>);
      setTestResult(result.delivered ? `已发出测试通知（${result.delivered} 台设备）` : '没有设备接收这条通知');
    } catch (failure) {
      setTestResult(failure instanceof Error ? failure.message : '测试通知没有发出');
    } finally { setTesting(false); }
  }

  return { state, devices: server?.devices ?? 0, busy: push.isLoading, error: push.error, enable, sendTest, testing, testResult };
}
