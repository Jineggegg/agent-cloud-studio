import { Sparkles } from 'lucide-react';

import { LLMProviderLogo } from '@/shared/ui';

/**
 * Used by the workbench chat column's header pill, empty state and assistant turn labels: the provider's mark in a
 * small paper disc. DeepSeek has no logo in the app, so it gets the Studio sparkle.
 */
export function WorkbenchProviderMark({ provider, size = 20 }: { provider: string; size?: number }) {
  return (
    <span className={`wbc-mark is-${provider}`} style={{ width: size, height: size }} aria-hidden="true">
      {provider === 'deepseek'
        ? <Sparkles size={Math.round(size * 0.6)} strokeWidth={2} />
        : <LLMProviderLogo provider={provider} className="wbc-mark-logo" />}
    </span>
  );
}
