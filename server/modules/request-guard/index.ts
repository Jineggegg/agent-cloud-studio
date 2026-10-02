// createRequestGuard: used by the server entrypoint for the per-client/per-door rate limits and
// in-flight caps on every HTTP request and the WebSocket upgrade admission and connection caps.
export { createRequestGuard } from './request-guard.service.js';
// applyHttpServerLimits / createBodyParsers / BODY_LIMITS / clientErrorStatus /
// HTTP_SERVER_LIMITS / WEBSOCKET_MAX_PAYLOAD_BYTES: used by the server entrypoint to bound
// timeouts, connections, request bodies and WebSocket messages, and to answer oversized or
// malformed bodies with 4xx.
export {
  applyHttpServerLimits,
  BODY_LIMITS,
  clientErrorStatus,
  createBodyParsers,
  HTTP_SERVER_LIMITS,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from './server-limits.service.js';
// startCloudflaredListener: used by the server entrypoint to open STUDIO_CLOUDFLARED_PORT, the
// loopback port only cloudflared connects to.
export { startCloudflaredListener } from './tunnel-listener.service.js';
