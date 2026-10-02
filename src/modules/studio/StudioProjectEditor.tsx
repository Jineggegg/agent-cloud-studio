import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Save } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, HubProjectInput } from '@/shared/types';

const MODULES = [{ id: 'agents', name: 'AI 助手' }, { id: 'mail', name: '邮箱' }, { id: 'automations', name: '自动化' }] as const;
const PROVIDERS = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'GPT / Codex' }] as const;

/** Used by StudioProjectOverview and StudioProjectPage to edit modular project configuration without secrets. */
export function StudioProjectEditor({ project, onSaved, onCancel }: { project?: HubProject; onSaved: (value: HubProject) => void; onCancel?: () => void }) {
  const formId = useId();
  // Changes remain local until explicitly saved.
  const [form, setForm] = useState<HubProjectInput>(project ?? { name: '', description: '', workspacePath: '', modules: ['agents', 'mail', 'automations'], providers: ['claude', 'codex'] });
  // Saving locks the form and exposes only sanitized server errors.
  const [busy, setBusy] = useState(false);
  // Validation and transport failures remain next to the form.
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = project ? await api.studio.projects.update(project.id, form) : await api.studio.projects.create(form);
      onSaved(await readApiJson<HubProject>(response));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目保存失败'); }
    finally { setBusy(false); }
  }
  return <form className="hub-form" onSubmit={event => void save(event)}>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="hub-field"><label htmlFor={`${formId}-name`}>项目名称</label><input id={`${formId}-name`} required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></div>
    <div className="hub-field"><label htmlFor={`${formId}-description`}>说明</label><textarea id={`${formId}-description`} maxLength={1000} rows={3} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
    <div className="hub-field"><label htmlFor={`${formId}-path`}>工作目录</label><input id={`${formId}-path`} value={form.workspacePath} maxLength={1000} placeholder="/home/…/projects/…" onChange={event => setForm({ ...form, workspacePath: event.target.value })} /></div>
    <fieldset><legend>项目模块</legend>{MODULES.map(module => <label className="hub-check" key={module.id}>
      <input type="checkbox" checked={form.modules.includes(module.id)} onChange={event => setForm({ ...form, modules: event.target.checked ? [...form.modules, module.id] : form.modules.filter(id => id !== module.id) })} />{module.name}
    </label>)}</fieldset>
    <fieldset><legend>助手</legend>{PROVIDERS.map(provider => <label className="hub-check" key={provider.id}>
      <input type="checkbox" checked={form.providers.includes(provider.id)} onChange={event => setForm({ ...form, providers: event.target.checked ? [...form.providers, provider.id] : form.providers.filter(id => id !== provider.id) })} />{provider.name}
    </label>)}</fieldset>
    <div className="hub-actions"><button disabled={busy} className="command-button primary" type="submit"><Save size={17} />{busy ? '保存中…' : '保存项目'}</button>
      {onCancel && <button className="command-button" type="button" disabled={busy} onClick={onCancel}>取消</button>}
    </div>
  </form>;
}
