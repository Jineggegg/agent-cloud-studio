import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { EyeOff, LoaderCircle, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';

import { api } from '@/shared/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import { applyModelDefaults, MODEL_PROVIDERS, readModelDefaults, writeProviderModelPreferences } from '@/shared/modelDefaults';
import type { ProviderModelPreferences } from '@/shared/modelDefaults';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

const NAMES: Record<LLMProvider, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' };
const EFFORT_LABELS: Record<string, string> = {
  none: '不推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: 'Ultra', ultracode: 'Ultracode', thinking: '思考',
};
// Long catalogs (OpenCode lists over a hundred models) show this many until expanded.
const COLLAPSED_COUNT = 12;

type ModelsEnvelope = { success?: boolean; data?: { models?: ProviderModelsDefinition }; error?: { message?: string } };
// The custom model being added (no recordId) or edited.
type Draft = { recordId?: string | number; previousId?: string; id: string; name: string };

async function readEnvelope(response: Response) {
  const body = (await response.json().catch(() => ({}))) as ModelsEnvelope;
  if (!response.ok || body.success === false) throw new Error(body.error?.message || '操作失败');
  return body;
}

async function loadCatalog(provider: LLMProvider) {
  const body = await readEnvelope(await api.providers.models(provider));
  if (!body.data?.models) throw new Error('模型列表读取失败');
  return body.data.models;
}

/**
 * Used by StudioConnections (设置): each CLI's default model and reasoning effort for new sessions, and the model
 * list itself. Built-in models can be hidden from the menus and restored; models the user added can be edited and
 * deleted. Choices sync through the user's preferences (modelDefaults.ts).
 */
export function StudioSettingsModels() {
  const [provider, setProvider] = useState<LLMProvider>('claude');
  // The provider's full catalog (hidden models included); null while loading.
  const [catalog, setCatalog] = useState<ProviderModelsDefinition | null>(null);
  const [defaults, setDefaults] = useState(readModelDefaults);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ProviderModelOption | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => subscribeToUserPreferences(() => setDefaults(readModelDefaults())), []);
  useEffect(() => {
    let active = true;
    loadCatalog(provider).then(next => { if (active) setCatalog(next); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : '模型列表读取失败'); });
    return () => { active = false; };
  }, [provider]);

  const switchProvider = (next: LLMProvider) => {
    if (next === provider) return;
    setProvider(next); setCatalog(null); setError(''); setDraft(null); setExpanded(false);
  };

  const choice = defaults[provider] ?? {};
  const hidden = new Set(choice.hidden ?? []);
  const visible = catalog?.OPTIONS.filter(option => !hidden.has(option.value)) ?? [];
  const hiddenModels = catalog?.OPTIONS.filter(option => hidden.has(option.value)) ?? [];
  const isVisible = (value: string | undefined) => Boolean(value && visible.some(option => option.value === value));
  const defaultModel = [choice.model, catalog?.DEFAULT].find(isVisible) ?? visible[0]?.value ?? '';
  const efforts = visible.find(option => option.value === defaultModel)?.effort?.values ?? [];
  const effort = efforts.some(item => item.value === choice.effort) ? choice.effort! : 'default';
  const shown = expanded ? visible : visible.slice(0, COLLAPSED_COUNT);

  // Saving also makes the choice this device's starting point in the chat composer.
  const save = (change: ProviderModelPreferences) => { writeProviderModelPreferences(provider, change); applyModelDefaults(provider); };
  const chooseModel = (value: string) => {
    const keepsEffort = visible.find(option => option.value === value)?.effort?.values.some(item => item.value === choice.effort);
    save({ model: value, effort: keepsEffort ? choice.effort : undefined });
  };
  const hide = (option: ProviderModelOption) => save({
    hidden: [...hidden, option.value],
    ...(choice.model === option.value ? { model: undefined, effort: undefined } : {}),
  });
  const restore = (option: ProviderModelOption) => save({ hidden: [...hidden].filter(value => value !== option.value) });

  const mutate = async (operation: () => Promise<Response>, after?: () => void) => {
    setBusy(true); setError('');
    try {
      await readEnvelope(await operation());
      setCatalog(await loadCatalog(provider));
      setDraft(null);
      after?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const input = { id: draft.id.trim(), model: draft.name.trim() };
    void mutate(
      () => draft.recordId === undefined ? api.providers.createModel(provider, input) : api.providers.updateModel(provider, draft.recordId, input),
      // A renamed default keeps being the default.
      () => { if (draft.previousId && choice.model === draft.previousId) save({ model: input.id }); },
    );
  };
  const remove = (option: ProviderModelOption) => {
    setDeleting(null);
    if (option.recordId === undefined) return;
    void mutate(() => api.providers.deleteModel(provider, option.recordId!),
      () => { if (choice.model === option.value) save({ model: undefined, effort: undefined }); });
  };

  return <section className="ios-section" aria-labelledby="studio-models-heading">
    <div className="ios-section-header"><h2 id="studio-models-heading">模型</h2><span className="caption">新会话的默认设置</span></div>
    <div className="segmented model-providers" role="radiogroup" aria-label="CLI">
      {MODEL_PROVIDERS.map(item => <button type="button" role="radio" key={item} aria-checked={provider === item} onClick={() => switchProvider(item)}>{NAMES[item]}</button>)}
    </div>

    <div className="ios-list">
      {catalog === null && !error && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {catalog && <>
        <div className="ios-field">
          <label htmlFor="studio-default-model">默认模型</label>
          <select id="studio-default-model" value={defaultModel} onChange={event => chooseModel(event.target.value)}>
            {visible.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="ios-field">
          <label htmlFor="studio-default-effort">推理强度</label>
          <select id="studio-default-effort" value={effort} disabled={!efforts.length} onChange={event => save({ effort: event.target.value === 'default' ? undefined : event.target.value })}>
            <option value="default">{efforts.length ? '模型默认' : '这个模型不支持调节'}</option>
            {efforts.map(item => <option key={item.value} value={item.value}>{EFFORT_LABELS[item.value] ?? item.value}</option>)}
          </select>
        </div>
      </>}
    </div>
    {error && <p className="studio-feedback error" role="alert">{error}</p>}

    {catalog && <>
      <div className="ios-section-header"><h3>{NAMES[provider]} 模型</h3><span className="caption">{visible.length} 个可用</span></div>
      <div className="ios-list" role="list" aria-label={`${NAMES[provider]} 模型`}>
        {shown.map(option => draft?.recordId !== undefined && draft.recordId === option.recordId
          ? <ModelForm key={option.value} draft={draft} busy={busy} onChange={setDraft} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
          : <div className="ios-row no-icon" role="listitem" key={option.value}>
            <span className="ios-row-body"><strong>{option.label}</strong><small>{option.value}{option.isCustom ? ' · 自定义' : ''}</small></span>
            {option.value === defaultModel && <span className="status-badge good">默认</span>}
            {option.isCustom ? <>
              <button type="button" className="icon-button plain" aria-label={`编辑 ${option.label}`} disabled={busy}
                onClick={() => setDraft({ recordId: option.recordId, previousId: option.value, id: option.value, name: option.label })}><Pencil size={17} aria-hidden="true" /></button>
              <button type="button" className="icon-button danger" aria-label={`删除 ${option.label}`} disabled={busy} onClick={() => setDeleting(option)}><Trash2 size={17} aria-hidden="true" /></button>
            </> : <button type="button" className="icon-button plain" aria-label={`隐藏 ${option.label}`} disabled={busy || visible.length <= 1} onClick={() => hide(option)}>
              <EyeOff size={17} aria-hidden="true" /></button>}
          </div>)}
        {visible.length > COLLAPSED_COUNT && <button type="button" className="ios-row action left no-icon" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : `显示全部 ${visible.length} 个`}</button>}
        {draft && draft.recordId === undefined
          ? <ModelForm draft={draft} busy={busy} onChange={setDraft} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
          : <button type="button" className="ios-row action left no-icon" disabled={busy} onClick={() => setDraft({ id: '', name: '' })}>
            <Plus size={18} aria-hidden="true" />添加模型</button>}
      </div>

      {hiddenModels.length > 0 && <>
        <div className="ios-section-header"><h3>已隐藏</h3><span className="caption">不会出现在模型菜单里</span></div>
        <div className="ios-list" role="list" aria-label="已隐藏的模型">
          {hiddenModels.map(option => <div className="ios-row no-icon" role="listitem" key={option.value}>
            <span className="ios-row-body"><strong>{option.label}</strong><small>{option.value}</small></span>
            <button type="button" className="ios-button tinted" aria-label={`恢复 ${option.label}`} onClick={() => restore(option)}>
              <RotateCcw size={15} aria-hidden="true" />恢复</button>
          </div>)}
        </div>
      </>}
    </>}
    <p className="ios-section-footer">首页 Claude、Codex 小组件新建的会话使用这里的默认模型与推理强度；工作台里仍可随时切换。内置模型只能隐藏，随时可以恢复。</p>

    {deleting && <StudioConfirmSheet title={`删除「${deleting.label}」？`} message="使用这个模型的会话会改回默认模型。" confirmLabel="删除"
      onConfirm={() => remove(deleting)} onCancel={() => setDeleting(null)} />}
  </section>;
}

function ModelForm({ draft, busy, onChange, onSubmit, onCancel }: {
  draft: Draft; busy: boolean; onChange: (draft: Draft) => void; onSubmit: (event: FormEvent) => void; onCancel: () => void;
}) {
  const valid = Boolean(draft.id.trim()) && !/\s/.test(draft.id.trim()) && Boolean(draft.name.trim());
  return <form className="ios-row-group model-form" role="listitem" aria-label={draft.recordId === undefined ? '添加模型' : `编辑 ${draft.name}`} onSubmit={onSubmit}>
    <div className="ios-field">
      <label htmlFor="studio-model-id">模型 ID</label>
      <input id="studio-model-id" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={200} placeholder="例如 claude-opus-5-5" autoFocus
        value={draft.id} onChange={event => onChange({ ...draft, id: event.target.value })} />
    </div>
    <div className="ios-field">
      <label htmlFor="studio-model-name">名称</label>
      <input id="studio-model-name" maxLength={80} placeholder="菜单里显示的名字" value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} />
    </div>
    <div className="model-form-actions">
      <button type="button" className="ios-button" onClick={onCancel}>取消</button>
      <button className="ios-button filled" disabled={busy || !valid}>{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}保存</button>
    </div>
  </form>;
}
