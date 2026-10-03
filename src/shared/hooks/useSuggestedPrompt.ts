import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useOptionalUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { PromptSuggestionAssistant, PromptSuggestionTurn } from '@/shared/types';

type UseSuggestedPromptArgs = {
  // The conversation on screen (session or conversation id); null for a new chat, which gets no suggestion.
  conversationKey: string | null;
  assistant: PromptSuggestionAssistant;
  // The conversation, oldest first; only its tail is sent.
  turns: PromptSuggestionTurn[];
  // False while a reply runs or a send is in flight: a suggestion is asked for only once the answer is complete.
  ready: boolean;
};

type SuggestionResponse = { suggestion: string | null };

// The composers send only the tail; the server clips each turn again before DeepSeek reads it.
const TURNS_SENT = 16;
const TURN_TEXT_SENT = 4000;
// Waits for the transcript to settle (the final message replacing the streamed one) before asking.
const SETTLE_MS = 700;
// Suggestions already fetched, by conversation state, so reopening a conversation does not ask again.
const MAX_CACHED = 100;
const cache = new Map<string, string | null>();

function remember(key: string, suggestion: string | null) {
  cache.set(key, suggestion);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

// The last answer keeps its end (where its question is); other turns keep their start.
function clipTurn(turn: PromptSuggestionTurn, isLast: boolean): PromptSuggestionTurn {
  if (turn.text.length <= TURN_TEXT_SENT) return turn;
  return { role: turn.role, text: isLast ? `…${turn.text.slice(-TURN_TEXT_SENT + 1)}` : `${turn.text.slice(0, TURN_TEXT_SENT - 1)}…` };
}

/**
 * Used by the workbench composers (Claude Code, Codex and DeepSeek) and the Studio DeepSeek chat: the suggested
 * next message shown faintly in the empty input once an answer is complete, which Send sends as it is. Asked once
 * per conversation state (cached for the page's life), cancelled when the conversation moves on, and off when the
 * owner turns 输入建议 off. A failed request just shows nothing.
 */
export function useSuggestedPrompt({ conversationKey, assistant, turns, ready }: UseSuggestedPromptArgs) {
  // Outside the preferences provider (isolated tests) there are no suggestions, and no requests.
  const enabled = useOptionalUiPreferences()?.suggestNextPrompt ?? false;
  const last = turns[turns.length - 1];
  // Identifies the conversation's state: a new answer (or an edit of the last one) is a new key.
  const key = conversationKey && last?.role === 'assistant'
    ? `${assistant}:${conversationKey}:${turns.length}:${last.text.length}:${last.text.slice(-48)}`
    : null;
  const tail = useMemo(
    () => turns.slice(-TURNS_SENT).map((turn, index, list) => clipTurn(turn, index === list.length - 1)),
    // The key changes whenever the tail that matters does; rebuilding on every render would refetch nothing anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  // The latest answer from the server, with the conversation state it answers (so a stale one is never shown).
  const [fetched, setFetched] = useState<{ key: string; suggestion: string | null } | null>(null);
  // Keys whose suggestion was sent or dismissed, so it does not reappear before the next answer.
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !ready || !key) return;
    if (cache.has(key)) {
      setFetched({ key, suggestion: cache.get(key) ?? null });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.studio.suggestions({ assistant, turns: tail }, controller.signal)
        .then((response) => readApiJson<SuggestionResponse>(response))
        .then((result) => {
          const suggestion = typeof result.suggestion === 'string' && result.suggestion.trim() ? result.suggestion.trim() : null;
          remember(key, suggestion);
          if (!controller.signal.aborted) setFetched({ key, suggestion });
        })
        .catch(() => {
          // Offline, signed out or cancelled: the composer simply shows its usual placeholder.
        });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [assistant, enabled, key, ready, tail]);

  const suggestion = enabled && ready && key && fetched?.key === key && dismissed !== key ? fetched.suggestion : null;
  // Hides the suggestion until the next answer, e.g. once it was sent or filled into the input.
  const dismiss = useCallback(() => { if (key) setDismissed(key); }, [key]);
  return { suggestion, dismiss };
}
