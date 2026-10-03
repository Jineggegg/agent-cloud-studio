import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import type { StudioIngressOrigins, StudioRequestClient } from '@/shared/types.js';
import { AppError, describePasskeyDevice } from '@/shared/utils.js';

import type { createAuthSecurityStore } from './auth-security.store.js';

type WebAuthn = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};

type PasskeyStore = ReturnType<typeof createAuthSecurityStore>['passkeys'];
type PasskeyRow = NonNullable<ReturnType<PasskeyStore['findById']>>;

type PasskeyCeremonyDependencies = {
  store: PasskeyStore;
  /** Both front doors (STUDIO_PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN); a passkey works only on them. */
  origins: () => StudioIngressOrigins;
  /** SimpleWebAuthn functions; injectable so tests never need a real authenticator. */
  webauthn?: WebAuthn;
  now?: () => number;
  /** Key that signs sign-in ceremony tokens; a random key per process by default. */
  ceremonyKey?: Buffer;
  /** Most used sign-in challenges remembered for replay protection; the oldest go first. */
  maxUsedChallenges?: number;
  /** Registration challenges waiting at once (signed-in users only); the oldest is dropped. */
  maxPendingRegistrations?: number;
};

/** A browser origin that may use sign-in passkeys, and the RP ID (its host name) they belong to. */
type TrustedOrigin = { origin: string; rpId: string };

type Pending = TrustedOrigin & { challenge: string; expiresAt: number };

/** What a sign-in ceremony token vouches for: challenge, door, origin and expiry. */
type SignInCeremony = { challenge: string; door: StudioRequestClient['door']; origin: string; expiresAt: number };

type SignInFailure =
  | 'malformed'
  | 'challenge-unknown'
  | 'credential-unknown'
  | 'user-mismatch'
  | 'verification-failed';

// Challenges are single-use and live one minute, like the WebAuthn prompt itself.
const CHALLENGE_TTL_MS = 60_000;
const DEFAULT_MAX_REGISTRATIONS = 16;
// The public tier admits at most ~10 sign-in attempts per second per door, so 60 s of them is far
// below this; a full set drops its oldest entries, whose challenges expire within the minute anyway.
const DEFAULT_MAX_USED_CHALLENGES = 10_000;
// "<payload>.<signature>", both base64url: what /api/auth/passkey must present.
const CEREMONY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_WEBAUTHN: WebAuthn = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}

// The WebAuthn user handle of a Studio account's sign-in passkeys. It differs from the Trading 212
// order passkeys' handle, so registering one never replaces the other on the same device.
function userHandleBytes(userId: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(`studio-signin-${userId}`, 'utf8'));
}

function userHandle(userId: number): string {
  return Buffer.from(userHandleBytes(userId)).toString('base64url');
}

function transportsOf(row: PasskeyRow) {
  try {
    const parsed: unknown = JSON.parse(row.transports);
    return Array.isArray(parsed) ? parsed.filter((item): item is NonNullable<RegistrationResponseJSON['response']['transports']>[number] => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function summary(row: PasskeyRow) {
  return { id: row.id, rpId: row.rp_id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

// The challenge the browser signed, read from clientDataJSON; null for anything malformed.
function signedChallenge(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const inner = (response as { response?: unknown }).response;
  const clientData = typeof inner === 'object' && inner !== null ? (inner as { clientDataJSON?: unknown }).clientDataJSON : undefined;
  if (typeof clientData !== 'string' || clientData.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientData, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function isAssertionShape(value: unknown): value is AuthenticationResponseJSON {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown };
  return typeof candidate.id === 'string' && candidate.id.length <= 1024
    && typeof candidate.rawId === 'string'
    && candidate.type === 'public-key'
    && typeof candidate.response === 'object' && candidate.response !== null;
}

function isRegistrationShape(value: unknown): value is RegistrationResponseJSON {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; type?: unknown; response?: unknown };
  return typeof candidate.id === 'string' && candidate.type === 'public-key'
    && typeof candidate.response === 'object' && candidate.response !== null;
}

/**
 * WebAuthn ceremonies for signing in to the Studio account with a passkey ("用面容 ID 登录").
 * - Sign-in uses discoverable credentials: the options name no credential, the device offers the
 *   passkeys it holds for the RP ID, and the assertion's credential id finds the account.
 * - Passkeys belong to one RP ID: the host of the front door they were created on
 *   (studio.ajarche.com or the ts.net host). Only the configured doors' exact origins are trusted.
 * - User verification (Face ID / Touch ID / device PIN) is required; challenges are single-use and
 *   expire after 60 seconds; the signature counter is stored after every successful sign-in.
 * - Sign-in ceremonies are stateless: the options come with a token, an HMAC (per-process key)
 *   over the challenge, door, origin and expiry, which the assertion must present on the same door
 *   and origin. Only challenges already presented are remembered, until they expire, so no flood
 *   of option requests can fill, evict or block anybody's sign-in.
 * Registering and removing need a signed-in session plus the password step-up, which the caller
 * (account-security.service) checks before calling in here.
 * Used by auth.module, which shares one instance between auth.service (sign-in) and
 * account-security.service (listing, registering, removing).
 */
export function createPasskeyCeremonies(dependencies: PasskeyCeremonyDependencies) {
  const webauthn = dependencies.webauthn ?? DEFAULT_WEBAUTHN;
  const now = dependencies.now ?? Date.now;
  const maxRegistrations = dependencies.maxPendingRegistrations ?? DEFAULT_MAX_REGISTRATIONS;
  const maxUsedChallenges = dependencies.maxUsedChallenges ?? DEFAULT_MAX_USED_CHALLENGES;
  const ceremonyKey = dependencies.ceremonyKey ?? randomBytes(32);
  const { store } = dependencies;
  // Registration challenges by `${userId}:${rpId}`. Sign-ins keep no state until they come back.
  const registrations = new Map<string, Pending>();
  // Sign-in challenges already presented, until they expire (single use); insertion-ordered.
  const usedChallenges = new Map<string, number>();
  const isoNow = () => new Date(now()).toISOString();

  function pruneExpired<T extends Pending>(map: Map<string, T>) {
    const at = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= at) map.delete(key);
    }
  }

  // Registrations need a signed-in session plus the password, so only the owner fills this map.
  function rememberRegistration(key: string, pending: Pending) {
    pruneExpired(registrations);
    // Map iteration is insertion order, so the first key is the oldest challenge.
    while (registrations.size >= maxRegistrations) {
      const oldest = registrations.keys().next().value;
      if (oldest === undefined) break;
      registrations.delete(oldest);
    }
    registrations.set(key, pending);
  }

  const sign = (payload: string) => createHmac('sha256', ceremonyKey).update(payload).digest('base64url');

  // The ceremony token: the signed facts of one sign-in. Nothing is stored when it is issued, so a
  // flood of option requests has nothing to fill or evict.
  function issueCeremony(ceremony: SignInCeremony): string {
    const payload = Buffer.from(JSON.stringify([ceremony.challenge, ceremony.door, ceremony.origin, ceremony.expiresAt])).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  // The ceremony a token vouches for, or null when it is malformed or its signature is wrong.
  function readCeremony(token: string): SignInCeremony | null {
    if (!CEREMONY_TOKEN_PATTERN.test(token)) return null;
    const [payload, signature] = token.split('.');
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const [challenge, door, origin, expiresAt] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[];
      if (typeof challenge !== 'string' || typeof origin !== 'string' || typeof expiresAt !== 'number'
        || (door !== 'cloudflare' && door !== 'tailnet' && door !== 'direct')) return null;
      return { challenge, door, origin, expiresAt };
    } catch {
      return null;
    }
  }

  // Marks a challenge used until it expires; false when it was used already (a replay).
  function useChallengeOnce(challenge: string, expiresAt: number): boolean {
    const at = now();
    for (const [key, expiry] of usedChallenges) {
      if (expiry > at) break;
      usedChallenges.delete(key);
    }
    if (usedChallenges.has(challenge)) return false;
    usedChallenges.set(challenge, expiresAt);
    while (usedChallenges.size > maxUsedChallenges) {
      const oldest = usedChallenges.keys().next().value;
      if (oldest === undefined) break;
      usedChallenges.delete(oldest);
    }
    return true;
  }

  // A pending challenge counts only before it expires and only for the origin it was issued to.
  function stillValid<T extends Pending>(pending: T | undefined, origin: TrustedOrigin): T | null {
    return pending && pending.expiresAt > now() && pending.origin === origin.origin && pending.rpId === origin.rpId
      ? pending
      : null;
  }

  // Takes a registration challenge out of its map (single use) when it is still valid.
  function consumeRegistration(key: string, origin: TrustedOrigin): Pending | null {
    const pending = registrations.get(key);
    registrations.delete(key);
    return stillValid(pending, origin);
  }

  /**
   * Matches the browser's Origin header against the configured doors; its host becomes the RP ID.
   * Refused (403) for any other origin, a malformed header, or a door whose host is an IP address
   * (WebAuthn needs a domain name).
   */
  function trustedOrigin(originHeader: string | undefined): TrustedOrigin {
    let url: URL | null = null;
    try {
      url = originHeader ? new URL(originHeader) : null;
    } catch {
      url = null;
    }
    if (!url || url.origin !== originHeader || !allowedOrigins().includes(url.origin)) {
      fail('这个网址不能使用通行密钥登录：请从 Studio 配置的网址打开', 403, 'AUTH_PASSKEY_ORIGIN');
    }
    return { origin: url.origin, rpId: url.hostname };
  }

  // The configured doors whose host is a domain name (WebAuthn cannot use an IP address).
  function allowedOrigins(): string[] {
    const doors = dependencies.origins();
    return [doors.public, doors.tailnet].filter((door): door is string => {
      if (door === null) return false;
      try {
        return !isIP(new URL(door).hostname.replace(/^\[|\]$/g, ''));
      } catch {
        return false;
      }
    });
  }

  return {
    trustedOrigin,

    /** Origins where sign-in passkeys work (shown in Settings so the page can tell whether it is one). */
    allowedOrigins,

    /**
     * Starts a sign-in on this door: options for navigator.credentials.get (no allowCredentials,
     * user verification required) plus the ceremony token the assertion must come back with, an
     * HMAC over the challenge, door, origin and expiry. Nothing is stored, so nothing can fill up.
     */
    async signInOptions(originHeader: string | undefined, client: StudioRequestClient) {
      const origin = trustedOrigin(originHeader);
      const options = await webauthn.generateAuthenticationOptions({
        rpID: origin.rpId,
        userVerification: 'required',
        timeout: CHALLENGE_TTL_MS,
      });
      const ceremonyId = issueCeremony({
        challenge: options.challenge,
        door: client.door,
        origin: origin.origin,
        expiresAt: now() + CHALLENGE_TTL_MS,
      });
      return { ceremonyId, options };
    },

    /**
     * Verifies a sign-in assertion against the ceremony token it presents. The token must be
     * genuine and unexpired and name this door and origin; the assertion must sign the token's
     * challenge; and the challenge is used up by the first attempt that gets that far (a short
     * replay set, kept until the challenge would have expired anyway). On success the passkey's counter and last-used time are stored
     * and its owner's id returned; a failure only carries a reason for the log, so every refusal
     * looks the same to the caller's client.
     */
    async verifySignIn(
      originHeader: string | undefined,
      input: { ceremonyId: unknown; response: unknown },
      client: StudioRequestClient,
    ): Promise<{ ok: true; userId: number; passkeyId: string; rpId: string } | { ok: false; reason: SignInFailure }> {
      const origin = trustedOrigin(originHeader);
      const { response } = input;
      const challenge = signedChallenge(response);
      if (typeof input.ceremonyId !== 'string' || !challenge || !isAssertionShape(response)) {
        return { ok: false, reason: 'malformed' };
      }
      const ceremony = readCeremony(input.ceremonyId);
      if (!ceremony || ceremony.door !== client.door || ceremony.origin !== origin.origin
        || ceremony.expiresAt <= now() || ceremony.challenge !== challenge
        || !useChallengeOnce(ceremony.challenge, ceremony.expiresAt)) {
        return { ok: false, reason: 'challenge-unknown' };
      }
      const pending = ceremony;
      const row = store.findByCredentialId(response.id);
      if (!row || row.rp_id !== origin.rpId) return { ok: false, reason: 'credential-unknown' };
      const handle = response.response.userHandle;
      if (handle !== undefined && handle !== userHandle(row.user_id)) return { ok: false, reason: 'user-mismatch' };

      let verified: Awaited<ReturnType<WebAuthn['verifyAuthenticationResponse']>> | null = null;
      try {
        verified = await webauthn.verifyAuthenticationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: origin.origin,
          expectedRPID: origin.rpId,
          credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transportsOf(row) },
          requireUserVerification: true,
        });
      } catch {
        // Includes a signature counter that went backwards (a cloned authenticator).
        verified = null;
      }
      if (!verified?.verified || !verified.authenticationInfo.userVerified) return { ok: false, reason: 'verification-failed' };
      store.recordUse(row.id, verified.authenticationInfo.newCounter, isoNow());
      return { ok: true, userId: row.user_id, passkeyId: row.id, rpId: row.rp_id };
    },

    /** Options for navigator.credentials.create; the caller has already checked the password. */
    async registrationOptions(user: { id: number; username: string }, originHeader: string | undefined) {
      const origin = trustedOrigin(originHeader);
      const options = await webauthn.generateRegistrationOptions({
        rpName: 'Agent Cloud Studio',
        rpID: origin.rpId,
        userName: user.username,
        userDisplayName: 'Studio 登录',
        userID: userHandleBytes(user.id),
        attestationType: 'none',
        timeout: CHALLENGE_TTL_MS,
        excludeCredentials: store.listForUser(user.id)
          .filter((row) => row.rp_id === origin.rpId)
          .map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
        // Discoverable, so the sign-in screen needs no username; verified, so it stands in for the password.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      rememberRegistration(`${user.id}:${origin.rpId}`, { ...origin, challenge: options.challenge, expiresAt: now() + CHALLENGE_TTL_MS });
      return options;
    },

    /** Stores the new passkey after verifying the registration against its pending challenge. */
    async register(user: { id: number }, originHeader: string | undefined, response: unknown, userAgent: string | undefined) {
      const origin = trustedOrigin(originHeader);
      const pending = consumeRegistration(`${user.id}:${origin.rpId}`, origin);
      if (!pending) fail('通行密钥注册已过期，请重新开始', 400, 'AUTH_PASSKEY_EXPIRED');
      if (!isRegistrationShape(response)) fail('通行密钥注册数据无效', 400, 'AUTH_PASSKEY_INVALID');
      let verified: Awaited<ReturnType<WebAuthn['verifyRegistrationResponse']>> | null = null;
      try {
        verified = await webauthn.verifyRegistrationResponse({
          response,
          expectedChallenge: pending.challenge,
          expectedOrigin: origin.origin,
          expectedRPID: origin.rpId,
          requireUserVerification: true,
        });
      } catch {
        verified = null;
      }
      if (!verified?.verified) fail('通行密钥注册失败：设备没有通过验证', 400, 'AUTH_PASSKEY_INVALID');
      const { credential } = verified.registrationInfo;
      if (store.findByCredentialId(credential.id)) fail('这把通行密钥已经登记过了', 409, 'AUTH_PASSKEY_DUPLICATE');
      const row: PasskeyRow = {
        id: randomUUID(),
        user_id: user.id,
        rp_id: origin.rpId,
        credential_id: credential.id,
        public_key: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: JSON.stringify(credential.transports ?? []),
        label: describePasskeyDevice(userAgent),
        created_at: isoNow(),
        last_used_at: null,
      };
      store.insert(row);
      return summary(row);
    },

    /** The user's sign-in passkeys, every domain, without key material. */
    list(userId: number) {
      return store.listForUser(userId).map(summary);
    },

    /** Deletes one of the user's passkeys; null when it does not exist (or belongs to someone else). */
    remove(userId: number, id: string) {
      const row = store.findById(userId, id);
      if (!row) return null;
      store.remove(userId, id);
      return summary(row);
    },
  };
}
