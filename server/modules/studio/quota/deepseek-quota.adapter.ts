import { readObjectRecord } from '@/shared/utils.js';
import type { StudioQuotaSnapshot } from '@/shared/types.js';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const TIMEOUT_MS = 8_000;

type Balance = StudioQuotaSnapshot['balances'][number];

function unavailable(note: string): StudioQuotaSnapshot {
  return { provider: 'deepseek', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note };
}

// DeepSeek sends amounts as decimal strings ("110.00"); numbers are accepted too.
function amount(value: unknown) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function balance(value: unknown): Balance | null {
  const record = readObjectRecord(value);
  const total = amount(record?.total_balance);
  if (!record || typeof record.currency !== 'string' || !record.currency || total === null) return null;
  return { currency: record.currency, total, granted: amount(record.granted_balance) ?? 0, toppedUp: amount(record.topped_up_balance) ?? 0 };
}

/**
 * Used by the Studio quota service to show a user's DeepSeek account balance on the home screen.
 *
 * Calls the read-only `GET /user/balance` with the user's saved key; DeepSeek has no usage
 * windows, so only `balances` is filled. `apiKey` null means no key is saved. The key is only
 * sent to api.deepseek.com and never appears in the result. Never throws.
 */
export async function readDeepSeekQuota(input: { apiKey: string | null; request: typeof fetch; now: number }): Promise<StudioQuotaSnapshot> {
  if (!input.apiKey) return unavailable('请先在连接中设置 DeepSeek API 密钥');
  try {
    const response = await input.request(BALANCE_URL, {
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unavailable(response.status === 401 ? 'DeepSeek 密钥无效或已失效' : `DeepSeek 余额查询失败（${response.status}）`);
    }
    const payload = readObjectRecord(await response.json());
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : null;
    if (!payload || !infos) return unavailable('DeepSeek 没有返回余额信息');
    const balances = infos.map(balance).filter((item): item is Balance => item !== null);
    return {
      provider: 'deepseek', available: true, windows: [], balances, source: 'official',
      observedAt: new Date(input.now).toISOString(), stale: false,
      ...(payload.is_available === false ? { note: 'DeepSeek 余额不足，暂时无法调用' } : {}),
    };
  } catch {
    return unavailable('无法连接 DeepSeek 查询余额');
  }
}
