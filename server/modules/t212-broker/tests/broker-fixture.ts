// Shared fakes for the broker tests: an in-memory database, a fake Trading 212 API and a fake WebAuthn library that
// enforces the same bindings the real one checks (challenge, origin, RP ID, user verification, signature).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { StudioT212OrderInput } from '@/shared/types.js';

import { parseBrokerConfig } from '../broker.config.js';
import { createBrokerRepository } from '../broker.repository.js';
import { createBrokerService } from '../broker.service.js';
import { createBrokerTrading212Client } from '../broker-trading212.client.js';

type WebAuthn = NonNullable<Parameters<typeof createBrokerService>[0]['webauthn']>;
type Call = { url: string; method: string; body?: string; authorization?: string };

export const STUDIO = 'https://studio.ajarche.com';
export const TAILNET = 'https://desktop.tail1234.ts.net';
export const START = Date.parse('2026-10-02T10:00:00Z');
export const SUMMARY = {
  id: 1, currency: 'GBP', totalValue: 1620,
  cash: { availableToTrade: 1000, reservedForOrders: 0, inPies: 0 },
  investments: { currentValue: 620, totalCost: 560, realizedProfitLoss: 0, unrealizedProfitLoss: 60 },
};
// AAPL: 2 shares worth £320 at $200 each, so one share is £160 and the FX rate is 0.8.
export const POSITIONS = [
  { instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: 200, walletImpact: { currentValue: 320 } },
  { instrument: { ticker: 'MSFT_US_EQ', name: 'Microsoft', currency: 'USD' }, quantity: 1, currentPrice: 400, walletImpact: { currentValue: 300 } },
];
// Quote currencies from /equity/metadata/instruments; VODl_EQ is quoted in pence.
const INSTRUMENTS = [
  { ticker: 'AAPL_US_EQ', currencyCode: 'USD' }, { ticker: 'MSFT_US_EQ', currencyCode: 'USD' }, { ticker: 'TSLA_US_EQ', currencyCode: 'USD' },
  { ticker: 'VODl_EQ', currencyCode: 'GBX' }, { ticker: 'SAP_DE_EQ', currencyCode: 'EUR' },
];
export const ORDER = { id: 9001, status: 'NEW', ticker: 'AAPL_US_EQ', side: 'BUY', type: 'MARKET', quantity: 1, filledQuantity: 0, createdAt: '2026-10-02T10:00:00Z' };

function clientData(type: string, challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin })).toString('base64url');
}
function decode(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { challenge: string; origin: string };
}

/** A registration response as a browser would send it; `rpId` stands in for the signed RP ID hash. The
 * aaguid / deviceType / backedUp fields stand in for what the authenticator attests and the broker records. */
export function attestation(options: { challenge: string; origin: string; rpId?: string; id?: string; aaguid?: string; deviceType?: 'singleDevice' | 'multiDevice'; backedUp?: boolean }) {
  const id = options.id ?? 'cred-1';
  return {
    id, rawId: id, type: 'public-key',
    response: {
      clientDataJSON: clientData('webauthn.create', options.challenge, options.origin), attestationObject: 'fake', rpId: options.rpId ?? new URL(options.origin).hostname,
      aaguid: options.aaguid ?? '00000000-0000-0000-0000-000000000000', deviceType: options.deviceType ?? 'singleDevice', backedUp: options.backedUp ?? false,
    },
    clientExtensionResults: {},
  } as any;
}

/** An assertion; `rpId` and `counter` stand in for the signed authenticator data, `signature` for the signature. */
export function assertion(options: { challenge: string; origin: string; rpId?: string; id?: string; signature?: string; counter?: number }) {
  const id = options.id ?? 'cred-1';
  return {
    id, rawId: id, type: 'public-key',
    response: {
      clientDataJSON: clientData('webauthn.get', options.challenge, options.origin), authenticatorData: 'fake',
      signature: options.signature ?? 'good-signature', rpId: options.rpId ?? new URL(options.origin).hostname, counter: options.counter ?? 0,
    },
    clientExtensionResults: {},
  } as any;
}

function fakeWebAuthn() {
  const calls = { registration: [] as any[], verifyRegistration: [] as any[], authentication: [] as any[], verifyAuthentication: [] as any[] };
  let counter = 0;
  const webauthn = {
    async generateRegistrationOptions(options: any) {
      calls.registration.push(options);
      return { challenge: `reg-${++counter}`, rp: { id: options.rpID, name: options.rpName }, authenticatorSelection: options.authenticatorSelection };
    },
    async verifyRegistrationResponse(options: any) {
      calls.verifyRegistration.push(options);
      const envelope = options.response.response;
      const data = decode(envelope.clientDataJSON);
      if (data.challenge !== options.expectedChallenge || data.origin !== options.expectedOrigin || envelope.rpId !== options.expectedRPID
        || options.requireUserVerification !== true) throw new Error('registration mismatch');
      return {
        verified: true,
        registrationInfo: {
          credential: { id: options.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
          aaguid: envelope.aaguid ?? '00000000-0000-0000-0000-000000000000',
          credentialDeviceType: envelope.deviceType ?? 'singleDevice', credentialBackedUp: envelope.backedUp ?? false,
        },
      };
    },
    async generateAuthenticationOptions(options: any) {
      calls.authentication.push(options);
      return { challenge: `auth-${++counter}`, rpId: options.rpID, allowCredentials: options.allowCredentials, userVerification: options.userVerification, timeout: options.timeout };
    },
    async verifyAuthenticationResponse(options: any) {
      calls.verifyAuthentication.push(options);
      const response = options.response.response;
      const data = decode(response.clientDataJSON);
      if (response.signature !== 'good-signature' || data.challenge !== options.expectedChallenge || data.origin !== options.expectedOrigin
        || response.rpId !== options.expectedRPID || options.requireUserVerification !== true) throw new Error('assertion mismatch');
      return { verified: true, authenticationInfo: { credentialID: options.credential.id, newCounter: response.counter, userVerified: true } };
    },
  } as unknown as WebAuthn;
  return { webauthn, calls };
}

// A healthy machine by default; a test can pass its own to exercise the "isolation invalid" path.
const HEALTHY_ISOLATION = { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [] as string[], notes: [] as string[] };

export type FixtureOptions = {
  config?: Record<string, unknown>; summary?: Record<string, unknown>; positions?: unknown[]; keys?: boolean;
  isolation?: typeof HEALTHY_ISOLATION;
};

/** Builds a broker service over fakes; `close` removes its temporary state directory. */
export function fixture(options: FixtureOptions = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-broker-test-'));
  if (options.keys !== false) {
    writeFileSync(path.join(directory, 'live.env'), 'TRADING212_API_KEY=fake-live-key\nTRADING212_API_SECRET=fake-live-secret\n');
    writeFileSync(path.join(directory, 'demo.env'), 'TRADING212_API_KEY=fake-demo-key\nTRADING212_API_SECRET=fake-demo-secret\n');
  }
  // The daily cap and live cooldown are on by default; tests that do not exercise them switch them off.
  const config = parseBrokerConfig(JSON.stringify({
    allowedEnvs: ['live', 'demo'], origins: [STUDIO, TAILNET], maxDailyOrderValue: 0, liveOrderCooldownSeconds: 0, ...options.config,
  }), directory);
  const database = new Database(':memory:');
  const repository = createBrokerRepository(database);
  const calls: Call[] = [];
  let clock = START;
  let respondToOrder: (url: string) => Response = () => Response.json(ORDER);
  const trading212 = createBrokerTrading212Client({
    keyFiles: config.keyFiles, now: () => clock,
    request: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url: String(url), method: String(init.method), body: init.body as string | undefined, authorization: headers.Authorization });
      if (init.method === 'POST') return respondToOrder(String(url));
      if (String(url).endsWith('/equity/account/summary')) return Response.json(options.summary ?? SUMMARY);
      if (String(url).endsWith('/equity/positions')) return Response.json(options.positions ?? POSITIONS);
      if (String(url).endsWith('/equity/metadata/instruments')) return Response.json(INSTRUMENTS);
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  const { webauthn, calls: webauthnCalls } = fakeWebAuthn();
  const logs: string[] = [];
  const service = createBrokerService({
    config, repository, trading212, webauthn, now: () => clock, log: line => logs.push(line),
    isolation: () => options.isolation ?? HEALTHY_ISOLATION,
  });
  return {
    service, database, calls, webauthnCalls, logs, directory,
    posts: () => calls.filter(call => call.method === 'POST'),
    advance: (ms: number) => { clock += ms; },
    onOrder: (respond: (url: string) => Response) => { respondToOrder = respond; },
    audit: () => database.prepare('SELECT * FROM order_audit ORDER BY row_id').all() as Record<string, unknown>[],
    close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
export type Fixture = ReturnType<typeof fixture>;

export const order = (input: Partial<StudioT212OrderInput> = {}): StudioT212OrderInput => ({
  env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, timeValidity: 'DAY', ...input,
});

/** Enrols a passkey the way the browser flow does: enrollment code → registration options → attestation. */
export async function enroll(f: Fixture, origin = STUDIO, id = 'cred-1') {
  const { code } = f.service.createEnrollmentCode();
  const options = await f.service.registrationOptions({ origin, enrollmentCode: code });
  return f.service.register({ origin, response: attestation({ challenge: options.challenge, origin, id }), label: 'iPad' });
}

/** Previews an order and signs its challenge with the given passkey, as Face ID in the browser would. */
export async function signedOrder(f: Fixture, input: Partial<StudioT212OrderInput> = {}, origin = STUDIO, extra: { counter?: number; id?: string } = {}) {
  const preview = await f.service.preview({ origin, order: order(input), acknowledgeUnknown: false });
  const challenge = String(preview.authentication?.challenge);
  return { preview, assertion: assertion({ challenge, origin, ...extra }) };
}

export const coded = (code: string, pattern?: RegExp) => (error: Error & { code?: string }) => error.code === code && (!pattern || pattern.test(error.message));
