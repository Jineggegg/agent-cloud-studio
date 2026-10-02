import { useEffect, useState } from 'react';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import type { StudioMemoryNote, StudioMemoryRecent, StudioMemoryStatus } from '@/shared/types';
import { readableErrorMessage } from '@/shared/utils';

// Typing has to pause this long before a search is sent.
const SEARCH_DEBOUNCE_MS = 260;

const isAbort = (reason: unknown) => reason instanceof DOMException && reason.name === 'AbortError';
// A failed read as the app shows it; `offline` means the memory server itself is not running.
const failure = (reason: unknown, fallback: string) => ({
  message: readableErrorMessage(reason, fallback),
  offline: reason instanceof ApiRequestError && reason.code === 'MEMORY_UNAVAILABLE',
});

/**
 * Used by StudioMemory (the 记忆 app): loads the shared-memory status and the newest notes, runs debounced
 * searches (a newer keystroke cancels the older request, and nothing is sent while an input method is still
 * composing), filters by folder and removes notes.
 */
export function useStudioMemory() {
  // Reachability of the memory server and how each agent is wired; null until the first status read settles.
  const [status, setStatus] = useState<StudioMemoryStatus | null>(null);
  // Why the status could not be read at all (Studio itself unreachable); empty when it was read.
  const [statusError, setStatusError] = useState('');
  // The newest notes of the selected folder plus every folder; null while the first listing loads.
  const [recent, setRecent] = useState<StudioMemoryRecent | null>(null);
  // Why notes could not be listed or searched (server stopped, network); null when the last read worked.
  const [error, setError] = useState<{ message: string; offline: boolean } | null>(null);
  // The search box text; an empty box shows the newest notes instead of results.
  const [query, setQuery] = useState('');
  // True while an input method is composing (pinyin on iPad): the box shows the marked text, but nothing is
  // searched until the characters are chosen.
  const [composing, setComposing] = useState(false);
  // The folder chip in effect; undefined means every folder.
  const [folder, setFolder] = useState<string | undefined>(undefined);
  // Hits together with the query and folder they answer, so a stale answer is never shown for a newer query.
  const [results, setResults] = useState<{ query: string; folder: string | undefined; notes: StudioMemoryNote[] } | null>(null);
  // Bumped to read everything again (the app bar's refresh, a deleted note); every loader below depends on it.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let active = true;
    api.studio.memory.status().then(readApiJson<StudioMemoryStatus>).then(
      value => { if (active) { setStatus(value); setStatusError(''); } },
      reason => { if (active) setStatusError(readableErrorMessage(reason, '状态读取失败')); },
    );
    return () => { active = false; };
  }, [round]);

  useEffect(() => {
    const controller = new AbortController();
    api.studio.memory.recent(folder, controller.signal).then(readApiJson<StudioMemoryRecent>).then(
      listing => {
        if (controller.signal.aborted) return;
        setRecent(listing);
        setError(null);
      },
      reason => {
        if (isAbort(reason) || controller.signal.aborted) return;
        setRecent(previous => previous ?? { notes: [], folders: [], total: 0 });
        setError(failure(reason, '笔记读取失败'));
      },
    );
    return () => controller.abort();
  }, [folder, round]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed || composing) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.studio.memory.search(trimmed, folder, controller.signal).then(readApiJson<{ notes: StudioMemoryNote[] }>).then(
        value => {
          if (controller.signal.aborted) return;
          setResults({ query: trimmed, folder, notes: value.notes });
          setError(null);
        },
        reason => {
          if (isAbort(reason) || controller.signal.aborted) return;
          setResults({ query: trimmed, folder, notes: [] });
          setError(failure(reason, '搜索失败'));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [trimmed, folder, round, composing]);

  // The first word still being composed keeps the newest notes on screen rather than an empty "loading" list.
  const searching = trimmed.length > 0 && !(composing && results === null);
  const settled = results !== null && results.query === trimmed && results.folder === folder;
  return {
    status, statusError, recent, error, query, folder,
    searching,
    // True while the visible results do not answer the current query yet.
    searchPending: searching && !settled,
    // Results for the current query, or the previous query's results while the new search runs.
    results: searching ? results?.notes ?? null : null,
    setQuery,
    // Called on compositionstart/compositionend of the search box; see `composing`.
    setComposing,
    setFolder,
    refresh() {
      setRound(value => value + 1);
    },
    // Deletes a note on the server, drops it from the lists at once, then reads the lists again
    // (an older note moves up, an emptied folder disappears). Rejects with a readable error.
    async remove(note: StudioMemoryNote) {
      await api.studio.memory.remove(note.id).then(readApiJson<{ deleted: true }>);
      setRecent(previous => previous && { ...previous, notes: previous.notes.filter(item => item.id !== note.id), total: Math.max(0, previous.total - 1) });
      setResults(previous => previous && { ...previous, notes: previous.notes.filter(item => item.id !== note.id) });
      setRound(value => value + 1);
    },
  };
}
