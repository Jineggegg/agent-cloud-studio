import { useAuth } from '@/modules/auth';
import { StudioSettingsSecurity } from '@/modules/studio/StudioSettingsSecurity';

/** Used by Settings → 账户与安全: who is signed in, their sign-ins, passkeys and security events, and signing out. */
export function StudioSettingsAccount({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useAuth();
  const name = user?.username ?? '';
  return <>
    <section className="ios-section first" aria-label="账户">
      <div className="ios-list">
        <div className="ios-row settings-account">
          <span className="settings-avatar" aria-hidden="true">{Array.from(name)[0]?.toUpperCase() ?? '?'}</span>
          <span className="ios-row-body"><strong>{name || '已登录'}</strong><small>Agent Cloud Studio 账户 · 仅限本人使用</small></span>
        </div>
      </div>
    </section>
    <StudioSettingsSecurity />
    <section className="ios-section" aria-label="退出">
      <div className="ios-list">
        <button type="button" className="ios-row action destructive no-icon settings-center" onClick={onSignOut}>退出登录</button>
      </div>
    </section>
  </>;
}
