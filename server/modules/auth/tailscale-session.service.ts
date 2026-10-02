import { BlockList, isIP } from 'node:net';

/**
 * Passwordless sign-in policy for requests that arrive through Tailscale Serve.
 *
 * Trust model (see the Tailscale Serve docs, https://tailscale.com/kb/1312/serve, and
 * ipn/ipnlocal/serve.go in tailscale/tailscale):
 * - Serve proxies to a backend on this machine, so its requests reach Studio over loopback.
 * - Serve deletes client-supplied Tailscale-User-Login/-Name/-Profile-Pic/Tailscale-Funnel-Request
 *   headers, then sets them from WhoIs for the tailnet peer; tagged devices and Funnel (public)
 *   requests never carry identity headers, and Funnel requests are marked Tailscale-Funnel-Request.
 * - Serve's Go reverse proxy drops incoming X-Forwarded-* headers and then sets X-Forwarded-For to
 *   exactly one address: the peer it accepted the connection from (a tailnet address for tailnet
 *   traffic, the public client address for Funnel).
 * - Tailscale identity is ambient, like a cookie: any web page opened on the owner's device could
 *   reach the Serve URL with the owner's identity. Only same-origin browser requests to a
 *   *.ts.net host are therefore accepted, which also defeats DNS rebinding and cross-site
 *   requests aimed at the loopback port from a browser on this machine.
 */

type TailscaleSignInConfig = {
  /** Lower-cased Tailscale login names allowed to sign in; an empty list disables the feature. */
  allowedLogins: string[];
  /** Local Studio username the identity maps to; null means "the only active user". */
  mappedUsername: string | null;
  /** Exact public origin (STUDIO_PUBLIC_ORIGIN) the request must come from, when configured. */
  publicOrigin: string | null;
};

type TailscaleSessionRequest = {
  /** Raw TCP peer address of the request socket (never a forwarded-for value). */
  remoteAddress: string | undefined;
  /** Host header as received; Serve forwards the host the browser used. */
  host: string | undefined;
  /** Origin header; browsers send it on every POST, same-origin included. */
  origin: string | undefined;
  /** Sec-Fetch-Site header, when the browser sends one. */
  fetchSite: string | undefined;
  /** X-Forwarded-For header; duplicates are joined with ", " by Node. */
  forwardedFor: string | undefined;
  /** Tailscale-User-Login header set by Serve for tailnet users. */
  userLogin: string | undefined;
  /** Tailscale-Funnel-Request header, which Serve sets on public Funnel traffic. */
  funnelRequest: string | undefined;
};

type TailscaleDenialReason =
  | 'disabled'
  | 'funnel-request'
  | 'socket-not-loopback'
  | 'forwarded-for-not-tailnet'
  | 'host-not-tailnet'
  | 'cross-site'
  | 'identity-missing'
  | 'login-not-allowed';

type TailscaleSessionDecision =
  | { allowed: true; login: string }
  | { allowed: false; reason: TailscaleDenialReason; login: string | null };

// Serve dials the backend over loopback; other peers can reach Studio only by bypassing Serve.
const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

// Supersets Tailscale assigns node addresses from (tailscale/net/tsaddr CGNATRange and
// TailscaleULARange). A Funnel request carries a public address here and is refused.
const TAILNET_ADDRESSES = new BlockList();
TAILNET_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
TAILNET_ADDRESSES.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const HOST_HEADER_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

function isAddressIn(list: BlockList, value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses (::ffff:127.0.0.1).
  const trimmed = value.trim();
  const address = IPV4_MAPPED_PREFIX.exec(trimmed)?.[1] ?? trimmed;
  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  try {
    return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
  } catch {
    // Zone-scoped or otherwise unusual addresses are never loopback or tailnet peers.
    return false;
  }
}

// MagicDNS names have the shape <machine>.<tailnet>.ts.net; certificates for Serve exist only there.
function isTailnetHost(host: string | undefined): host is string {
  if (!host || !HOST_HEADER_PATTERN.test(host)) {
    return false;
  }
  const labels = host.split(':')[0].toLowerCase().split('.');
  return labels.length >= 4
    && labels.every(Boolean)
    && labels.at(-2) === 'ts'
    && labels.at(-1) === 'net';
}

function parseOrigin(value: string | undefined | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Compares host and port the way the browser does, so ":443" on an https origin equals no port.
function isSameOriginRequest(request: TailscaleSessionRequest, host: string, publicOrigin: string | null): boolean {
  const origin = parseOrigin(request.origin);
  if (!origin || (request.fetchSite && request.fetchSite !== 'same-origin')) {
    return false;
  }
  const expected = parseOrigin(publicOrigin);
  // A configured origin that does not parse must not silently disable the pin.
  if (publicOrigin && !expected) {
    return false;
  }
  if (expected && origin.origin !== expected.origin) {
    return false;
  }
  try {
    return new URL(`${origin.protocol}//${host}`).host === origin.host;
  } catch {
    return false;
  }
}

/**
 * Reads the sign-in configuration from environment variables.
 * Used by auth.module (composition root) on every request so the policy follows the process env.
 */
export function parseTailscaleSignInConfig(env: Record<string, string | undefined>): TailscaleSignInConfig {
  return {
    allowedLogins: (env.STUDIO_TAILSCALE_LOGINS ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    mappedUsername: env.STUDIO_TAILSCALE_USER?.trim() || null,
    publicOrigin: env.STUDIO_PUBLIC_ORIGIN?.trim() || null,
  };
}

/**
 * Decides whether a request may be signed in as the configured Tailscale owner.
 * Used by auth.service; every check must hold, and the first failing one is reported for logging.
 */
export function evaluateTailscaleSessionRequest(
  request: TailscaleSessionRequest,
  config: TailscaleSignInConfig,
): TailscaleSessionDecision {
  const login = request.userLogin?.trim() || null;
  const deny = (reason: TailscaleDenialReason): TailscaleSessionDecision => ({ allowed: false, reason, login });

  if (config.allowedLogins.length === 0) {
    return deny('disabled');
  }
  // Serve never attaches identity to public Funnel traffic; refuse it even if a login is present.
  if (request.funnelRequest !== undefined) {
    return deny('funnel-request');
  }
  if (!isAddressIn(LOOPBACK_ADDRESSES, request.remoteAddress)) {
    return deny('socket-not-loopback');
  }
  // Exactly one tailnet address, as Serve writes it. A list means another proxy appended a hop,
  // and a missing value means the loopback caller is not Serve.
  const forwardedFor = request.forwardedFor?.trim();
  if (!forwardedFor || forwardedFor.includes(',') || !isAddressIn(TAILNET_ADDRESSES, forwardedFor)) {
    return deny('forwarded-for-not-tailnet');
  }
  const host = request.host?.trim();
  if (!isTailnetHost(host)) {
    return deny('host-not-tailnet');
  }
  if (!isSameOriginRequest(request, host, config.publicOrigin)) {
    return deny('cross-site');
  }
  if (!login) {
    return deny('identity-missing');
  }
  if (!config.allowedLogins.includes(login.toLowerCase())) {
    return deny('login-not-allowed');
  }
  return { allowed: true, login };
}

/**
 * Shortens a login for logs, e.g. "alice@example.com" -> "al***@example.com".
 * Used by auth.service so sign-in logs never contain a full login name.
 */
export function maskTailscaleLogin(login: string | null): string {
  if (!login) {
    return '(none)';
  }
  const separator = login.lastIndexOf('@');
  const localPart = separator >= 0 ? login.slice(0, separator) : login;
  const domain = separator >= 0 ? login.slice(separator, separator + 64) : '';
  const visible = localPart.slice(0, localPart.length > 2 ? 2 : 1);
  // Header values may carry arbitrary bytes; keep log lines printable.
  return `${visible}***${domain}`.replace(/[^\x20-\x7e]/g, '?');
}
