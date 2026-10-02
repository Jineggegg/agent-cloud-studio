import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Auto-cleanup only self-registers when vitest globals are enabled, and they are
// not. Without this, a hook rendered in one test stays mounted — with its timers
// and effects live — for the rest of the file.
afterEach(cleanup);

// jsdom ships no `matchMedia`, and components that pick a layout from the
// viewport call it during render. Report the desktop breakpoint, which is the
// layout the sidebar row tests assert on.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// The product starts devices with no saved language in Chinese (src/modules/i18n/config.ts);
// the suite asserts on the English strings, so pin English before any module reads preferences.
localStorage.setItem('user-preferences', JSON.stringify({ userLanguage: 'en' }));
