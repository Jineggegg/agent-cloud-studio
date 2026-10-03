import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { readModelDefaults, visibleModelCatalog } from '@/shared/modelDefaults';
import type { ProviderModelOption, ProviderModelsDefinition, StudioStatus, WorkbenchModelCatalogs } from '@/shared/types';

type ProviderModelsResponse = { success?: boolean; data?: { models?: ProviderModelsDefinition } };

// The agent's catalog as the menus show it: the user's hidden models removed, as the composer does.
async function loadAgentOptions(provider: 'claude' | 'codex'): Promise<ProviderModelOption[] | null> {
  const response = await api.providers.models(provider);
  const body = await response.json() as ProviderModelsResponse;
  if (!body.success || !body.data?.models) return null;
  return visibleModelCatalog(body.data.models, readModelDefaults()[provider]).OPTIONS;
}

/**
 * Used by WorkbenchChat: the model lists of the providers the open chat is not using, so its one model menu can
 * offer Claude Code, Codex and DeepSeek models side by side. `agents` reads the Claude Code and Codex catalogs (a
 * DeepSeek chat needs them), `deepseek` reads DeepSeek's models (an agent chat needs them); nothing is read while
 * both are off, i.e. once a session is open and its provider is fixed. A failed read leaves that part null, and
 * the menu then offers the provider with its default model.
 */
export function useWorkbenchModelCatalogs({ agents, deepseek }: { agents: boolean; deepseek: boolean }): WorkbenchModelCatalogs {
  // What has been read so far; each part stays null until its request answers.
  const [catalogs, setCatalogs] = useState<WorkbenchModelCatalogs>({ claude: null, codex: null, deepseek: null });

  useEffect(() => {
    if (!agents) return undefined;
    let alive = true;
    for (const provider of ['claude', 'codex'] as const) {
      loadAgentOptions(provider)
        .then((options) => { if (alive && options) setCatalogs((previous) => ({ ...previous, [provider]: options })); })
        .catch(() => undefined);
    }
    return () => { alive = false; };
  }, [agents]);

  useEffect(() => {
    if (!deepseek) return undefined;
    let alive = true;
    api.studio.status()
      .then(readApiJson<StudioStatus>)
      .then((status) => {
        if (alive) setCatalogs((previous) => ({ ...previous, deepseek: { configured: status.deepseek.configured, models: status.deepseek.models } }));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [deepseek]);

  return catalogs;
}
