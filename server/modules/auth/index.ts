// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
// requireCloudflareAccess / admitCloudflareAccessUpgrade: used by the server entrypoint to enforce the
// optional Cloudflare Access check on HTTP requests and WebSocket upgrades from the public door.
export { admitCloudflareAccessUpgrade, requireCloudflareAccess } from './auth.module.js';
// onSessionsRevoked: used by the server entrypoint to close a user's live WebSockets after
// "退出所有设备".
export { onSessionsRevoked } from './auth.module.js';
// readRequestClient: used by the request-guard module to key its rate limits and WebSocket
// connection caps by the same real client (and door) the auth throttles use.
export { readRequestClient } from './request-client.service.js';
