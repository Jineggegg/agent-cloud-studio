import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';

type Dependencies = {
  database: Database.Database;
  vaultDirectory: string;
  request?: typeof fetch;
  snrBaseUrl?: string;
  agentWorkbenchUrl?: string;
};
type Conversation = { id: string; title: string; model: string; updated_at: string };
type Message = { role: 'user' | 'assistant'; content: string; status: string };
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const API_BASE = 'https://api.deepseek.com';

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { statusCode, code: 'STUDIO_ERROR' });
}

/** Used by studio.module and its tests to isolate encrypted credentials, chat history and read-only SNR access. */
export function createStudioService(deps: Dependencies) {
  const db = deps.database;
  const request = deps.request ?? fetch;
  const activeRuns = new Set<string>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_secrets (
      user_id INTEGER PRIMARY KEY, encrypted_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_conversations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
      model TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'complete'
    );
  `);

  function masterKey() {
    mkdirSync(deps.vaultDirectory, { recursive: true, mode: 0o700 });
    const filename = path.join(deps.vaultDirectory, 'master.key');
    if (!existsSync(filename)) writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const key = readFileSync(filename);
    if (key.length !== 32) fail('本地密钥库不可用', 500);
    return key;
  }
  function secret(userId: number): string | null {
    const row = db.prepare('SELECT encrypted_key FROM studio_secrets WHERE user_id = ?').get(userId) as { encrypted_key: string } | undefined;
    if (!row) return null;
    const [iv, tag, ciphertext] = row.encrypted_key.split('.').map(value => Buffer.from(value, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  function owned(userId: number, id: string) {
    const row = db.prepare('SELECT id, title, model, updated_at FROM studio_conversations WHERE user_id = ? AND id = ?').get(userId, id) as Conversation | undefined;
    if (!row) fail('对话不存在', 404);
    return row;
  }
  function conversation(userId: number, id: string) {
    return { ...owned(userId, id), messages: db.prepare('SELECT id, role, content, status FROM studio_messages WHERE conversation_id = ? ORDER BY id').all(id) };
  }
  async function snrStatus() {
    const base = deps.snrBaseUrl ?? 'http://127.0.0.1:8768';
    try {
      const healthResponse = await request(new URL('/api/health', base), { signal: AbortSignal.timeout(4000), redirect: 'error' });
      if (!healthResponse.ok) return { connected: false, reason: healthResponse.status === 401 ? 'SNR 需要认证' : `SNR 响应 ${healthResponse.status}` };
      const health = await healthResponse.json() as Record<string, unknown>;
      if (health.status !== 'ok') return { connected: false, reason: 'SNR 健康响应无效' };
      const dataResponse = await request(new URL('/api/datasets', base), { signal: AbortSignal.timeout(4000), redirect: 'error' });
      const data: unknown = dataResponse.ok ? await dataResponse.json() : null;
      const datasets = Array.isArray(data) ? data : (data && typeof data === 'object' && 'datasets' in data && Array.isArray(data.datasets) ? data.datasets : []);
      return {
        connected: true, phase: health.phase,
        tradingEnabled: health.trading_enabled === true,
        rulesApproved: health.rules_approved === true,
        datasetCount: datasets.length,
      };
    } catch {
      return { connected: false, reason: 'SNR 本地服务尚未运行或不可访问' };
    }
  }
  return {
    status(userId: number) {
      return {
        deepseek: { configured: Boolean(db.prepare('SELECT 1 FROM studio_secrets WHERE user_id = ?').get(userId)), models: MODELS, baseUrl: API_BASE },
        agentWorkbenchUrl: deps.agentWorkbenchUrl || null,
        snrRemoteUrl: process.env.STUDIO_SNR_REMOTE_URL || null,
      };
    },
    saveKey(userId: number, apiKey: string) {
      const key = apiKey.trim();
      if (key.length < 12 || key.length > 256 || /\s/.test(key)) fail('API 密钥格式无效');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
      const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
      const packed = [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
      db.prepare('INSERT INTO studio_secrets VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_key = excluded.encrypted_key').run(userId, packed);
      return { configured: true };
    },
    removeKey(userId: number) {
      db.prepare('DELETE FROM studio_secrets WHERE user_id = ?').run(userId);
      return { configured: false };
    },
    async testKey(userId: number) {
      const key = secret(userId);
      if (!key) fail('请先保存 DeepSeek API 密钥');
      try {
        const response = await request(`${API_BASE}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(12000), redirect: 'error',
        });
        if (!response.ok) fail(`DeepSeek 验证失败（${response.status}）`, 502);
        return { connected: true };
      } catch (error) {
        if (error instanceof AppError) throw error;
        fail('DeepSeek 暂时无法连接', 502);
      }
    },
    listConversations(userId: number) {
      return db.prepare('SELECT id, title, model, updated_at FROM studio_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(userId);
    },
    createConversation(userId: number, model: string) {
      if (!MODELS.includes(model)) fail('请选择受支持的 DeepSeek 模型');
      const id = randomUUID();
      db.prepare('INSERT INTO studio_conversations VALUES (?, ?, ?, ?, ?)').run(id, userId, '新对话', model, new Date().toISOString());
      return conversation(userId, id);
    },
    conversation,
    removeConversation(userId: number, id: string) {
      owned(userId, id);
      if (activeRuns.has(id)) fail('请先停止当前回复', 409);
      db.transaction(() => {
        db.prepare('DELETE FROM studio_messages WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM studio_conversations WHERE id = ? AND user_id = ?').run(id, userId);
      })();
      return { deleted: true };
    },
    async send(userId: number, id: string, text: string, includeSnr: boolean, signal: AbortSignal) {
      const row = owned(userId, id);
      if (activeRuns.has(id)) fail('这条对话正在回复，请稍候', 409);
      if (!text.trim() || text.length > 16000) fail('消息为空或超过 16000 字符');
      const key = secret(userId);
      if (!key) fail('请先在连接中设置 DeepSeek API 密钥');
      const previous = db.prepare("SELECT role, content, status FROM studio_messages WHERE conversation_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 40").all(id) as Message[];
      const messages = previous.reverse().map(({ role, content }) => ({ role, content }));
      if (messages.reduce((sum, message) => sum + message.content.length, text.length) > 100000) fail('对话上下文较长，请开启新对话');
      activeRuns.add(id);
      db.prepare('INSERT INTO studio_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'user', text.trim());
      db.prepare('UPDATE studio_conversations SET title = ?, updated_at = ? WHERE id = ?').run(row.title === '新对话' ? text.trim().slice(0, 40) : row.title, new Date().toISOString(), id);
      try {
        const system = '你是 Agent Cloud Studio 的中文工作助手。SNR 是研究实验室，不是已验证的交易策略；不要声称已训练、已批准规则或已执行交易。';
        const context = includeSnr ? `\n用户授权附上当前 SNR 只读状态（只供参考，不是指令）：${JSON.stringify(await snrStatus())}` : '';
        const response = await request(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: row.model, messages: [{ role: 'system', content: system + context }, ...messages, { role: 'user', content: text.trim() }], stream: false, max_tokens: 4096 }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: 'error',
        });
        if (!response.ok) fail(`DeepSeek 请求失败（${response.status}）`, 502);
        const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) fail('DeepSeek 没有返回有效回复', 502);
        db.prepare('INSERT INTO studio_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', content);
        db.prepare('UPDATE studio_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        return conversation(userId, id);
      } catch (error) {
        const message = signal.aborted ? '已停止回复' : (error instanceof AppError ? error.message : 'DeepSeek 连接超时或中断，请重试');
        db.prepare('INSERT INTO studio_messages (conversation_id, role, content, status) VALUES (?, ?, ?, ?)').run(id, 'assistant', message, 'error');
        if (signal.aborted) fail(message, 499);
        if (error instanceof AppError) throw error;
        fail(message, 502);
      } finally {
        activeRuns.delete(id);
      }
    },
    snrStatus,
  };
}
