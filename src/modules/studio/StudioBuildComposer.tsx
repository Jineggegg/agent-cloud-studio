import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import { IconCheck, IconCopy, IconShieldExclamation, IconSparkles } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { StudioBuildCreated, StudioBuildEnvironment, StudioBuildNameSuggestion, StudioGlyph } from '@/shared/types';
import { StudioBuildProgress } from '@/modules/studio/StudioBuildProgress';
import { StudioIconPicker } from '@/modules/studio/StudioIconPicker';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import '@/modules/studio/studio-build-name.css';
import '@/modules/studio/studio-create-sheet.css';

// Must match the server's limits.
const MAX_NAME = 80;
const MAX_REQUEST = 8000;
// The character counter only appears once a description nears the limit.
const COUNTER_FROM = 7000;
// A name is suggested once the description has this many characters and the owner has paused typing this long.
const SUGGEST_FROM = 4;
const SUGGEST_DELAY_MS = 700;

type Draft = { name: string; prompt: string; tone: string; glyph: StudioGlyph };
const EMPTY: Draft = { name: '', prompt: '', tone: 'slate', glyph: 'sparkles' };
// An unsent draft survives closing the sheet (a stray tap on the scrim) and reloads, on this device only.
const DRAFT_KEY = 'studio-build-draft';

function readDraft(): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<Record<keyof Draft, unknown>> | null;
    if (!saved || typeof saved !== 'object') return EMPTY;
    const text = (value: unknown, fallback: string) => typeof value === 'string' ? value : fallback;
    return {
      name: text(saved.name, '').slice(0, MAX_NAME), prompt: text(saved.prompt, '').slice(0, MAX_REQUEST),
      tone: text(saved.tone, EMPTY.tone), glyph: text(saved.glyph, EMPTY.glyph) as StudioGlyph,
    };
  } catch {
    return EMPTY;
  }
}
function writeDraft(draft: Draft | null) {
  try {
    if (draft && (draft.name.trim() || draft.prompt.trim())) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage can be unavailable (private mode); the draft then simply lives as long as the sheet.
  }
}

// What the owner runs on the server to give builds Claude Code's OS sandbox (docs/ai-builds.md).
const SANDBOX_INSTALL = 'sudo apt-get install -y bubblewrap socat';
// The server setting that turns the sandbox on; it stays off until the owner has checked it (docs/ai-builds.md).
const SANDBOX_SETTING = 'STUDIO_BUILD_SANDBOX=on';
// What restricted mode leaves the agent, said the same way in every case.
const RESTRICTED_LIMITS = '这次 AI 只能写代码、写 README 并提交到本地，不能安装依赖、运行代码或测试。';
// How long the copy button shows its check mark.
const COPIED_MS = 1600;

// The closing note, true to how the server will run the build. Each is one string: a line break inside JSX text
// would put a space between two Chinese sentences.
const NOTE_INTRO = 'Claude Code 会在电脑的 projects 文件夹里新建一个 git 仓库：先列计划，再实现、写 README';
const NOTE_SANDBOX = `${NOTE_INTRO} 和测试，最后提交到本地。命令在沙箱里运行，只能写这个文件夹、只连软件包仓库，不会推送或发布；开发中随时点开图标，就能看它在做什么。`;
const NOTE_PENDING = `${NOTE_INTRO}，最后提交到本地。它只在这个文件夹里工作，不会推送或发布；开发中随时点开图标，就能看它在做什么。`;

/**
 * Restricted mode, said before the owner starts: what the build cannot do here and what is left to lift it — the
 * install command when the sandbox's packages are missing, then the one-time checks and the opt-in setting.
 */
function RestrictedNotice({ environment }: { environment: StudioBuildEnvironment }) {
  // The copy button's check mark after a successful copy.
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(SANDBOX_INSTALL);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // No clipboard (an insecure origin): the command stays selectable.
    }
  };
  const installable = environment.missing.length > 0;
  // Whether the sandbox can be turned on at all: installed now, or once the packages above are.
  const enableable = installable || environment.available === true;
  const situation = installable ? '服务器还没装沙箱组件，' : enableable ? '沙箱默认关闭，要先确认它在这台服务器上真的有效。' : '这台服务器不支持沙箱，';
  return <div className="build-env-notice" role="note" aria-labelledby="build-env-title">
    <IconShieldExclamation size={18} aria-hidden="true" />
    <div>
      <strong id="build-env-title" className="build-env-title">受限模式</strong>
      <p>{`${situation}${RESTRICTED_LIMITS}`}</p>
      {installable && <>
        <p>要在沙箱里完整开发，先在服务器上安装沙箱组件：</p>
        <div className="build-env-command">
          <code>{SANDBOX_INSTALL}</code>
          <button type="button" className="icon-button plain" aria-label={copied ? '已复制' : '复制命令'} title="复制命令" onClick={() => void copy()}>
            {copied ? <IconCheck size={16} className="copied-pop" aria-hidden="true" /> : <IconCopy size={16} aria-hidden="true" />}
          </button>
        </div>
      </>}
      {enableable && <p>
        {`${installable ? '装好后' : ''}按 docs/ai-builds.md 做一遍沙箱检查（读不到 ~/.ssh、写不了项目以外和 .git/hooks、连不上软件包仓库以外的网站），都通过后在服务器上设置 `}
        <code className="build-env-setting">{SANDBOX_SETTING}</code>
        {' 并重启 Studio。'}
      </p>}
    </div>
  </div>;
}

/**
 * Used by StudioPage inside the new-project sheet (让 AI 开发): describe an app, name it (or take the AI's suggested
 * name), pick its icon, and hand it to Claude Code. The preview icon dims and starts circling while the server
 * prepares the build, the same icon that then lands on the home screen. 开始开发 is always pressable: without a
 * description (or a name) it focuses that field and says what is missing instead of starting.
 */
export function StudioBuildComposer({ onStarted, onCancel }: { onStarted: (created: StudioBuildCreated) => void; onCancel: () => void }) {
  const formId = useId();
  // What the owner is writing; restored from this device's unsent draft and kept there until 开始开发 succeeds.
  const [draft, setDraft] = useState<Draft>(readDraft);
  useEffect(() => { writeDraft(draft); }, [draft]);
  // Starting locks the form while the server makes the folder, repository, project and session.
  const [busy, setBusy] = useState(false);
  // Validation and transport failures stay next to the form.
  const [error, setError] = useState('');
  // Whether builds on this server run sandboxed or restricted; null until known (or when the server cannot say).
  const [environment, setEnvironment] = useState<StudioBuildEnvironment | null>(null);
  useEffect(() => {
    let alive = true;
    // Called through a promise so a server (or test double) without the endpoint simply shows the neutral note.
    void Promise.resolve().then(() => api.studio.builds.environment()).then(readApiJson<StudioBuildEnvironment>)
      .then(next => { if (alive && (next?.mode === 'sandbox' || next?.mode === 'restricted')) setEnvironment(next); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const request = draft.prompt.trim();
  const typedName = draft.name.trim();
  // The AI's name for the latest description it was asked about (kept, not stored in the draft, until a newer one
  // arrives), shown as the name field's placeholder and used when the name is left empty.
  const [suggestion, setSuggestion] = useState('');
  // The description `suggestion` was made for, so the same text is never asked about twice.
  const suggestedFor = useRef<string | null>(null);
  // A suggestion request is on its way.
  const [suggesting, setSuggesting] = useState(false);
  const named = typedName !== '';
  useEffect(() => {
    // The suggestion itself is cleared by the keystroke that made the description this short (onPromptChange).
    if (Array.from(request).length < SUGGEST_FROM) {
      suggestedFor.current = null;
      return undefined;
    }
    // A typed name needs no suggestion, and this exact description already has one.
    if (named || suggestedFor.current === request) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSuggesting(true);
      // Called through a promise so a server (or test double) without the endpoint simply suggests nothing.
      void Promise.resolve().then(() => api.studio.builds.suggestName(request, controller.signal))
        .then(readApiJson<StudioBuildNameSuggestion>)
        .then(result => {
          const suggested = typeof result?.name === 'string' ? result.name.trim().slice(0, MAX_NAME) : '';
          // Newer input aborted this request; a late answer for the old description is dropped.
          if (controller.signal.aborted || !suggested) return;
          suggestedFor.current = request;
          setSuggestion(suggested);
        })
        .catch(() => {})
        .finally(() => { if (!controller.signal.aborted) setSuggesting(false); });
    }, SUGGEST_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      setSuggesting(false);
    };
  }, [request, named]);
  const name = typedName || suggestion;
  const adopt = () => setDraft(current => ({ ...current, name: suggestion }));

  // 开始开发 is never greyed out (a disabled button cannot say why). Pressed too early, it names what is missing
  // beside that field instead: the description first, even when a name is already there, then the name.
  const [missing, setMissing] = useState<'prompt' | 'name' | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameCardRef = useRef<HTMLDivElement>(null);
  // A name that turns up afterwards (typed, taken or suggested) answers the request by itself.
  const missingName = missing === 'name' && !name;
  const nudge = (field: 'prompt' | 'name') => {
    setMissing(field);
    (field === 'prompt' ? promptRef : nameRef).current?.focus();
    // A small sideways shake on the field's card, like a rejected passcode; skipped for reduced motion (and in
    // environments without the Web Animations API).
    const card = (field === 'prompt' ? promptCardRef : nameCardRef).current;
    if (!card || typeof card.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    card.animate(
      [{ transform: 'none' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }],
      { duration: 420, easing: 'ease-out' },
    );
  };

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!request) { nudge('prompt'); return; }
    if (!name) { nudge('name'); return; }
    setMissing(null);
    setBusy(true);
    setError('');
    try {
      const created = await api.studio.builds.create({ name, tone: draft.tone, glyph: draft.glyph, prompt: request })
        .then(readApiJson<StudioBuildCreated>);
      // The sheet closes on success, so the form is not unlocked again; the sent draft is no longer needed.
      writeDraft(null);
      onStarted(created);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法开始开发');
      setBusy(false);
    }
  }
  const onPromptChange = (prompt: string) => {
    setDraft({ ...draft, prompt });
    // Writing is the answer to 先用一句话写下想做什么, so the hint goes with the first keystroke.
    if (missing === 'prompt') setMissing(null);
    // Too short to name: the old suggestion goes rather than coming back for a different description later.
    if (Array.from(prompt.trim()).length < SUGGEST_FROM) setSuggestion('');
  };
  // ⌘/Ctrl + Return sends from the description, like the chat composers.
  const onPromptKeyDown =(event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void start(); }
  };
  // In the empty name field Return or Tab takes the suggestion (and stays put); with a name, Return starts the build.
  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The Return that confirms an input method's candidate (Safari reports it as key code 229) belongs to the IME.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const plain = !(event.shiftKey || event.altKey || event.metaKey || event.ctrlKey);
    if (plain && (event.key === 'Enter' || event.key === 'Tab') && !named && suggestion) {
      event.preventDefault();
      adopt();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (named) void start();
    }
  };

  // The form checks itself (noValidate): the browser's own bubble would pop up over the sheet in place of the hints.
  return <form className="project-form build-composer" noValidate onSubmit={event => void start(event)} aria-busy={busy}>
    <fieldset className="build-composer-fields" disabled={busy}>
      <section className="ios-section build-what" aria-labelledby={`${formId}-what`}>
        <div className="ios-section-header"><h2 id={`${formId}-what`}>想做什么</h2>
          {draft.prompt.length >= COUNTER_FROM && <span className="caption build-counter">{draft.prompt.length} / {MAX_REQUEST}</span>}</div>
        <div ref={promptCardRef} className="ios-list build-prompt-card" data-missing={missing === 'prompt' ? '' : undefined}>
          {/* The example is a placeholder, painted in the tertiary label colour (studio-create-sheet.css) so it never
              reads as text already written. */}
          <textarea ref={promptRef} className="build-prompt" aria-labelledby={`${formId}-what`} aria-describedby={`${formId}-what-hint ${formId}-what-missing`}
            aria-required="true" aria-invalid={missing === 'prompt' || undefined} maxLength={MAX_REQUEST} rows={6}
            placeholder="比如：一个记录每天喝水的网页。可以设定每日目标、一键打卡，看最近 7 天的柱状图，数据保存在浏览器里。"
            value={draft.prompt} onChange={event => onPromptChange(event.target.value)} onKeyDown={onPromptKeyDown} />
        </div>
        {/* Always mounted, so screen readers hear the hint when it appears. */}
        <p className="build-missing" id={`${formId}-what-missing`} aria-live="polite">{missing === 'prompt' ? '先用一句话写下想做什么' : ''}</p>
        <p className="ios-section-footer" id={`${formId}-what-hint`}>写清楚给谁用、要哪些功能、数据放在哪里，越具体越好。</p>
      </section>

      {/* Name and icon in one card: the preview on the left is the very icon (and label) that lands on the home
          screen, and it dims and circles while the server prepares the build. */}
      <section className="ios-section" aria-labelledby={`${formId}-look`}>
        <div className="ios-section-header"><h2 id={`${formId}-look`}>名称和图标</h2></div>
        <div className="ios-list build-look-card">
          <div className="build-look-top">
            <div className="build-composer-hero" aria-hidden="true">
              <span className="home-icon-wrap" data-build={busy ? 'queued' : undefined}>
                <StudioTileIcon tone={draft.tone} glyph={draft.glyph} size={30}>{busy && <StudioBuildProgress progress={{ value: 0, state: 'queued' }} />}</StudioTileIcon>
              </span>
              <span className="build-composer-name" data-suggested={!typedName && suggestion ? '' : undefined}>{name || '新 App'}</span>
            </div>
            <div ref={nameCardRef} className="build-look-name" data-missing={missingName ? '' : undefined}>
              <span className="build-look-label" id={`${formId}-name-title`}>名称</span>
              <div className="build-name-field">
                <input ref={nameRef} id={`${formId}-name`} aria-labelledby={`${formId}-name-title`} aria-describedby={`${formId}-name-hint ${formId}-name-missing`}
                  aria-invalid={missingName || undefined} maxLength={MAX_NAME}
                  placeholder={suggestion || '比如：喝水打卡'} value={draft.name} autoComplete="off" enterKeyHint={named ? 'go' : 'done'}
                  onChange={event => { setDraft({ ...draft, name: event.target.value }); if (missing === 'name') setMissing(null); }} onKeyDown={onNameKeyDown} />
                {suggesting
                  ? <span className="build-name-status" role="status"><StudioSpinner size={14} />正在起名…</span>
                  : !named && suggestion && <button type="button" className="build-name-adopt" aria-label={`采用「${suggestion}」`} title="按回车或 Tab 采用" onClick={adopt}>
                    <span aria-hidden="true">↵</span>采用</button>}
              </div>
              <p className="build-look-hint" id={`${formId}-name-hint`}>留空就用 AI 建议的名字。</p>
            </div>
          </div>
          <div className="build-look-picker" role="group" aria-label="图标">
            <StudioIconPicker inset tone={draft.tone} glyph={draft.glyph} onChange={patch => setDraft({ ...draft, ...patch })} />
          </div>
        </div>
        <p className="build-missing" id={`${formId}-name-missing`} aria-live="polite">
          {missingName ? (suggesting ? 'AI 正在起名，稍等一下，或者自己起一个' : '给它起个名字') : ''}</p>
      </section>
    </fieldset>

    {environment?.mode === 'restricted'
      ? <RestrictedNotice environment={environment} />
      : <p className="build-composer-note">{environment?.mode === 'sandbox' ? NOTE_SANDBOX : NOTE_PENDING}</p>}
    {error && <p role="alert" className="studio-feedback error">{error}</p>}
    {/* Pinned to the sheet's bottom edge (studio-create-sheet.css). 开始开发 stays pressable; while the server
        prepares, it shows its progress at full strength and ignores further presses. */}
    <div className="project-form-actions">
      <button className="ios-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button className="ios-button filled build-start" type="submit" aria-disabled={busy || undefined}>
        {busy ? <StudioSpinner size={16} /> : <IconSparkles size={17} aria-hidden="true" />}{busy ? '正在准备…' : '开始开发'}</button>
    </div>
  </form>;
}
