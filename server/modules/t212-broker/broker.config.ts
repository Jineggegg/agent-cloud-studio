import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { StudioT212Environment } from '@/shared/types.js';

import { BrokerError } from './broker-error.js';

type Environment = StudioT212Environment;

// Defaults for a field that config.json leaves out. scripts/wsl/install-t212-broker.sh writes the same values into a
// new config.json, and docs/t212-broker.md lists them. allowedEnvs and origins default to empty: trading stays off.
const DEFAULT_MAX_ORDER_VALUE = 500;
const DEFAULT_MAX_ORDERS_PER_HOUR = 10;
const DEFAULT_MAX_DAILY_ORDER_VALUE = 2000;
const DEFAULT_LIVE_COOLDOWN_SECONDS = 60;
// Upper bounds keep a typo (an extra zero or three) from silently becoming the limit.
const MAX_ORDER_VALUE_LIMIT = 100_000;
const MAX_ORDERS_PER_HOUR_LIMIT = 100;
const MAX_DAILY_ORDER_VALUE_LIMIT = 1_000_000;
const MAX_LIVE_COOLDOWN_SECONDS = 24 * 60 * 60;
const MAX_ORIGINS = 8;
const KNOWN_FIELDS = new Set([
  'allowedEnvs', 'maxOrderValue', 'maxOrdersPerHour', 'maxDailyOrderValue', 'liveOrderCooldownSeconds', 'origins', 'demoConfirmWithoutPasskey',
]);
// WebAuthn only works on HTTPS, except on these loopback hosts during development.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalid(message: string): never {
  throw new BrokerError(`交易代理配置无效：${message}`, 500, 'BROKER_CONFIG_INVALID');
}
function environments(value: unknown): Environment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('allowedEnvs 必须是数组，例如 ["demo"]');
  const envs = new Set<Environment>();
  for (const item of value) {
    if (item !== 'live' && item !== 'demo') invalid('allowedEnvs 只能包含 "live" 和 "demo"');
    envs.add(item);
  }
  return (['live', 'demo'] as Environment[]).filter(env => envs.has(env));
}
function positive(value: unknown, fallback: number, limit: number, field: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > limit) invalid(`${field} 必须是 0 到 ${limit} 之间的数字`);
  return value;
}
// A non-negative setting where an explicit 0 means "off": no daily cap, no cooldown.
function nonNegative(value: unknown, fallback: number, limit: number, field: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > limit) invalid(`${field} 必须是 0 到 ${limit} 之间的数字（0 表示不启用）`);
  return value;
}
function origins(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) invalid(`origins 必须是最多 ${MAX_ORIGINS} 个网址的数组`);
  const result = new Set<string>();
  for (const item of value) {
    let url: URL | null = null;
    try { url = typeof item === 'string' ? new URL(item) : null; } catch { url = null; }
    // Exactly scheme://host[:port], the form browsers send in the Origin header and sign into clientDataJSON.
    if (!url || url.origin !== item) invalid(`"${String(item).slice(0, 80)}" 不是一个网址来源（形如 https://studio.example.com，结尾没有 /）`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) invalid(`${url.origin} 必须使用 HTTPS（只有 localhost 可以用 HTTP）`);
    result.add(url.origin);
  }
  return [...result];
}

/** Used by the broker service and CLI: where an account's order key file lives inside the state directory. */
export function brokerKeyFile(stateDir: string, env: Environment) {
  return path.join(stateDir, `${env}.env`);
}

/**
 * Used by loadBrokerConfig and the broker tests: validates config.json text. Unknown fields and bad values are
 * refused instead of ignored, so a misspelt setting can never fall back to something looser than intended.
 */
export function parseBrokerConfig(text: string, stateDir: string) {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { invalid('config.json 不是有效的 JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('config.json 必须是一个对象');
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !KNOWN_FIELDS.has(key));
  if (unknown.length) invalid(`不认识的字段 ${unknown.join(', ')}`);
  if (input.demoConfirmWithoutPasskey !== undefined && typeof input.demoConfirmWithoutPasskey !== 'boolean') invalid('demoConfirmWithoutPasskey 必须是 true 或 false');
  return {
    stateDir,
    databasePath: path.join(stateDir, 'broker.db'),
    keyFiles: { live: brokerKeyFile(stateDir, 'live'), demo: brokerKeyFile(stateDir, 'demo') } as Record<Environment, string>,
    allowedEnvs: environments(input.allowedEnvs),
    maxOrderValue: positive(input.maxOrderValue, DEFAULT_MAX_ORDER_VALUE, MAX_ORDER_VALUE_LIMIT, 'maxOrderValue'),
    maxOrdersPerHour: Math.floor(positive(input.maxOrdersPerHour, DEFAULT_MAX_ORDERS_PER_HOUR, MAX_ORDERS_PER_HOUR_LIMIT, 'maxOrdersPerHour')),
    // Cumulative value of orders that reached Trading 212 in the last rolling 24 h; 0 means no daily cap.
    maxDailyOrderValue: nonNegative(input.maxDailyOrderValue, DEFAULT_MAX_DAILY_ORDER_VALUE, MAX_DAILY_ORDER_VALUE_LIMIT, 'maxDailyOrderValue'),
    // Minimum seconds between two live orders that reach Trading 212; 0 means no live cooldown.
    liveOrderCooldownSeconds: Math.floor(nonNegative(
      input.liveOrderCooldownSeconds, DEFAULT_LIVE_COOLDOWN_SECONDS, MAX_LIVE_COOLDOWN_SECONDS, 'liveOrderCooldownSeconds',
    )),
    origins: origins(input.origins),
    // Demo money only: lets demo orders be confirmed without a passkey. Live orders always need one.
    demoConfirm: input.demoConfirmWithoutPasskey === true,
  };
}

/** Used by the broker CLI (`serve`, `check`): reads <stateDir>/config.json; a missing file means trading stays off. */
export function loadBrokerConfig(stateDir: string) {
  let text = '{}';
  try { text = readFileSync(path.join(stateDir, 'config.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid('config.json 无法读取'); }
  return parseBrokerConfig(text, stateDir);
}
