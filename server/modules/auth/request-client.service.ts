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

/**
 * Tells who sent a request, for every per-client limit (see StudioRequestClient):
 * - With STUDIO_CLOUDFLARED_PORT set (the recommended setup, docs/security.md), exactly the
 *   connections that arrived on that loopback listener are the public door, keyed by
 *   CF-Connecting-IP; Cloudflare headers on every other port are ignored.
 * - Without it (header mode), every loopback request carrying any Cloudflare edge header is the
 *   public door, whatever else it carries: Tailscale-* headers, a *.ts.net Host or a tailnet
 *   X-Forwarded-For never move such a request into the direct or tailnet door, so the internet can
 *   never spend the local or tailnet budgets. The price is that a tailnet device can pose as a
 *   public client by forging CF-Connecting-IP; only the dedicated port closes that.
 * - Tailscale Serve traffic (loopback, *.ts.net Host, exactly one tailnet address in
 *   X-Forwarded-For, and in header mode no Cloudflare headers) is keyed by that tailnet device.
 * - Tailscale Funnel requests (Tailscale-Funnel-Request) are public traffic too: the public door,
 *   keyed by the client address Serve writes into X-Forwarded-For.
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
  if (tunnelPort !== null && fromLoopback && request.socket?.localPort === tunnelPort) {
    return { door: 'cloudflare', address: clientAddressKey(headerText(request, 'cf-connecting-ip')) };
  }
  // Tailscale Funnel is the public internet through Serve: the public door, keyed by the one
  // client address Serve writes into X-Forwarded-For (Serve drops client copies of both headers).
  if (fromLoopback && request.headers['tailscale-funnel-request'] !== undefined) {
    return { door: 'cloudflare', address: clientAddressKey(headerText(request, 'x-forwarded-for')) };
  }
  // Header mode only: with the listener configured, Cloudflare headers elsewhere mean nothing.
  if (tunnelPort === null && fromLoopback && isViaCloudflareEdge(request.headers)) {
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
 * Used by security-events.service, so stored events never hold a full address, and through the auth barrel
 * by the studio module for the Trading 212 step-up audit rows.
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
