import { useId, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import { T212_ENV_LABELS, T212_MODE_LABELS } from '@/shared/constants';
import type { T212Env, T212ModeChange, T212StepUpChallenge, T212TradingConfig, T212TradingMode } from '@/shared/types';
import { apiErrorCode } from '@/shared/utils';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioT212HistoryList, StudioT212HistoryRow } from '@/modules/studio/StudioT212History';
import { StudioT212ReviewSheet } from '@/modules/studio/StudioT212ReviewSheet';
import '@/modules/studio/studio-orders.css';

// What the selector is doing: saving a narrowing, fetching a widening challenge, showing it for review, or running
// Face ID and the save. Anything but null disables every option.
type ModeBusy = 'saving' | 'challenge' | 'review' | 'passkey' | null;
// A widening waiting for the user's go-ahead: the exact mode its challenge was issued for, and from which mode.
// POST /mode/challenge: the challenge plus the server's view of the change: the mode in force, the new one, the accounts
// it adds and the ceiling. The review is built from this, never from this page's possibly stale settings.
type ModeChallenge = T212StepUpChallenge & { from: T212TradingMode; to: T212TradingMode; adds: T212Env[]; ceiling: T212TradingMode };
type PendingWidening = { challenge: ModeChallenge };

const MODES: T212TradingMode[] = ['off', 'demo', 'live', 'both'];
// Live first, as the server lists them.
const MODE_ENVS: Record<T212TradingMode, T212Env[]> = { off: [], demo: ['demo'], live: ['live'], both: ['live', 'demo'] };

function envNames(envs: T212Env[]) {
  return envs.map(env => T212_ENV_LABELS[env]).join('和');
}
// Accounts in `next` that `current` does not allow; any of them makes the change a widening, as the server decides.
function added(current: T212TradingMode, next: T212TradingMode) {
  return MODE_ENVS[next].filter(env => !MODE_ENVS[current].includes(env));
}
function removed(current: T212TradingMode, next: T212TradingMode) {
  return MODE_ENVS[current].filter(env => !MODE_ENVS[next].includes(env));
}
function cancelled(reason: unknown) {
  return reason instanceof Error && reason.name === 'NotAllowedError';
}
// WebAuthn errors carry DOMException-style names whose raw messages are English and technical.
function saveError(reason: unknown) {
  if (cancelled(reason)) return '已取消面容 ID / 触控 ID 验证，交易模式没有改变';
  if (reason instanceof Error && reason.name === 'SecurityError') return '当前网址不能使用通行密钥：需要 HTTPS 域名或 localhost';
  return reason instanceof Error && reason.message ? reason.message : '交易模式没有保存';
}
// Why this page cannot add accounts, or '' when it can: Face ID / Touch ID of this very domain, on a trusted origin.
function widenBlocker(config: T212TradingConfig, trusted: boolean) {
  const host = window.location.hostname;
  const domains = [...new Set(config.passkeys.map(item => item.rpId))];
  if (!browserSupportsWebAuthn()) return '这个浏览器不支持面容 ID / 触控 ID，不能开启下单；关闭或减少账户不受影响。';
  if (!domains.length) return '启用面容 ID 后才能开启：请先在下方启用面容 ID / 触控 ID。关闭或减少账户不需要验证。';
  if (!trusted) return '当前网址不在下单白名单，不能开启下单；关闭或减少账户不受影响。';
  if (!domains.includes(host)) return `启用面容 ID 后才能开启：请先在下方为 ${host} 启用，或到 ${domains.join('、')} 操作。`;
  return '';
}

/**
 * Used by StudioSettingsTrading (Settings → 交易安全) as the one-tap selector for which Trading 212 accounts may
 * place orders: 关闭 / 模拟盘 / 实盘 / 实盘+模拟盘. STUDIO_T212_TRADING is the ceiling: options outside it are disabled
 * with the server's reason. Narrowing saves at once with the session; adding an account fetches a challenge bound to
 * the new mode, shows from → to for review, then signs it with this domain's Face ID / Touch ID passkey (without
 * one, those options are disabled and the selector says to enable Face ID first). Every option is disabled while a
 * request or ceremony runs, and each result is toasted.
 */
export function StudioT212TradingModeSelector({ config, trusted, onSaved }: {
  config: T212TradingConfig; trusted: boolean; onSaved: () => Promise<void> | void;
}) {
  // The save in progress; while set, every option is disabled so only one change runs at a time.
  const [busy, setBusy] = useState<ModeBusy>(null);
  // The widening shown for review between fetching its challenge and Face ID; null otherwise.
  const [pending, setPending] = useState<PendingWidening | null>(null);
  // Failure of the last attempt (server refusal, cancelled Face ID), shown until the next attempt.
  const [error, setError] = useState('');
  const labelId = useId();
  const noteId = useId();

  const { mode, ceiling } = config.tradingMode;
  const ceilingEnvs = MODE_ENVS[ceiling];
  const outsideCeiling = (value: T212TradingMode) => MODE_ENVS[value].some(env => !ceilingEnvs.includes(env));
  const blocker = widenBlocker(config, trusted);
  const unavailable = MODES.filter(outsideCeiling);
  const missingOnServer = (['live', 'demo'] as const).filter(env => !ceilingEnvs.includes(env));
  // One line for every option the server does not allow, e.g. 服务器未开启实盘下单.
  const ceilingNote = unavailable.length
    ? `服务器未开启${envNames(missingOnServer)}下单（STUDIO_T212_TRADING=${ceiling}），${unavailable.map(value => `「${T212_MODE_LABELS[value]}」`).join('')}不可选`
    : '';
  // Options that would add an account while this page cannot approve that with Face ID.
  const blockedWidening = Boolean(blocker) && MODES.some(value => !outsideCeiling(value) && added(mode, value).length > 0);

  const fail = (reason: unknown, widening: boolean) => {
    const message = saveError(reason);
    setError(message);
    // A cancelled Face ID prompt is the user's own choice; everything else is reported as a failure too.
    if (!cancelled(reason)) toast.error(widening ? '没有开启下单' : '交易模式没有保存', { description: message });
    // Any trading-mode refusal may mean the server's state moved on (another tab, a stale review): show it as it is now.
    if (apiErrorCode(reason).startsWith('T212_MODE_')) void onSaved();
  };
  // Narrowing saves at once; widening first fetches the challenge bound to that mode and shows it for review.
  const choose = async (next: T212TradingMode) => {
    if (busy !== null || next === mode) return;
    setError('');
    if (!added(mode, next).length) {
      setBusy('saving');
      try {
        await readApiJson(await api.studio.t212Trading.updateMode(next));
        toast.success(next === 'off' ? '已关闭下单' : `已关闭${envNames(removed(mode, next))}下单`, { description: `允许下单的账户：${T212_MODE_LABELS[next]}` });
        await onSaved();
      } catch (reason) { fail(reason, false); }
      finally { setBusy(null); }
      return;
    }
    setBusy('challenge');
    try {
      const challenge = await readApiJson<ModeChallenge>(await api.studio.t212Trading.modeChallenge(next));
      setPending({ challenge });
      setBusy('review');
    } catch (reason) { fail(reason, true); setBusy(null); }
  };
  // Called straight from the review's confirm tap, so Face ID starts within that user gesture.
  const confirmWidening = async () => {
    if (!pending) return;
    const { challenge } = pending;
    const { to } = challenge;
    setBusy('passkey');
    try {
      const assertion = await startAuthentication({ optionsJSON: challenge.authentication });
      await readApiJson(await api.studio.t212Trading.updateMode(to, { challengeId: challenge.challengeId, assertion }));
      toast.success(`已用面容 ID / 触控 ID 开启${envNames(challenge.adds)}下单`, { description: `允许下单的账户：${T212_MODE_LABELS[to]}` });
      setPending(null);
      await onSaved();
    } catch (reason) { setPending(null); fail(reason, true); }
    finally { setBusy(null); }
  };
  const cancelWidening = () => { setPending(null); setBusy(null); };

  const opening = pending?.challenge.adds ?? [];
  return <>
    <div className="ios-list t212-mode" role="group" aria-labelledby={labelId}>
      <div className="ios-row no-icon">
        <span className="ios-row-body">
          <strong id={labelId}>允许下单的账户</strong>
          <small>服务器上限：{T212_MODE_LABELS[ceiling]}（STUDIO_T212_TRADING）</small>
        </span>
        {busy !== null && busy !== 'review' && <StudioSpinner size={16} label="正在保存交易模式" />}
      </div>
      <div className="t212-mode-control">
        <div className="segmented t212-mode-segmented" role="radiogroup" aria-labelledby={labelId} aria-describedby={ceilingNote ? noteId : undefined}
          aria-busy={busy !== null || undefined}>
          {MODES.map(value => {
            const reason = outsideCeiling(value) ? `服务器未开启${envNames(MODE_ENVS[value].filter(env => !ceilingEnvs.includes(env)))}下单`
              : blocker && added(mode, value).length ? blocker : undefined;
            return <button key={value} type="button" role="radio" aria-checked={mode === value} title={reason}
              disabled={busy !== null || Boolean(reason)} onClick={() => void choose(value)}>{T212_MODE_LABELS[value]}</button>;
          })}
        </div>
      </div>
    </div>
    {ceilingNote && <p className="ios-section-footer t212-mode-note" id={noteId}>{ceilingNote}</p>}
    {blockedWidening && <p className="studio-feedback t212-caps-blocked">{blocker}</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    {/* The review step of a widening: from → to and what it opens, as the server reported them with the challenge,
        before Face ID / Touch ID is asked for. */}
    {pending && <StudioT212ReviewSheet title={`开启${envNames(opening)}下单？`}
      message={`${opening.includes('live') ? '实盘使用真实资金。' : ''}服务器只接受下面这个范围，而且只在当前仍是左边的范围时有效。确认后用面容 ID / 触控 ID 验证，验证 60 秒内有效。`}
      rows={[
        { label: '允许下单的账户', value: `${T212_MODE_LABELS[pending.challenge.from]} → ${T212_MODE_LABELS[pending.challenge.to]}` },
        { label: '新开启', value: envNames(opening) },
      ]}
      verifying={busy === 'passkey'} onConfirm={() => void confirmWidening()} onCancel={cancelWidening} />}
  </>;
}

/**
 * Used by StudioSettingsTrading (Settings → 交易安全) to list this user's trading-mode changes and, apart from them,
 * refused attempts to add accounts, newest first.
 */
export function StudioT212TradingModeHistory({ config }: { config: T212TradingConfig }) {
  return <>
    <StudioT212HistoryList title="下单账户变更记录" items={config.modeChanges} renderItem={item => <ModeChangeRow change={item} />} />
    <StudioT212HistoryList title="被拒绝的开启" items={config.modeRefusals} renderItem={item => <ModeChangeRow change={item} />} />
  </>;
}

function ModeChangeRow({ change }: { change: T212ModeChange }) {
  const refused = change.status === 'refused';
  const heading = refused ? '开启下单被拒绝' : change.direction === 'widen' ? '开启下单' : change.direction === 'pin' ? '固定下单账户'
    : change.to === 'off' ? '关闭下单' : '减少下单账户';
  // A pin made on the first read has no "from": it stored the mode that was already in force.
  const values = change.direction === 'pin' && !change.from && change.to ? T212_MODE_LABELS[change.to]
    : change.from && change.to ? `${T212_MODE_LABELS[change.from]} → ${T212_MODE_LABELS[change.to]}` : '请求无效，没有可识别的交易模式';
  const mark = change.direction === 'widen' ? 'up' : change.direction === 'pin' ? 'pin' : 'down';
  return <StudioT212HistoryRow heading={heading} values={values} mark={mark} refused={refused}
    method={change.method} createdAt={change.createdAt} reason={change.reason} who={change} />;
}
