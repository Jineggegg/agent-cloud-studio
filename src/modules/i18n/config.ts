/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - English (the fallback) is bundled; every other language loads on demand as one chunk
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import type { BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';

// English is the fallback language and the default, so it ships with the app.
import enCommon from '@/modules/i18n/locales/en/common.json';
import enSettings from '@/modules/i18n/locales/en/settings.json';
import enAuth from '@/modules/i18n/locales/en/auth.json';
import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import enChat from '@/modules/i18n/locales/en/chat.json';
import enCodeEditor from '@/modules/i18n/locales/en/codeEditor.json';
// oxlint-disable-next-line importx/order
import enTasks from '@/modules/i18n/locales/en/tasks.json';
// oxlint-disable-next-line importx/order
import enGit from '@/modules/i18n/locales/en/git.json';

// Import supported languages configuration
import { languages } from '@/modules/i18n/languages';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

// Every other language's JSON, loaded only when that language is in use. vite.config.js groups
// each language's namespaces into one chunk (locale-<code>), so switching costs one request.
// These files used to be bundled eagerly and made up over half of the app's entry script.
const lazyLocaleFiles = import.meta.glob<Record<string, unknown>>(
  ['@/modules/i18n/locales/*/*.json', '!@/modules/i18n/locales/en/*.json'],
  { import: 'default' },
);
const lazyLocaleLoaders = new Map<string, () => Promise<Record<string, unknown>>>();
for (const [path, load] of Object.entries(lazyLocaleFiles)) {
  const match = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (match) lazyLocaleLoaders.set(`${match[1]}/${match[2]}`, load);
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const load = lazyLocaleLoaders.get(`${language}/${namespace}`);
    // Not every language ships every namespace (git, or the bare "zh" i18next also tries); the
    // English fallback fills those keys, so an empty bundle is the right answer, not an error.
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (resources) => callback(null, resources),
      (error: unknown) => callback(error instanceof Error ? error : String(error), false),
    );
  },
};

// The chosen language lives in auth.db so it follows the user between devices.
// It is read synchronously from the preference mirror because i18n has to be
// configured at module load, long before any request could resolve.
const getSavedLanguage = (): string => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  // Validate that the saved language is supported
  if (saved && languages.some(lang => lang.value === saved)) {
    return saved;
  }
  return 'en';
};

// Initialize i18next
i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Only English is bundled; the backend above supplies the active language when it is not English.
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        auth: enAuth,
        sidebar: enSidebar,
        chat: enChat,
        codeEditor: enCodeEditor,
        tasks: enTasks,
        git: enGit,
      },
    },
    partialBundledLanguages: true,

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'git'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      // A component suspends until its namespaces exist in the active language, so a lazily
      // loaded language never flashes English first; App and the auth gate provide the boundaries.
      useSuspense: true,
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },
  });

// Save language preference when it changes
i18n.on('languageChanged', (lng: string) => {
  writeUserPreference('userLanguage', lng);
});

// A language chosen on another device arrives with the hydrated preferences,
// after i18n was already initialized with whatever the mirror held.
subscribeToUserPreferences(() => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  if (saved && saved !== i18n.language && languages.some(lang => lang.value === saved)) {
    void i18n.changeLanguage(saved);
  }
});

export default i18n;
