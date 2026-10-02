import { isIP } from 'node:net';

import type { StudioRequestClient } from '@/shared/types.js';
import { isViaCloudflareEdge } from '@/shared/utils.js';

import {
  isLoopbackAddress,
  isTailnetDoorRequest,
  parseTailscaleSignInConfig,
  singleTailnetAddress,
} from './tailscale-session.service.js';

// What the classifier needs from an Express request or a WebSocket upgrade request.
type ClientRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function headerText(request: ClientRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

// One spelling per address (IPv4-mapped IPv6 becomes plain IPv4), capped so a forged value can
// never grow a bucket key; anything that is not an IP is 'unknown'.
function canonicalClientAddress(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  const address = IPV4_MAPPED_PREFIX.exec(trimmed)?.[1] ?? trimmed;
  return isIP(address) ? address.toLowerCase().slice(0, 64) : 'unknown';
}

/**
 * Tells who sent a request, for every per-client limit (see StudioRequestClient):
 * - CF-Connecting-IP only when the socket peer is loopback (cloudflared runs on this machine) and
 *   Cloudflare's edge headers are present; Cloudflare overwrites that header, so it is the real
 *   client there. The same headers from any other peer are ignored.
 * - The tailnet peer from X-Forwarded-For only for a Tailscale Serve request (loopback socket,
 *   *.ts.net Host, the pinned tailnet origin when configured, exactly one tailnet address).
 * - Otherwise the raw socket peer. X-Forwarded-For is never read for anything else.
 *
 * Used by auth.routes (password throttle, lockout events, handoff redemptions) and, through the
 * auth barrel, by the request-guard module (rate limits, WebSocket connection caps). `env` is
 * process.env in production, filled from .env once at startup.
 */
export function readRequestClient(
  request: ClientRequest,
  env: Record<string, string | undefined> = process.env,
): StudioRequestClient {
  const socketAddress = request.socket?.remoteAddress;
  const fromLoopback = isLoopbackAddress(socketAddress);
  if (fromLoopback && isViaCloudflareEdge(request.headers)) {
    return { door: 'cloudflare', address: canonicalClientAddress(headerText(request, 'cf-connecting-ip')) };
  }
  if (fromLoopback && isTailnetDoorRequest(request, parseTailscaleSignInConfig(env))) {
    const node = singleTailnetAddress(headerText(request, 'x-forwarded-for'));
    if (node) {
      return { door: 'tailnet', address: node };
    }
  }
  return { door: 'direct', address: canonicalClientAddress(socketAddress) };
}

/**
 * Shortens a client address for the security event log shown in Settings: the first two IPv4
 * octets ("198.51.*.*") or the first two IPv6 groups ("2001:db8:*"); anything else is "unknown".
 * Used by auth.service and account-security.service, so stored events never hold a full address.
 */
export function maskClientAddress(address: string): string {
  const version = isIP(address);
  if (version === 4) {
    const [first, second] = address.split('.');
    return `${first}.${second}.*.*`;
  }
  if (version === 6) {
    const groups = address.split(':').filter(Boolean).slice(0, 2);
    return groups.length ? `${groups.join(':')}:*` : '::*';
  }
  return 'unknown';
}
