import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages, Loader2 } from 'lucide-react';

import { languages } from '@/modules/i18n/languages';

type LanguageSelectorProps = {
  compact?: boolean;
};

/**
 * Language Selector Component
 *
 * A dropdown component for selecting the application language.
 * Automatically updates the i18n language and persists it as a user preference.
 *
 * Used by the settings module (appearance tab) and the quick-settings-panel module
 * so the user can switch language from either surface.
 *
 * Props:
 * @param {boolean} compact - If true, uses compact style (default: false)
 */
export default function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation('settings');
  // The language just picked, while its strings download: non-English languages load on demand and
  // i18next keeps reporting the previous language until they arrive, so without this the controlled
  // select would snap back to the old choice and look ignored. Cleared once that switch settles.
  const [pendingLanguage, setPendingLanguage] = useState<string | null>(null);

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = event.target.value;
    setPendingLanguage(newLanguage);
    // Settled either way: after a failed download the select shows whatever language is in effect.
    // A newer pick made meanwhile keeps its own pending state.
    void i18n.changeLanguage(newLanguage).catch(() => undefined).finally(() => {
      setPendingLanguage(current => (current === newLanguage ? null : current));
    });
  };

  const isSwitching = pendingLanguage !== null;
  const selectedLanguage = pendingLanguage ?? i18n.language;
  const switchingIndicator = isSwitching
    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
    : null;

  // Compact style for QuickSettingsPanel
  if (compact) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-transparent bg-muted/50 p-3 transition-colors hover:border-border hover:bg-accent">
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t('account.language')}
        </span>
        <span className="flex items-center gap-2">
          {switchingIndicator}
          <select
            value={selectedLanguage}
            onChange={handleLanguageChange}
            aria-busy={isSwitching}
            className="w-auto min-w-[120px] max-w-[160px] rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {languages.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.nativeName}
              </option>
            ))}
          </select>
        </span>
      </div>
    );
  }

  // Full style for Settings page
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <div className="text-sm font-medium text-foreground">
          {t('account.languageLabel')}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t('account.languageDescription')}
        </div>
      </div>
      <span className="flex items-center gap-2">
        {switchingIndicator}
        <select
          value={selectedLanguage}
          onChange={handleLanguageChange}
          aria-busy={isSwitching}
          className="w-36 rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
        >
          {languages.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.nativeName}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
