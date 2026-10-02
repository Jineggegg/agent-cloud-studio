import { ExternalLink, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { APP_VERSION } from '@/shared/constants';

// This modified version's source, and the upstream project whose AGPL-3.0 licence it carries forward.
const STUDIO_REPO_URL = 'https://github.com/Jineggegg/agent-cloud-studio';
const UPSTREAM_REPO_URL = 'https://github.com/siteboon/claudecodeui';

/** Rendered by Settings for the "about" tab: the app name and version, its source and the upstream licence attribution. */
export default function AboutTab() {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-foreground">Agent Cloud Studio</span>
          {APP_VERSION && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">v{APP_VERSION}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <a
          href={STUDIO_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary transition-colors hover:underline"
        >
          Agent Cloud Studio
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href={UPSTREAM_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary transition-colors hover:underline"
        >
          CloudCLI UI
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Licence attribution required by the AGPL terms in LICENSE; the same notice lives in Studio Settings → 关于. */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs text-muted-foreground/60">
          Modified from CloudCLI UI · {t('about.licensed')}
        </p>
      </div>
    </div>
  );
}
