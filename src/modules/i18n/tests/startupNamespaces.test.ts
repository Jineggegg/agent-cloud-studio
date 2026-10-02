import { expect, test, vi } from 'vitest';

// A user whose saved language is Simplified Chinese, opening the Studio home.
vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (key: string, fallback: unknown) => (key === 'userLanguage' ? 'zh-CN' : fallback),
  subscribeToUserPreferences: () => () => {},
  writeUserPreference: () => {},
}));

const { i18n } = await import('@/modules/i18n');

await new Promise<void>((resolve) => {
  if (i18n.isInitialized) resolve();
  else i18n.on('initialized', () => resolve());
});

test('startup fetches only the small auth strings, not the whole language the home screen never reads', () => {
  expect(i18n.language).toBe('zh-CN');
  expect(i18n.hasResourceBundle('zh-CN', 'auth')).toBe(true);
  for (const namespace of ['common', 'settings', 'chat', 'sidebar', 'codeEditor', 'tasks']) {
    expect(i18n.hasResourceBundle('zh-CN', namespace)).toBe(false);
  }
});

test('the active language still resolves to Chinese, so later screens fetch their own strings', async () => {
  // With no Chinese bundle loaded at all, i18next would resolve the language to English and report
  // every namespace as ready; components would then never ask for their translations.
  expect(i18n.resolvedLanguage).toBe('zh-CN');
  expect(i18n.hasLoadedNamespace('settings')).toBe(false);

  await i18n.loadNamespaces('settings');
  expect(i18n.hasResourceBundle('zh-CN', 'settings')).toBe(true);
  expect(i18n.t('settings:account.languageLabel')).not.toBe(i18n.t('settings:account.languageLabel', { lng: 'en' }));
});

test('the first IDE namespace brings its whole chunk, so screens mounted later never suspend for strings', () => {
  // Loaded by the previous test through `settings` alone.
  for (const namespace of ['common', 'chat', 'sidebar', 'codeEditor', 'tasks']) {
    expect(i18n.hasLoadedNamespace(namespace)).toBe(true);
  }
  // Simplified Chinese ships no git strings: an empty bundle, so the panel reads English without waiting.
  expect(i18n.hasLoadedNamespace('git')).toBe(true);
  expect(i18n.t('git:tabs.changes')).toBe('Changes');
});
