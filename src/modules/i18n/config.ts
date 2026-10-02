/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - English (the fallback) is bundled; every other language loads on demand, namespace by namespace
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import type { BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';

// English, bundled (see englishResources below).
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

// Every other language's JSON, loaded only when that language is in use. vite.config.js puts each
// language's `auth` namespace in a tiny chunk (locale-<code>-auth, needed on every route) and the
// rest in one chunk (locale-<code>, only the IDE reads it), so the IDE costs a single request.
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

// English is the fallback language and the default, so it ships with the app.
const englishResources = {
  common: enCommon,
  settings: enSettings,
  auth: enAuth,
  sidebar: enSidebar,
  chat: enChat,
  codeEditor: enCodeEditor,
  tasks: enTasks,
  git: enGit,
};

// Every namespace but `auth`: only IDE screens read them, and each language ships them in one chunk.
const IDE_NAMESPACES = Object.keys(englishResources).filter(namespace => namespace !== 'auth');

// All of a language's IDE namespaces at once (one chunk, so one request). A namespace the language
// does not ship (git, mostly) comes back empty; the English fallback fills those keys.
function loadIdeNamespaces(language: string) {
  return Promise.all(IDE_NAMESPACES.map(async (namespace) => {
    const load = lazyLocaleLoaders.get(`${language}/${namespace}`);
    return [namespace, load ? await load() : {}] as const;
  }));
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
    const fail = (error: unknown) => callback(error instanceof Error ? error : String(error), false);
    if (namespace === 'auth') {
      load().then((resources) => callback(null, resources), fail);
      return;
    }
    // The first IDE namespace brings the whole chunk, so store its siblings too: a screen that mounts
    // later (a settings dialog, the git panel) then finds its strings ready instead of suspending,
    // which would swap the whole IDE for its loading screen for a moment.
    loadIdeNamespaces(language).then((bundles) => {
      for (const [sibling, resources] of bundles) {
        if (sibling !== namespace && !i18n.hasResourceBundle(language, sibling)) {
          i18n.addResourceBundle(language, sibling, resources);
        }
      }
      callback(null, bundles.find(([loaded]) => loaded === namespace)?.[1] ?? {});
    }, fail);
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
  // This Studio is used in Chinese; a device with no saved choice starts there (the IDE can still switch).
  return 'zh-CN';
};

// Initialize i18next
i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Only English is bundled; the backend above supplies the active language when it is not English.
    resources: {
      en: englishResources,
    },
    partialBundledLanguages: true,

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces fetched at startup for a non-English language. Only `auth`: the auth provider is
    // mounted on every route and the sign-in screens read nothing else, while the Studio home reads
    // no strings at all. Every other namespace loads when a component first asks for it (the IDE's
    // screens suspend meanwhile), from one chunk per language (vite.config.js). The list must not be
    // empty: with nothing loaded for the active language i18next resolves it to English and would
    // then treat every namespace as ready, so later screens would never fetch their translations.
    ns: ['auth'],
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

// A language switch fetches the new language's strings before it takes effect, but only for the
// namespaces listed in `ns`, which starts as just `auth`. Screens that read English (bundled, so
// never fetched and never listed) would otherwise suspend for their strings right after the switch
// and flash a loading screen; listing every namespace a component has used (react-i18next records
// them) lets the switch fetch them first and change the whole screen in one step.
i18n.on('languageChanging', () => {
  const startupNamespaces = i18n.options.ns;
  if (!Array.isArray(startupNamespaces)) return;
  for (const namespace of i18n.reportNamespaces?.getUsedNamespaces() ?? []) {
    if (!startupNamespaces.includes(namespace)) startupNamespaces.push(namespace);
  }
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
