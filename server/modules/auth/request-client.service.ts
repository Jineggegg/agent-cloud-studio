import { isIP } from 'node:net';

import type { StudioRequestClient } from '@/shared/types.js';
import { isViaCloudflareEdge, readCloudflaredPort } from '@/shared/utils.js';

import {
  isLoopbackAddress,
  isTailnetHost,
  singleTailnetAddress,
} from './tailscale-session.service.js';

// What the classifier needs from an Express request or a WebSocket upgrade request.
type ClientRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string; localPort?: number };
};

const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
// Serve sets these from WhoIs (deleting client copies) on tailnet traffic; Cloudflare never does.
const TAILSCALE_IDENTITY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic'];

function headerText(request: ClientRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

// The first four groups of an IPv6 address, expanded, as "a:b:c:d::/64". `address` is valid IPv6.
function ipv6Prefix64(address: string): string {
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 tail ("::ffff:1.2.3.4" style) takes the room of two groups.
  const width = (groups: string[]) => groups.reduce((total, group) => total + (group.includes('.') ? 2 : 1), 0);
  const zeros = halves.length > 1 ? Array<string>(Math.max(0, 8 - width(left) - width(right))).fill('0') : [];
  const groups = [...left, ...zeros, ...right];
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

// One spelling per client (IPv4-mapped IPv6 becomes plain IPv4; IPv6 becomes its /64, which one
// subscriber controls entirely), capped so a forged value can never grow a bucket key; anything
// that is not an IP is 'unknown'.
function clientAddressKey(value: string | undefined): string {
  const trimmed = value?.trim().split('%')[0] ?? '';
  const address = IPV4_MAPPED_PREFIX.exec(trimmed)?.[1] ?? trimmed;
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) return ipv6Prefix64(address.toLowerCase());
  return 'unknown';
}

// Signs that a loopback request came through Tailscale Serve rather than cloudflared: the MagicDNS
// Host (or the configured tailnet origin's host), Serve's identity headers, or exactly one tailnet
// address in X-Forwarded-For (Cloudflare appends the real client to any forged value, and never
// sees a 100.64.0.0/10 client). Such a request is never the public door, whatever CF-* it carries.
function looksLikeTailscaleServe(request: ClientRequest, env: Record<string, string | undefined>): boolean {
  const host = headerText(request, 'host')?.trim().toLowerCase() ?? '';
  try {
    const tailnetOrigin = env.STUDIO_TAILNET_ORIGIN?.trim();
    if (tailnetOrigin && host && new URL(tailnetOrigin).host.toLowerCase() === host) return true;
  } catch {
    // A malformed STUDIO_TAILNET_ORIGIN names no host.
  }
  if (TAILSCALE_IDENTITY_HEADERS.some((name) => request.headers[name] !== undefined)) return true;
  if (singleTailnetAddress(headerText(request, 'x-forwarded-for')) !== null) return true;
  return isTailnetHost(host);
}

/**
 * Tells who sent a request, for every per-client limit (see StudioRequestClient):
 * - With STUDIO_CLOUDFLARED_PORT set (the recommended setup, docs/security.md), exactly the
 *   connections that arrived on that loopback listener are the public door, keyed by
 *   CF-Connecting-IP; Cloudflare headers on every other port are ignored.
 * - Without it, CF-Connecting-IP counts only for a loopback request with Cloudflare's edge headers
 *   and no sign of Tailscale Serve (see looksLikeTailscaleServe), so a tailnet device cannot pose as
 *   an arbitrary public client.
 * - Tailscale Serve traffic (loopback, *.ts.net Host, exactly one tailnet address in
 *   X-Forwarded-For) is keyed by that tailnet device.
 * - Otherwise the raw socket peer. X-Forwarded-For is never read for anything else.
 * Public and direct IPv6 clients are keyed by their /64.
 *
 * Used by auth.routes (password throttle, lockout scope, passkey ceremonies, events, handoff
 * redemptions) and, through the auth barrel, by the server entrypoint for the request-guard module
 * (rate limits, in-flight caps, WebSocket connection caps). `env` is process.env in production.
 */
export function readRequestClient(
  request: ClientRequest,
  env: Record<string, string | undefined> = process.env,
): StudioRequestClient {
  const socketAddress = request.socket?.remoteAddress;
  const fromLoopback = isLoopbackAddress(socketAddress);
  const tunnelPort = readCloudflaredPort(env);
  if (tunnelPort !== null) {
    if (fromLoopback && request.socket?.localPort === tunnelPort) {
      return { door: 'cloudflare', address: clientAddressKey(headerText(request, 'cf-connecting-ip')) };
    }
  } else if (fromLoopback && isViaCloudflareEdge(request.headers) && !looksLikeTailscaleServe(request, env)) {
    return { door: 'cloudflare', address: clientAddressKey(headerText(request, 'cf-connecting-ip')) };
  }
  if (fromLoopback && isTailnetHost(headerText(request, 'host')?.trim())) {
    const node = singleTailnetAddress(headerText(request, 'x-forwarded-for'));
    if (node) {
      return { door: 'tailnet', address: node };
    }
  }
  return { door: 'direct', address: clientAddressKey(socketAddress) };
}

/**
 * Shortens a client address for the security event log shown in Settings: the first two IPv4
 * octets ("198.51.*.*") or the first two IPv6 groups ("2001:db8:*", also for a "/64" key);
 * anything else is "unknown".
 * Used by security-events.service, so stored events never hold a full address.
 */
export function maskClientAddress(address: string): string {
  const bare = address.endsWith('/64') ? address.slice(0, -3) : address;
  const version = isIP(bare);
  if (version === 4) {
    const [first, second] = bare.split('.');
    return `${first}.${second}.*.*`;
  }
  if (version === 6) {
    const groups = bare.split(':').filter(Boolean).slice(0, 2);
    return groups.length ? `${groups.join(':')}:*` : '::*';
  }
  return 'unknown';
}
