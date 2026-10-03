export {
  // Used by notification tests and delivery workflows to create channel payloads.
  buildNotificationPayload,
  // Used by provider runtimes and Settings to create normalized notification events.
  createNotificationEvent,
  // Used by provider runtimes and Settings to deliver events through enabled channels.
  notifyUserIfEnabled,
  // Used by provider runtimes to report failed agent runs.
  notifyRunFailed,
  // Used by provider runtimes to report stopped or completed agent runs, and by Studio for DeepSeek replies.
  notifyRunStopped,
  // Used by task recovery at startup to report runs the previous server process left unfinished.
  notifyRunInterrupted,
  // Used by provider runtimes to report background work that finished after its turn ended.
  notifyBackgroundWorkCompleted,
  // Used by Studio automations: whether Web Push is on and how many browsers are subscribed.
  getStudioPushStatus,
  // Used by Studio automations to push their notifications (and the test notification) to the owner.
  sendStudioPushNotification,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
export {
  registerDesktopNotificationClient,
  sendDesktopNotification,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
export {
  // Used by the websocket chat gateway to record (and forget) which sessions each visible page shows.
  reportSessionPresence,
  forgetSessionPresence,
  // Used by Studio's workbench activity: whether a finished run was seen, and sessions coming into view.
  isSessionInView,
  onSessionsViewed,
} from '@/modules/notifications/services/session-presence.service.js';
export { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
// getPublicKey: used by Settings to expose the Web Push subscription key.
export { getPublicKey } from './vapid-keys.service.js';
// configureWebPush: used by the server entrypoint during notification startup.
export { configureWebPush } from './vapid-keys.service.js';
