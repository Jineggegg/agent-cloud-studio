import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, UIEvent } from 'react';
import { m } from 'motion/react';

import { IconChartCandle, IconChartPie, IconChevronLeft, IconChevronRight, IconCpu, IconCursorText, IconGauge, IconInfoCircle, IconLayoutGrid, IconMail, IconMoon, IconRoute, IconWorld } from '@/modules/studio/icons/tabler';
import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import { useTheme } from '@/shared/context/ThemeContext';
import { useQuotaPreferences } from '@/shared/hooks/useQuotaPreferences';
import { readModelDefaults } from '@/shared/modelDefaults';
import type { LLMProvider, QuotaDisplayMode, StudioStatus, T212Status, ThemeMode } from '@/shared/types';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioSettingsAbout } from '@/modules/studio/StudioSettingsAbout';
import { StudioSettingsAccount } from '@/modules/studio/StudioSettingsAccount';
import { StudioSettingsAjExit } from '@/modules/studio/StudioSettingsAjExit';
import { StudioSettingsDeepSeek } from '@/modules/studio/StudioSettingsDeepSeek';
import { StudioSettingsHome } from '@/modules/studio/StudioSettingsHome';
import { StudioSettingsMail } from '@/modules/studio/StudioSettingsMail';
import { StudioSettingsModels } from '@/modules/studio/StudioSettingsModels';
import { StudioSettingsNetwork } from '@/modules/studio/StudioSettingsNetwork';
import { StudioSettingsQuota } from '@/modules/studio/StudioSettingsQuota';
import { StudioSettingsRemote } from '@/modules/studio/StudioSettingsRemote';
import { SettingsIcon, SettingsLinkRow } from '@/modules/studio/StudioSettingsRows';
import { StudioSettingsRuntime } from '@/modules/studio/StudioSettingsRuntime';
import { StudioSettingsTrading } from '@/modules/studio/StudioSettingsTrading';
import { StudioSettingsTradingLog } from '@/modules/studio/StudioSettingsTradingLog';
import { useAjExitState } from '@/modules/studio/hooks/useAjExit';
import { useHomeLayout } from '@/modules/studio/utils/homeLayout';
import { DEFAULT_SETTINGS_PAGE, SETTINGS_PAGES, browserBuild } from '@/modules/studio/settingsPages';
import type { SettingsPageId } from '@/modules/studio/settingsPages';
import '@/modules/studio/studio-settings.css';

const THEMES: [ThemeMode, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '自动']];
const QUOTA_MODES: [QuotaDisplayMode, string][] = [['remaining', '剩余'], ['used', '已用']];

// "claude-opus-5-5[1m]" → "Opus 5.5 · 1M", "sonnet" → "Sonnet"; anything else as it is.
function modelLabel(id: string | undefined) {
  if (!id) return '默认';
  const long = /\[1m\]$/i.test(id);
  const base = id.replace(/\[1m\]$/i, '');
  const family = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?$/i.exec(base);
  const name = family ? `${family[1][0].toUpperCase()}${family[1].slice(1).toLowerCase()}${family[2] ? ` ${family[2]}${family[3] ? `.${family[3]}` : ''}` : ''}` : base;
  return long ? `${name} · 1M` : name;
}

// Which front door this page came in through, for the 网络 row.
function entryLabel() {
  const host = window.location.hostname;
  if (/\.ts\.net$/i.test(host)) return 'Tailscale';
  if (host === 'localhost' || host === '127.0.0.1') return '本机';
  return '公网';
}

/**
 * Whether the server found each Trading 212 account's key file, as a badge only (the keys themselves are never sent;
 * where the files live is server configuration, not something to read here).
 */
function T212KeyStatus() {
  const [t212, setT212] = useState<T212Status[] | null>(null);
  useEffect(() => {
    let active = true;
    void api.studio.trading212.status().then(readApiJson<T212Status[]>).then(value => { if (active) setT212(value); }).catch(() => { if (active) setT212([]); });
    return () => { active = false; };
  }, []);
  return <section className="ios-section first" aria-labelledby="studio-t212-heading">
    <div className="ios-section-header"><h2 id="studio-t212-heading">账户</h2></div>
    <div className="ios-list">
      {(t212 ?? []).map(item => <div className="ios-row" key={item.env}>
        <SettingsIcon><IconChartCandle size={18} strokeWidth={1.6} /></SettingsIcon>
        <span className="ios-row-body"><strong>{item.env === 'live' ? '实盘账户' : '模拟账户'}</strong></span>
        <span className={`status-badge ${item.configured ? 'good' : ''}`}>{item.configured ? '已接入' : '未接入'}</span>
      </div>)}
      {t212 === null && <div className="ios-row no-icon"><span className="ios-row-body"><small>正在检查…</small></span></div>}
    </div>
  </section>;
}

/** One settings page's content, by id. */
function SettingsPageContent({ page, status, onChange, onNavigate, onSignOut, modelProvider, onModelProvider }: {
  page: SettingsPageId; status: StudioStatus | null; onChange: () => Promise<void>;
  onNavigate: (page: SettingsPageId | null) => void; onSignOut: () => void;
  // The CLI shown on 模型 and 模型列表, kept while moving between the two.
  modelProvider: LLMProvider; onModelProvider: (provider: LLMProvider) => void;
}) {
  switch (page) {
    case 'account': return <StudioSettingsAccount onSignOut={onSignOut} />;
    case 'models': return <StudioSettingsModels provider={modelProvider} onProviderChange={onModelProvider} onOpenCatalog={() => onNavigate('model-list')} />;
    case 'model-list': return <StudioSettingsModels view="catalog" provider={modelProvider} onProviderChange={onModelProvider} />;
    case 'quota': return <StudioSettingsQuota />;
    case 'deepseek': return <StudioSettingsDeepSeek status={status} onChange={onChange} />;
    case 'network': return <><StudioSettingsNetwork /><StudioSettingsRemote /></>;
    case 'aj-exit': return <StudioSettingsAjExit />;
    case 'mail': return <StudioSettingsMail />;
    case 'trading': return <><T212KeyStatus /><StudioSettingsTrading onOpenLog={() => onNavigate('trading-log')} /></>;
    case 'trading-log': return <StudioSettingsTradingLog />;
    case 'home': return <StudioSettingsHome />;
    case 'about': return <StudioSettingsAbout onOpenRuntime={() => onNavigate('runtime')} />;
    case 'runtime': return <StudioSettingsRuntime onOpenNetwork={() => onNavigate('network')} />;
  }
}

/**
 * The first screen (on a wide screen, the sidebar): who is signed in, the settings changed most often as one-tap
 * controls (theme, quota figures, icon names), then a row per page with its current value, grouped as on iOS.
 */
function SettingsRootList({ status, selected, onOpen }: { status: StudioStatus | null; selected: SettingsPageId | null; onOpen: (page: SettingsPageId) => void }) {
  const { user } = useAuth();
  const { themeMode, isDarkMode, setThemeMode } = useTheme();
  const { preferences, setMode } = useQuotaPreferences();
  const [layout, updateLayout] = useHomeLayout();
  const aj = useAjExitState();
  const claudeModel = useSyncExternalStore(subscribeToUserPreferences, () => readModelDefaults().claude?.model ?? '');
  const build = browserBuild();
  const name = user?.username ?? '';
  const row = (page: SettingsPageId, icon: ReactElement, detail?: string, subtitle?: string) =>
    <SettingsLinkRow key={page} icon={icon} title={SETTINGS_PAGES[page].title} subtitle={subtitle} detail={detail} selected={selected === page} onClick={() => onOpen(page)} />;

  return <div className="settings-root">
    <section className="ios-section first" aria-label="账户">
      <div className="ios-list">
        <button type="button" className="ios-row settings-link settings-account" aria-current={selected === 'account' ? 'page' : undefined} onClick={() => onOpen('account')}>
          <span className="settings-avatar" aria-hidden="true">{Array.from(name)[0]?.toUpperCase() ?? '?'}</span>
          <span className="ios-row-body"><strong>{name || '账户'}</strong><small>登录、通行密钥与安全记录</small></span>
          <IconChevronRight size={18} className="chevron" aria-hidden="true" />
        </button>
      </div>
    </section>

    <section className="ios-section" aria-label="常用">
      <div className="ios-list">
        <div className="ios-row settings-quick">
          <SettingsIcon><IconMoon size={18} /></SettingsIcon>
          <span className="ios-row-body"><strong>外观</strong>{themeMode === 'system' && <small>当前{isDarkMode ? '深色' : '浅色'}</small>}</span>
          <div className="segmented small" role="radiogroup" aria-label="外观">
            {THEMES.map(([mode, label]) => <button type="button" role="radio" key={mode} aria-checked={themeMode === mode} onClick={() => setThemeMode(mode)}>{label}</button>)}
          </div>
        </div>
        <div className="ios-row settings-quick">
          <SettingsIcon><IconGauge size={18} /></SettingsIcon>
          <span className="ios-row-body"><strong>额度</strong></span>
          <div className="segmented small" role="radiogroup" aria-label="额度显示方式">
            {QUOTA_MODES.map(([mode, label]) => <button type="button" role="radio" key={mode} aria-checked={preferences.mode === mode} onClick={() => setMode(mode)}>{label}</button>)}
          </div>
        </div>
        <label className="ios-row settings-quick switch-row">
          <SettingsIcon><IconCursorText size={18} /></SettingsIcon>
          <span className="ios-row-body"><strong>图标名称</strong></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label="显示图标名称" checked={layout.labels} onChange={event => updateLayout({ labels: event.target.checked })} />
        </label>
      </div>
    </section>

    <section className="ios-section" aria-label="AI">
      <div className="ios-list">
        {row('models', <IconCpu size={18} />, modelLabel(claudeModel || undefined))}
        {row('quota', <IconChartPie size={18} />, undefined, '首页小组件和工作台显示哪些')}
        {row('deepseek', <StudioBrandMark brand="deepseek" size={17} />, status ? status.deepseek.configured ? '已配置' : '未配置' : undefined)}
      </div>
    </section>

    <section className="ios-section" aria-label="连接">
      <div className="ios-list">
        {row('network', <IconWorld size={18} />, entryLabel())}
        {row('aj-exit', <IconRoute size={18} />, !aj.supported ? '仅限 iPhone / iPad' : !aj.ready ? '未设置' : aj.on ? '已开启' : '未开启')}
        {row('mail', <IconMail size={18} />)}
        {row('trading', <IconChartCandle size={18} />)}
      </div>
    </section>

    <section className="ios-section" aria-label="通用">
      <div className="ios-list">
        {row('home', <IconLayoutGrid size={18} />, layout.folders.length ? `${layout.folders.length} 个文件夹` : undefined)}
        {row('about', <IconInfoCircle size={18} />, build ? `v${build.version}` : '开发')}
      </div>
    </section>
  </div>;
}

/**
 * Used by StudioPage for Studio's settings app (/apps/connections?tab=<page>), laid out like iOS Settings. A wide
 * screen shows the list beside the chosen page, as on iPadOS; a phone shows one screen at a time, pushed in from the
 * side. The settings changed most often are one tap on the list itself; everything else is a page, and what is
 * rarely touched is one level further in (模型 → 模型列表, Trading 212 → 变更日志, 关于本机 → 版本与运行状态).
 * Secrets are provisioned without ever being read back to the browser (StudioSettingsDeepSeek).
 */
export function StudioConnections({ status, onChange, page, split, onNavigate, onScroll, onSignOut }: {
  status: StudioStatus | null; onChange: () => Promise<void>;
  // The page asked for in the URL; null is the list (a wide screen then shows the first page beside it).
  page: SettingsPageId | null;
  // Whether the list and the page sit side by side (settingsPages.useSettingsSplit).
  split: boolean;
  onNavigate: (page: SettingsPageId | null) => void;
  // Lets the navigation bar turn to glass once the page's large title scrolls away.
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  onSignOut: () => void;
}) {
  const shown = page ?? (split ? DEFAULT_SETTINGS_PAGE : null);
  const [modelProvider, setModelProvider] = useState<LLMProvider>('claude');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Pages deeper in slide in from the right, going back from the left.
  const depth = shown ? SETTINGS_PAGES[shown].parent ? 2 : 1 : 0;
  const [travel, setTravel] = useState({ depth, direction: 1 });
  // Adjusted while rendering (not in an effect), so the new page already starts from the right side.
  if (travel.depth !== depth) setTravel({ depth, direction: depth >= travel.depth ? 1 : -1 });
  const direction = travel.depth !== depth ? (depth >= travel.depth ? 1 : -1) : travel.direction;
  // A new page starts at its top.
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [shown]);

  const parent = shown ? SETTINGS_PAGES[shown].parent : undefined;
  const content = shown && <SettingsPageContent page={shown} status={status} onChange={onChange} onNavigate={onNavigate} onSignOut={onSignOut}
    modelProvider={modelProvider} onModelProvider={setModelProvider} />;
  const pageBody = shown && <m.div key={shown} className="settings-page" initial={{ opacity: 0, x: split ? 0 : 28 * direction }} animate={{ opacity: 1, x: 0 }}
    transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
    {/* On a wide screen, a page one level in has its own way back (a phone's is in the navigation bar). */}
    {split && parent && <button type="button" className="settings-back ios-press" onClick={() => onNavigate(parent)}>
      <IconChevronLeft size={22} aria-hidden="true" />{SETTINGS_PAGES[parent].title}</button>}
    <div className="studio-large-title"><h1>{SETTINGS_PAGES[shown].title}</h1></div>
    {content}
  </m.div>;

  if (split) return <div className="settings-split">
    <nav className="settings-sidebar" aria-label="设置">
      <SettingsRootList status={status} selected={parent ?? shown} onOpen={onNavigate} />
    </nav>
    <div ref={scrollRef} className="settings-detail" onScroll={onScroll}>{pageBody}</div>
  </div>;

  return <div ref={scrollRef} className="studio-scroll settings-single" onScroll={onScroll}>
    <div className="studio-content">
      {shown ? pageBody : <m.div key="root" className="settings-page" initial={{ opacity: 0, x: -28 * (direction < 0 ? 1 : 0) }} animate={{ opacity: 1, x: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
        <div className="studio-large-title"><h1>设置</h1></div>
        <SettingsRootList status={status} selected={null} onOpen={onNavigate} />
      </m.div>}
    </div>
  </div>;
}
