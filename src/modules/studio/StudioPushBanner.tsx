import { IconBell, IconBellOff } from '@/modules/studio/icons/tabler';
import { useStudioPush } from '@/modules/studio/hooks/useStudioPush';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

// What each state tells the owner, and the one action that fixes it (if any).
const COPY = {
  'needs-install': {
    title: '先把 Studio 添加到主屏幕', action: null,
    text: '在 iPad 和 iPhone 上，网页要从主屏幕打开才能收到通知：在 Safari 里点分享按钮 → 添加到主屏幕，然后从主屏幕打开 Studio，再回到这里开启通知。',
  },
  unsupported: { title: '这个浏览器收不到通知', action: null, text: '自动化照常运行，但提醒到不了这里。用 Safari（添加到主屏幕后）、Chrome 或 Edge 打开 Studio 就能开启。' },
  default: { title: '通知还没有开启', action: '开启通知', text: '自动化的提醒要靠通知送到你手上。开启后，这台设备会收到推送。' },
  denied: {
    title: '通知被拒绝了', action: null,
    text: '请在系统设置 → 通知 → Studio（或浏览器的网站设置）里允许通知，然后回到这里，这一栏会自动更新。',
  },
  'off-here': { title: '这台设备还没有开启通知', action: '在这台设备上开启', text: '允许通知后，还需要在这台设备上订阅，自动化的提醒才能送到。' },
  'off-server': { title: '推送通知已关闭', action: '重新开启', text: '推送在设置里被关掉了，自动化运行时不会发出提醒。' },
} as const;

/** Used by the 自动化 tab (StudioProjectTasks): shows whether automations can notify this device and how to turn it on. */
export function StudioPushBanner() {
  const push = useStudioPush();
  if (push.state === 'on') {
    return <div className="push-banner is-on" role="status">
      <IconBell size={20} aria-hidden="true" />
      <div className="push-banner-body">
        <strong>通知已开启</strong>
        <small>{push.devices > 1 ? `${push.devices} 台设备会收到自动化的提醒` : '这台设备会收到自动化的提醒'}{push.testResult && ` · ${push.testResult}`}</small>
      </div>
      <button type="button" className="ios-button" disabled={push.testing} onClick={() => void push.sendTest()}>
        {push.testing && <StudioSpinner size={14} />}发送测试</button>
    </div>;
  }
  const copy = COPY[push.state];
  return <div className="push-banner is-off" role="status" data-state={push.state}>
    <IconBellOff size={20} aria-hidden="true" />
    <div className="push-banner-body">
      <strong>{copy.title}</strong>
      <small>{copy.text}</small>
      {push.error && <small className="push-banner-error">{push.error}</small>}
    </div>
    {copy.action && <button type="button" className="ios-button filled" disabled={push.busy} onClick={() => void push.enable()}>
      {push.busy && <StudioSpinner size={14} />}{copy.action}</button>}
  </div>;
}
