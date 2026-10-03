import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { IconMinus, IconPlus } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { HubModule, HubProject, HubProjectInput, HubProvider, StudioRemoteHost } from '@/shared/types';
import { StudioIconPicker } from '@/modules/studio/StudioIconPicker';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

const MODULES: { id: HubModule; name: string; caption: string }[] = [
  { id: 'agents', name: 'AI 助手', caption: '在项目目录中启动 Claude / Codex 等' },
  { id: 'snr-lab', name: 'K 线实验室', caption: 'SNR 本地研究实验室' },
  { id: 'trading212', name: '股票分析', caption: 'Trading 212 只读账户看板' },
  { id: 'mail', name: '邮箱', caption: 'Gmail / Outlook 统一收件箱（只读）' },
  { id: 'automations', name: '自动化', caption: '草稿与一次性定时执行' },
];
const PROVIDERS: { id: HubProvider; name: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' }, { id: 'deepseek', name: 'DeepSeek' },
];
// Must match the server's link limit.
const MAX_LINKS = 8;
const EMPTY: HubProjectInput = { name: '', description: '', workspacePath: '', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'slate', glyph: 'folder', links: [], remoteHost: '', remoteDir: '' };

/** Used by StudioPage to create a project and by its settings tab to edit one; never touches secrets or the filesystem. */
export function StudioProjectEditor({ project, onSaved, onCancel, onDelete }: {
  project?: HubProject; onSaved: (value: HubProject) => void; onCancel?: () => void; onDelete?: () => void;
}) {
  const formId = useId();
  // Changes remain local until explicitly saved.
  const [form, setForm] = useState<HubProjectInput>(project ?? EMPTY);
  // Saving locks the form and exposes only sanitized server errors.
  const [busy, setBusy] = useState(false);
  // Validation and transport failures remain next to the form.
  const [error, setError] = useState('');
  // SSH hosts the server allows; empty when none are configured, which hides the remote option.
  const [hosts, setHosts] = useState<StudioRemoteHost[]>([]);
  useEffect(() => {
    let active = true;
    void api.studio.remote.hosts().then(readApiJson<StudioRemoteHost[]>).then(value => { if (active) setHosts(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const setLink = (index: number, patch: Partial<HubProjectInput['links'][number]>) =>
    setForm({ ...form, links: form.links.map((link, position) => position === index ? { ...link, ...patch } : link) });
  // A host saved earlier but no longer configured stays selectable so saving does not silently move the project.
  const hostOptions = form.remoteHost && !hosts.some(host => host.name === form.remoteHost) ? [...hosts, { name: form.remoteHost, label: form.remoteHost, target: '' }] : hosts;
  const toggle = <T extends string>(list: T[], value: T, on: boolean) => on ? [...list, value] : list.filter(item => item !== value);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = project ? await api.studio.projects.update(project.id, form) : await api.studio.projects.create(form);
      onSaved(await readApiJson<HubProject>(response));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目保存失败'); }
    finally { setBusy(false); }
  }

  return <form className="project-form" onSubmit={event => void save(event)}>
    <div className="project-form-preview" aria-hidden="true">
      <StudioTileIcon tone={form.tone} glyph={form.glyph} size={36} />
      <span>{form.name || '新项目'}</span>
    </div>

    <section className="ios-section">
      <div className="ios-list">
        <div className="ios-field"><label htmlFor={`${formId}-name`}>名称</label>
          <input id={`${formId}-name`} required maxLength={80} placeholder="项目名称" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></div>
        <div className="ios-field ios-row-group"><label htmlFor={`${formId}-description`}>说明</label>
          <input id={`${formId}-description`} maxLength={1000} placeholder="可选" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></div>
      </div>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-where`}>
      <div className="ios-section-header"><h2 id={`${formId}-where`}>运行位置</h2>
        {hostOptions.length > 0 && <div className="segmented" role="radiogroup" aria-label="运行位置">
          <button type="button" role="radio" aria-checked={!form.remoteHost} onClick={() => setForm({ ...form, remoteHost: '', remoteDir: '' })}>本机</button>
          {hostOptions.map(host => <button type="button" role="radio" key={host.name} aria-checked={form.remoteHost === host.name} onClick={() => setForm({ ...form, remoteHost: host.name })}>{host.label}</button>)}
        </div>}
      </div>
      <div className="ios-list">
        {form.remoteHost
          ? <div className="ios-field"><label htmlFor={`${formId}-remote-dir`}>远程目录</label>
            <input id={`${formId}-remote-dir`} className="mono" maxLength={300} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="~/projects/…" value={form.remoteDir} onChange={event => setForm({ ...form, remoteDir: event.target.value })} /></div>
          : <div className="ios-field"><label htmlFor={`${formId}-path`}>目录</label>
            <input id={`${formId}-path`} className="mono" maxLength={1000} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="/home/…/projects/…" value={form.workspacePath} onChange={event => setForm({ ...form, workspacePath: event.target.value })} /></div>}
      </div>
      <p className="ios-section-footer">{form.remoteHost
        ? 'AI 助手通过 Tailscale + SSH 在这台主机上运行，使用以 ~ 或 / 开头的路径。会话运行在 tmux 里，断开后可接回。'
        : '目录是 AI 助手工作的位置，使用这台电脑上的绝对路径（WSL 内，需位于用户主目录下）。留空则只能使用 DeepSeek 对话和集成模块。'}</p>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-links`}>
      <div className="ios-section-header"><h2 id={`${formId}-links`}>网站</h2><span className="caption">项目里的地球按钮快速打开</span></div>
      <div className="ios-list">
        {form.links.map((link, index) => <div className="ios-field link-field" key={index}>
          <input aria-label={`网站 ${index + 1} 名称`} className="link-field-label" required maxLength={40} placeholder="名称" value={link.label} onChange={event => setLink(index, { label: event.target.value })} />
          <input aria-label={`网站 ${index + 1} 地址`} className="mono" type="url" required maxLength={500} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://…" value={link.url} onChange={event => setLink(index, { url: event.target.value })} />
          <button type="button" className="icon-button danger" aria-label={`删除网站 ${link.label || index + 1}`} onClick={() => setForm({ ...form, links: form.links.filter((_, position) => position !== index) })}><IconMinus size={18} aria-hidden="true" /></button>
        </div>)}
        <button type="button" className="ios-row action no-icon" disabled={form.links.length >= MAX_LINKS} onClick={() => setForm({ ...form, links: [...form.links, { label: '', url: '' }] })}>
          <IconPlus size={18} aria-hidden="true" />添加网站</button>
      </div>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-icon`}>
      <div className="ios-section-header"><h2 id={`${formId}-icon`}>图标</h2></div>
      <StudioIconPicker tone={form.tone} glyph={form.glyph} onChange={patch => setForm({ ...form, ...patch })} />
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-models`}>
      <div className="ios-section-header"><h2 id={`${formId}-models`}>模型</h2><span className="caption">只在本项目内可用</span></div>
      <div className="ios-list">
        {PROVIDERS.map(provider => <label className="ios-row no-icon switch-row" key={provider.id}>
          <span className="ios-row-body"><strong>{provider.name}</strong></span>
          <input type="checkbox" role="switch" className="ios-switch" checked={form.providers.includes(provider.id)}
            onChange={event => setForm({ ...form, providers: toggle(form.providers, provider.id, event.target.checked) })} />
        </label>)}
      </div>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-modules`}>
      <div className="ios-section-header"><h2 id={`${formId}-modules`}>模块</h2></div>
      <div className="ios-list">
        {MODULES.map(module => <label className="ios-row no-icon switch-row" key={module.id}>
          <span className="ios-row-body"><strong>{module.name}</strong><small>{module.caption}</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label={module.name} checked={form.modules.includes(module.id)}
            onChange={event => setForm({ ...form, modules: toggle(form.modules, module.id, event.target.checked) })} />
        </label>)}
      </div>
    </section>

    {error && <p role="alert" className="studio-feedback error">{error}</p>}
    <div className="project-form-actions">
      {onCancel && <button className="ios-button" type="button" disabled={busy} onClick={onCancel}>取消</button>}
      <button className="ios-button filled" type="submit" disabled={busy}>{busy && <StudioSpinner size={16} />}{project ? '保存项目' : '创建项目'}</button>
    </div>
    {onDelete && <section className="ios-section"><div className="ios-list">
      <button type="button" className="ios-row action destructive no-icon" disabled={busy} onClick={onDelete}>删除项目</button>
    </div><p className="ios-section-footer">只删除 Studio 中的项目设置、草稿和 DeepSeek 对话，不会删除电脑上的文件或工作台里的会话。</p></section>}
  </form>;
}
