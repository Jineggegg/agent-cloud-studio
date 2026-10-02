import http from 'node:http';

import { AppError } from '@/shared/utils.js';
import type {
  StudioT212BrokerErrorBody,
  StudioT212BrokerOrderResult,
  StudioT212BrokerPasskey,
  StudioT212BrokerPreview,
  StudioT212BrokerStatus,
} from '@/shared/types.js';

type Json = Record<string, unknown>;
type Dependencies = {
  // STUDIO_T212_BROKER_SOCKET, normally /run/studio-trader/broker.sock.
  socketPath: string;
  timeoutMs?: number;
  // Confirming waits for Trading 212 (up to 15 s inside the broker) and must outlast it.
  confirmTimeoutMs?: number;
};
type CallOptions = { timeoutMs: number; placesOrder?: boolean };

const MAX_RESPONSE_BYTES = 256 * 1024;
// Errors that mean the request never reached the broker, so nothing can have been placed.
const NOT_CONNECTED = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTDIR']);

function unreachable(code: string | undefined) {
  const hint = code === 'EACCES' || code === 'EPERM'
    ? 'Studio 的系统用户无权连接交易代理：确认它在 studio-broker 组里，并在加入后重启 WSL'
    : '交易代理没有运行：在服务器上检查 systemctl status studio-trader-broker';
  return new AppError(hint, { statusCode: 503, code: 'T212_BROKER_UNREACHABLE' });
}

/**
 * Used by the Studio orders service: the only path from Studio to Trading 212 orders. It speaks HTTP over the
 * order broker's unix socket and relays the broker's own refusals ({ error, code }) unchanged. A confirmation
 * whose connection breaks after it was sent is reported as T212_ORDER_UNKNOWN, because the broker may already
 * have placed the order; the client never retries.
 */
export function createTrading212BrokerClient(deps: Dependencies) {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 40_000;

  function call<T>(method: 'GET' | 'POST', path: string, body: Json | undefined, options: CallOptions) {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({
        socketPath: deps.socketPath, path, method,
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { request.destroy(Object.assign(new Error('response too large'), { code: 'ETOOBIG' })); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode ?? 502;
          if (status >= 200 && status < 300) { resolve(parsed as T); return; }
          const failure = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<StudioT212BrokerErrorBody>;
          const message = typeof failure.error === 'string' && failure.error ? failure.error.slice(0, 300) : `交易代理返回 ${status}`;
          const code = typeof failure.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : 'T212_BROKER_ERROR';
          reject(new AppError(message, { statusCode: status >= 400 && status < 600 ? status : 502, code }));
        });
        response.on('error', () => {});
      });
      request.setTimeout(options.timeoutMs, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (NOT_CONNECTED.has(error.code ?? '')) { reject(unreachable(error.code)); return; }
        if (options.placesOrder) {
          reject(new AppError('与交易代理的连接中断，订单状态未知：请先在 Trading 212 核对，不要直接重新下单', { statusCode: 502, code: 'T212_ORDER_UNKNOWN' }));
          return;
        }
        reject(new AppError('交易代理没有响应，请稍后再试', { statusCode: 503, code: 'T212_BROKER_UNREACHABLE' }));
      });
      request.end(payload);
    });
  }

  return {
    status: () => call<StudioT212BrokerStatus>('GET', '/v1/status', undefined, { timeoutMs: 5_000 }),
    preview: (body: { origin: string; order: Json; acknowledgeUnknown: boolean }) =>
      call<StudioT212BrokerPreview>('POST', '/v1/orders/preview', body, { timeoutMs }),
    confirm: (body: { origin: string; id: string } & ({ assertion: Json } | { confirmed: true })) =>
      call<StudioT212BrokerOrderResult>('POST', '/v1/orders/confirm', body, { timeoutMs: confirmTimeoutMs, placesOrder: true }),
    registrationOptions: (body: { origin: string; enrollmentCode: string }) =>
      call<Json>('POST', '/v1/passkeys/registration-options', body, { timeoutMs }),
    register: (body: { origin: string; response: Json; label: string | null }) =>
      call<StudioT212BrokerPasskey>('POST', '/v1/passkeys/register', body, { timeoutMs }),
    removalOptions: (body: { origin: string; id: string }) =>
      call<Json>('POST', '/v1/passkeys/removal-options', body, { timeoutMs }),
    removePasskey: (body: { origin: string; id: string } & ({ assertion: Json } | { enrollmentCode: string })) =>
      call<{ removed: true }>('POST', '/v1/passkeys/remove', body, { timeoutMs }),
  };
}
