import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

type WebPushState = {
  permission: NotificationPermission | 'unsupported';
  isSubscribed: boolean;
  isLoading: boolean;
  // Why the last subscribe or unsubscribe failed ('' after a success).
  error: string;
  // Resolves true when this browser ended up subscribed and registered with the server.
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function currentPermission(): NotificationPermission | 'unsupported' {
  if (
    typeof window === 'undefined'
    || Boolean((window as Window & { cloudcliDesktopNotifications?: unknown }).cloudcliDesktopNotifications)
    || !('Notification' in window)
    || !('serviceWorker' in navigator)
  ) {
    return 'unsupported';
  }
  return Notification.permission;
}

/**
 * Used by the settings module (notification settings) and the studio module (a project's 自动化 tab) to read and
 * change this browser's Web Push subscription. The permission is read again whenever the page comes back into
 * view, so a change made in the system settings shows up without a reload.
 */
export function useWebPush(): WebPushState {
  // The browser's notification permission; 'unsupported' where Web Push cannot work (e.g. iPad Safari outside the home screen).
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(currentPermission);
  // Whether this browser already holds a push subscription.
  const [isSubscribed, setIsSubscribed] = useState(false);
  // Disables the controls while the browser or server is asked.
  const [isLoading, setIsLoading] = useState(false);
  // Shown next to the controls when subscribing fails.
  const [error, setError] = useState('');

  // The permission can change in the system settings while the page is in the background.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setPermission(currentPermission()); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  // Check existing subscription on mount
  useEffect(() => {
    if (permission === 'unsupported') return;

    navigator.serviceWorker.ready.then((registration) => {
      registration.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(sub !== null);
      });
    }).catch(() => {
      // SW not ready yet
    });
  }, [permission]);

  const subscribe = useCallback(async () => {
    if (permission === 'unsupported') return false;
    setIsLoading(true);
    setError('');

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return false;

      const keyRes = await api.settings.push.vapidPublicKey();
      const { publicKey } = await keyRes.json();

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const subJson = subscription.toJSON();
      const saved = await api.settings.push.subscribe({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      });
      if (!saved.ok) throw new Error(`server answered ${saved.status}`);

      setIsSubscribed(true);
      return true;
    } catch (err) {
      console.error('Push subscribe failed:', err);
      setError('没能开启通知，请稍后再试');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [permission]);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await api.settings.push.unsubscribe(endpoint);
      }
      setIsSubscribed(false);
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
      setError('没能关闭通知，请稍后再试');
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { permission, isSubscribed, isLoading, error, subscribe, unsubscribe };
}
