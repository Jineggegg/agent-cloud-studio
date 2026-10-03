import { useEffect, useState } from 'react';

import type { StudioBuildInfo } from '@/shared/types';

/**
 * The pages of Studio's settings app (/apps/connections?tab=<page>): what the sidebar (or, on a phone, the first
 * screen) lists, and the pages one level further in. Kept apart from the pages themselves so StudioPage can title its
 * navigation bar without loading them.
 */
export type SettingsPageId = 'account' | 'models' | 'model-list' | 'quota' | 'deepseek' | 'network' | 'aj-exit' | 'mail' | 'trading' | 'home' | 'about' | 'runtime';

export const SETTINGS_PAGES: Record<SettingsPageId, { title: string; parent?: SettingsPageId }> = {
  account: { title: '账户与安全' },
  models: { title: '模型' },
  'model-list': { title: '模型列表', parent: 'models' },
  quota: { title: '额度项目' },
  deepseek: { title: 'DeepSeek' },
  network: { title: '网络与远程主机' },
  'aj-exit': { title: 'AJ 出口' },
  mail: { title: '邮箱' },
  trading: { title: 'Trading 212' },
  home: { title: '主屏幕' },
  about: { title: '关于本机' },
  runtime: { title: '版本与运行状态', parent: 'about' },
};

// What a wide screen shows beside the list when no page is chosen.
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'models';
// The Trading 212 app links to its safety settings with this fragment (StudioSettingsTrading scrolls to it).
const TRADING_FRAGMENT = '#t212-trading-safety';

const isPage = (value: string | null): value is SettingsPageId => Boolean(value && Object.prototype.hasOwnProperty.call(SETTINGS_PAGES, value));

/** The page a settings URL asks for: `?tab=<page>`, or the Trading 212 safety fragment; null for the list itself. */
export function readSettingsPage(tab: string | null, hash: string): SettingsPageId | null {
  if (isPage(tab)) return tab;
  return hash === TRADING_FRAGMENT ? 'trading' : null;
}

// Wide enough for the list and a page side by side, as on iPadOS (an iPad in portrait included).
const SPLIT_QUERY = '(min-width: 760px)';

/** Whether settings show the list and a page side by side (otherwise one screen at a time, pushed like iOS). */
export function useSettingsSplit() {
  const query = () => typeof window.matchMedia === 'function' && window.matchMedia(SPLIT_QUERY).matches;
  const [split, setSplit] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(SPLIT_QUERY);
    const onChange = () => setSplit(list.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, []);
  return split;
}

/** The build this page was loaded from, as Vite recorded it (null in development). */
export function browserBuild(): StudioBuildInfo | null {
  return typeof __STUDIO_BUILD_INFO__ !== 'undefined' && __STUDIO_BUILD_INFO__ && typeof __STUDIO_BUILD_INFO__.version === 'string' ? __STUDIO_BUILD_INFO__ : null;
}
