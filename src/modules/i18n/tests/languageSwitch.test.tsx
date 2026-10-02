import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, expect, test, vi } from 'vitest';

// Keep language switches local: the real preference store would try to sync with the server.
vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (_key: string, fallback: unknown) => fallback,
  subscribeToUserPreferences: () => () => {},
  writeUserPreference: () => {},
}));

const { i18n, LanguageSelector } = await import('@/modules/i18n');

afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage('en'); });
});

function SettingsProbe() {
  const { t } = useTranslation('settings');
  return <p>{t('account.languageLabel')}</p>;
}

test('a switch fetches the strings of the screens on display first, so they change in one step', async () => {
  // Rendered in English, which is bundled: nothing was fetched for `settings` yet.
  render(<SettingsProbe />);
  let settingsLoadedAtSwitch = false;
  const onLanguageChanged = () => { settingsLoadedAtSwitch = i18n.hasResourceBundle('de', 'settings'); };
  i18n.on('languageChanged', onLanguageChanged);

  await act(async () => { await i18n.changeLanguage('de'); });
  i18n.off('languageChanged', onLanguageChanged);

  // Without this the screen would re-render in German without its strings and suspend.
  expect(settingsLoadedAtSwitch).toBe(true);
  expect(screen.getByText(i18n.t('settings:account.languageLabel'))).toBeTruthy();
});

test('the language picker keeps the new choice, marked busy, while that language downloads', async () => {
  render(<LanguageSelector />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('en');

  fireEvent.change(select, { target: { value: 'ja' } });
  // i18next still reports English until the Japanese chunk arrives; the picker must not snap back.
  expect(i18n.language).toBe('en');
  expect(select.value).toBe('ja');
  expect(select.getAttribute('aria-busy')).toBe('true');

  await waitFor(() => expect(i18n.language).toBe('ja'));
  expect(select.value).toBe('ja');
  await waitFor(() => expect(select.getAttribute('aria-busy')).toBe('false'));
});
