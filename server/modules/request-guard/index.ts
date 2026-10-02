// createRequestGuard: used by the server entrypoint for the per-client/per-door rate limits on
// every HTTP request and the WebSocket upgrade admission and connection caps.
export { createRequestGuard } from './request-guard.service.js';
// applyHttpServerLimits / createBodyParsers / BODY_LIMITS / clientErrorStatus /
// WEBSOCKET_MAX_PAYLOAD_BYTES: used by the server entrypoint to bound timeouts, connections,
// request bodies and WebSocket messages, and to answer oversized or malformed bodies with 4xx.
export {
  applyHttpServerLimits,
  BODY_LIMITS,
  clientErrorStatus,
  createBodyParsers,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from './server-limits.service.js';
