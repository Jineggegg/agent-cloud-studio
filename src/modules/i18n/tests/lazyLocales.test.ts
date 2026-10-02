import { afterEach, expect, test, vi } from 'vitest';

// Keep language switches local: the real preference store would try to sync with the server.
vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (_key: string, fallback: unknown) => fallback,
  subscribeToUserPreferences: () => () => {},
  writeUserPreference: () => {},
}));

const { i18n } = await import('@/modules/i18n');

afterEach(async () => {
  await i18n.changeLanguage('en');
});

test('a device with no saved language starts in Chinese, and English ships with the app', () => {
  // No saved preference (the mock returns the fallback): this Studio starts in Chinese.
  expect(i18n.options.lng).toBe('zh-CN');
  expect(i18n.hasResourceBundle('en', 'auth')).toBe(true);
  expect(i18n.getFixedT('en')('auth:login.submit')).toBe('Sign In');
});

test('other languages are not in the entry bundle and load on demand when chosen', async () => {
  expect(i18n.hasResourceBundle('de', 'auth')).toBe(false);
  await i18n.changeLanguage('de');
  expect(i18n.hasResourceBundle('de', 'auth')).toBe(true);
  expect(i18n.t('auth:login.title')).toBe('Willkommen zurück');
});

test('a namespace a language does not ship falls back to English instead of failing', async () => {
  await i18n.changeLanguage('de');
  expect(i18n.t('git:tabs.changes')).toBe('Changes');
});
