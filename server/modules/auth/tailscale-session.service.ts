import { BlockList, isIP } from 'node:net';

/**
 * Passwordless sign-in policy for requests that arrive through Tailscale Serve.
 *
 * What Serve guarantees (see the Tailscale Serve docs, https://tailscale.com/kb/1312/serve, and
 * ipn/ipnlocal/serve.go in tailscale/tailscale):
 * - Serve proxies to a backend on this machine, so its requests reach Studio over loopback.
 * - Serve deletes client-supplied Tailscale-User-Login/-Name/-Profile-Pic/Tailscale-Funnel-Request
 *   headers, then sets them from WhoIs for the tailnet peer; tagged devices and Funnel (public)
 *   requests never carry identity headers, and Funnel requests are marked Tailscale-Funnel-Request.
 * - Serve's Go reverse proxy drops incoming X-Forwarded-* headers and then sets X-Forwarded-For to
 *   exactly one address: the peer it accepted the connection from (a tailnet address for tailnet
 *   traffic, the public client address for Funnel).
 *
 * What that proves, and what it does not (the real trust boundary):
 * - Tailscale-User-Login names a Tailscale *user*, not a device or a program. Every untagged device
 *   signed in as an allowlisted login carries it, for every program on that device: an iOS app,
 *   a script or curl can call the Serve URL just like Safari can.
 * - Origin and Sec-Fetch-Site are ordinary headers that any non-browser client sets at will. The
 *   same-origin check only stops *browser pages* other than Studio from riding the ambient
 *   identity (cross-site requests, DNS rebinding of the loopback port). It is not authentication.
 * - STUDIO_TAILSCALE_NODES narrows the boundary to the listed devices, using the single peer
 *   address Serve writes into X-Forwarded-For; every program on a listed device is still trusted.
 * - Any process on this machine can reach the loopback port and forge every header checked here.
 * - Issued sessions carry a claim that auth.middleware re-checks on every request, so disabling the
 *   feature or removing a login or device from the allowlist revokes sessions already issued.
 */

type TailscaleSignInConfig = {
  /** Lower-cased Tailscale login names allowed to sign in; an empty list disables the feature. */
  allowedLogins: string[];
  /**
   * Tailnet addresses (STUDIO_TAILSCALE_NODES) of the only devices allowed to sign in, as written
   * by the operator; an empty list allows every device of an allowed login.
   */
  allowedNodes: string[];
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

/** What a session token issued by Tailscale sign-in records, so later requests can re-check it. */
type TailscaleSessionClaim = {
  /** Lower-cased allowlisted login the session was issued for. */
  login: string;
  /** Canonical tailnet address of the device that signed in (Serve's X-Forwarded-For). */
  node: string;
};

type TailscaleDenialReason =
  | 'disabled'
  | 'public-origin-invalid'
  | 'nodes-invalid'
  | 'funnel-request'
  | 'socket-not-loopback'
  | 'forwarded-for-not-tailnet'
  | 'node-not-allowed'
  | 'host-not-tailnet'
  | 'cross-site'
  | 'identity-missing'
  | 'login-not-allowed';

type TailscaleSessionDecision =
  | { allowed: true; login: string; session: TailscaleSessionClaim }
  | { allowed: false; reason: TailscaleDenialReason; login: string | null; node: string | null };

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

// Returns the address in one canonical spelling when it is a single IP inside `list`, else null.
// The spelling lets operator-written STUDIO_TAILSCALE_NODES entries (any case, expanded or
// compressed IPv6) compare equal to the address Serve writes.
function canonicalAddressIn(list: BlockList, value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  // Dual-stack sockets report IPv4 peers as IPv4-mapped IPv6 addresses (::ffff:127.0.0.1).
  const trimmed = value.trim();
  const address = IPV4_MAPPED_PREFIX.exec(trimmed)?.[1] ?? trimmed;
  const version = isIP(address);
  // Zone-scoped addresses (fe80::1%eth0) are never loopback or tailnet peers.
  if (version === 0 || address.includes('%')) {
    return null;
  }
  try {
    // The WHATWG URL serializer prints IPv6 lower-cased and RFC 5952-compressed.
    const canonical = version === 4 ? address : new URL(`http://[${address}]`).hostname.slice(1, -1);
    return list.check(canonical, version === 4 ? 'ipv4' : 'ipv6') ? canonical : null;
  } catch {
    return null;
  }
}

// Canonical STUDIO_TAILSCALE_NODES entries, or null when any entry is not a tailnet address.
// A typo must not silently empty the list, because an empty list means "every device".
function canonicalAllowedNodes(config: TailscaleSignInConfig): string[] | null {
  const nodes = config.allowedNodes.map((node) => canonicalAddressIn(TAILNET_ADDRESSES, node));
  return nodes.every((node): node is string => node !== null) ? nodes : null;
}

// STUDIO_PUBLIC_ORIGIN must be a bare https origin; anything else is a configuration error that
// refuses sign-in instead of silently skipping the pin. Returns the serialized origin, else null.
function pinnedPublicOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const isBareHttpsOrigin = url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash;
    return isBareHttpsOrigin ? url.origin : null;
  } catch {
    return null;
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

// A browser on https://<host> sends exactly that origin. Serve terminates TLS for *.ts.net, so
// Studio's page is always https, and an http Origin (another Serve app on port 80) is cross-origin.
// Host and port compare the way the browser does, so ":443" equals no port.
function isSameOriginRequest(request: TailscaleSessionRequest, host: string, pinnedOrigin: string | null): boolean {
  if (!request.origin || (request.fetchSite && request.fetchSite !== 'same-origin')) {
    return false;
  }
  try {
    const origin = new URL(request.origin);
    if (origin.protocol !== 'https:' || (pinnedOrigin && origin.origin !== pinnedOrigin)) {
      return false;
    }
    return new URL(`https://${host}`).host === origin.host;
  } catch {
    return false;
  }
}

/**
 * Reads the sign-in configuration from environment variables.
 * Used by auth.module (composition root) and auth.middleware on every request. They pass
 * process.env, which server/load-env.ts fills from .env once at startup, so .env edits apply
 * after a restart.
 */
export function parseTailscaleSignInConfig(env: Record<string, string | undefined>): TailscaleSignInConfig {
  const list = (value: string | undefined) => (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    allowedLogins: list(env.STUDIO_TAILSCALE_LOGINS).map((login) => login.toLowerCase()),
    allowedNodes: list(env.STUDIO_TAILSCALE_NODES),
    mappedUsername: env.STUDIO_TAILSCALE_USER?.trim() || null,
    publicOrigin: env.STUDIO_PUBLIC_ORIGIN?.trim() || null,
  };
}

/**
 * Decides whether a request may be signed in as the configured Tailscale owner.
 * Used by auth.service; every check must hold, and the first failing one is reported for logging.
 * An allowed decision carries the claim the issued session token must record.
 */
export function evaluateTailscaleSessionRequest(
  request: TailscaleSessionRequest,
  config: TailscaleSignInConfig,
): TailscaleSessionDecision {
  const login = request.userLogin?.trim() || null;
  let node: string | null = null;
  const deny = (reason: TailscaleDenialReason): TailscaleSessionDecision => ({
    allowed: false,
    reason,
    login,
    node,
  });

  if (config.allowedLogins.length === 0) {
    return deny('disabled');
  }
  // Configuration errors fail closed, before any request data is considered.
  const pinnedOrigin = config.publicOrigin === null ? null : pinnedPublicOrigin(config.publicOrigin);
  if (config.publicOrigin !== null && pinnedOrigin === null) {
    return deny('public-origin-invalid');
  }
  const allowedNodes = canonicalAllowedNodes(config);
  if (allowedNodes === null) {
    return deny('nodes-invalid');
  }
  // Serve never attaches identity to public Funnel traffic; refuse it even if a login is present.
  if (request.funnelRequest !== undefined) {
    return deny('funnel-request');
  }
  if (canonicalAddressIn(LOOPBACK_ADDRESSES, request.remoteAddress) === null) {
    return deny('socket-not-loopback');
  }
  // Exactly one tailnet address, as Serve writes it. A list means another proxy appended a hop,
  // and a missing value means the loopback caller is not Serve.
  const forwardedFor = request.forwardedFor?.trim();
  node = forwardedFor && !forwardedFor.includes(',')
    ? canonicalAddressIn(TAILNET_ADDRESSES, forwardedFor)
    : null;
  if (node === null) {
    return deny('forwarded-for-not-tailnet');
  }
  if (allowedNodes.length > 0 && !allowedNodes.includes(node)) {
    return deny('node-not-allowed');
  }
  const host = request.host?.trim();
  if (!isTailnetHost(host)) {
    return deny('host-not-tailnet');
  }
  if (!isSameOriginRequest(request, host, pinnedOrigin)) {
    return deny('cross-site');
  }
  if (!login) {
    return deny('identity-missing');
  }
  const normalizedLogin = login.toLowerCase();
  if (!config.allowedLogins.includes(normalizedLogin)) {
    return deny('login-not-allowed');
  }
  return { allowed: true, login, session: { login: normalizedLogin, node } };
}

/**
 * Tells whether the `tailscale` claim of a verified session token no longer matches the current
 * settings. Used by auth.middleware for every token-authenticated HTTP request and WebSocket, so
 * clearing STUDIO_TAILSCALE_LOGINS, removing a login, or leaving the token's device out of
 * STUDIO_TAILSCALE_NODES revokes sessions already issued. A token without the claim (a password
 * session) is never revoked here; a malformed claim, or invalid node settings, count as revoked.
 */
export function isTailscaleSessionRevoked(claim: unknown, config: TailscaleSignInConfig): boolean {
  if (claim === undefined) {
    return false;
  }
  if (
    typeof claim !== 'object'
    || claim === null
    || !('login' in claim)
    || !('node' in claim)
    || typeof claim.login !== 'string'
    || typeof claim.node !== 'string'
  ) {
    return true;
  }
  if (!config.allowedLogins.includes(claim.login.toLowerCase())) {
    return true;
  }
  const allowedNodes = canonicalAllowedNodes(config);
  return allowedNodes === null
    || (allowedNodes.length > 0 && !allowedNodes.includes(claim.node));
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
