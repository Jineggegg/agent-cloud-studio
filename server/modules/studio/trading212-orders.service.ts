import { AppError } from '@/shared/utils.js';
import type { StudioT212Environment } from '@/shared/types.js';

import type { createTrading212BrokerClient } from './trading212-broker.client.js';
import type { createTrading212Service } from './trading212.service.js';

type Json = Record<string, unknown>;
type Broker = ReturnType<typeof createTrading212BrokerClient>;
type Dependencies = {
  // Null when STUDIO_T212_BROKER_SOCKET is unset: ordering is then off and nothing in Studio can place an order.
  broker: Broker | null;
  trading212: Pick<ReturnType<typeof createTrading212Service>, 'lastCurrency' | 'invalidate'>;
};
type OrderProof = { assertion: Json } | { confirmed: true };
type RemovalProof = { assertion: Json } | { enrollmentCode: string };

const OFF_MESSAGE = 'Studio 没有连接交易代理（STUDIO_T212_BROKER_SOCKET 未设置），下单已关闭。安装方法见 docs/t212-broker.md';
const ENVIRONMENTS: StudioT212Environment[] = ['live', 'demo'];

// A rough device name so two passkeys on the same domain can be told apart; iPadOS Safari reports itself as a Mac.
function deviceLabel(userAgent: string | undefined) {
  const agent = userAgent ?? '';
  if (/iPad/.test(agent)) return 'iPad';
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/Android/.test(agent)) return 'Android';
  if (/Windows/.test(agent)) return 'Windows';
  if (/Macintosh/.test(agent)) return 'Mac / iPad';
  return null;
}

/**
 * Used by studio.module (through trading212-orders.routes) for Trading 212 orders and passkeys. Studio holds no
 * order-capable key: every order, passkey enrollment and removal is decided by the separate order broker
 * (docs/t212-broker.md), which trusts nothing Studio sends and needs a passkey assertion for every order.
 * This service relays requests to the broker, shapes the Settings view of its status, and refreshes Studio's
 * cached account reads after an order.
 */
export function createTrading212OrdersService(deps: Dependencies) {
  function broker() {
    if (!deps.broker) throw new AppError(OFF_MESSAGE, { statusCode: 503, code: 'T212_BROKER_OFF' });
    return deps.broker;
  }
  const closed = {
    allowedEnvs: [] as StudioT212Environment[], maxOrderValue: 0, maxOrdersPerHour: 0, maxDailyOrderValue: 0, liveOrderCooldownSeconds: 0,
    passkeys: [], trustedOrigins: [] as string[], demoConfirm: false, isolation: null,
  };

  return {
    // Broker reachability and settings for the order sheet and Settings; never throws, so read-only views still load.
    async config() {
      if (!deps.broker) return { broker: { status: 'off' as const, message: OFF_MESSAGE }, ...closed };
      try {
        const status = await deps.broker.status();
        const currency = [...status.allowedEnvs, ...ENVIRONMENTS].map(env => status.currencies[env] ?? deps.trading212.lastCurrency(env)).find(Boolean);
        return {
          broker: { status: 'ok' as const, keys: status.keys },
          allowedEnvs: status.allowedEnvs, maxOrderValue: status.maxOrderValue, maxOrdersPerHour: status.maxOrdersPerHour,
          maxDailyOrderValue: status.maxDailyOrderValue, liveOrderCooldownSeconds: status.liveOrderCooldownSeconds,
          ...(currency ? { currency } : {}),
          passkeys: status.passkeys, trustedOrigins: status.origins, demoConfirm: status.demoConfirm, isolation: status.isolation,
        };
      } catch (error) {
        return { broker: { status: 'unreachable' as const, message: error instanceof Error ? error.message : '交易代理不可用' }, ...closed };
      }
    },
    async preview(origin: string, order: Json, acknowledgeUnknown: boolean) {
      return broker().preview({ origin, order, acknowledgeUnknown });
    },
    async confirm(origin: string, id: string, proof: OrderProof) {
      try {
        const result = await broker().confirm({ origin, id, ...proof });
        deps.trading212.invalidate(result.env);
        return result;
      } catch (error) {
        // Placed or not, balances may have moved; the next read must not come from a cache.
        if (error instanceof AppError && error.code === 'T212_ORDER_UNKNOWN') for (const env of ENVIRONMENTS) deps.trading212.invalidate(env);
        throw error;
      }
    },
    async passkeyOptions(origin: string, enrollmentCode: string) {
      return broker().registrationOptions({ origin, enrollmentCode });
    },
    async registerPasskey(origin: string, response: Json, userAgent: string | undefined) {
      return broker().register({ origin, response, label: deviceLabel(userAgent) });
    },
    async removalOptions(origin: string, id: string) {
      return broker().removalOptions({ origin, id });
    },
    async removePasskey(origin: string, id: string, proof: RemovalProof) {
      return broker().removePasskey({ origin, id, ...proof });
    },
  };
}
