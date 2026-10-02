import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubModule, HubProject, HubProjectInput, HubProvider, StudioGlyph } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

const MODULES: { id: HubModule; name: string; caption: string }[] = [
  { id: 'agents', name: 'AI 助手', caption: '在项目目录中启动 Claude / Codex 等' },
  { id: 'snr-lab', name: 'K 线实验室', caption: 'SNR 本地研究实验室' },
  { id: 'trading212', name: '股票分析', caption: 'Trading 212 只读账户看板' },
  { id: 'mail', name: '邮箱', caption: 'Gmail 只读搜索' },
  { id: 'automations', name: '自动化', caption: '草稿与一次性定时执行' },
];
const PROVIDERS: { id: HubProvider; name: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' }, { id: 'deepseek', name: 'DeepSeek' },
];
// Must match the server's allowed tones and glyphs.
const TONES: Record<string, string> = { sage: '青灰绿', clay: '陶土', slate: '石板蓝', graphite: '石墨', sand: '沙色', stone: '岩灰', moss: '苔绿', rose: '灰玫瑰' };
const GLYPHS: Record<StudioGlyph, string> = {
  folder: '文件夹', activity: '波形', graduation: '学位帽', candles: 'K 线', chart: '折线', mail: '邮件', terminal: '终端', sparkles: '星芒', book: '书', globe: '地球',
};
const EMPTY: HubProjectInput = { name: '', description: '', workspacePath: '', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'slate', glyph: 'folder' };

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
        <div className="ios-field ios-row-group"><label htmlFor={`${formId}-path`}>目录</label>
          <input id={`${formId}-path`} className="mono" maxLength={1000} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="/home/…/projects/…" value={form.workspacePath} onChange={event => setForm({ ...form, workspacePath: event.target.value })} /></div>
      </div>
      <p className="ios-section-footer">目录是 AI 助手工作的位置，使用这台电脑上的绝对路径（WSL 内，需位于用户主目录下）。留空则只能使用 DeepSeek 对话和集成模块。</p>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-icon`}>
      <div className="ios-section-header"><h2 id={`${formId}-icon`}>图标</h2></div>
      <div className="ios-list picker-list">
        <div className="tone-picker" role="radiogroup" aria-label="图标颜色">
          {Object.entries(TONES).map(([tone, label]) => <button key={tone} type="button" role="radio" aria-checked={form.tone === tone} aria-label={label} className={`tone-swatch tone-${tone}`} onClick={() => setForm({ ...form, tone })} />)}
        </div>
        <div className="glyph-picker" role="radiogroup" aria-label="图标符号">
          {(Object.entries(GLYPHS) as [StudioGlyph, string][]).map(([glyph, label]) => <button key={glyph} type="button" role="radio" aria-checked={form.glyph === glyph} aria-label={label} className="glyph-option" onClick={() => setForm({ ...form, glyph })}>
            <StudioTileIcon tone={form.glyph === glyph ? form.tone : 'ghost'} glyph={glyph} size={18} variant="small" />
          </button>)}
        </div>
      </div>
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
      <button className="ios-button filled" type="submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{project ? '保存项目' : '创建项目'}</button>
    </div>
    {onDelete && <section className="ios-section"><div className="ios-list">
      <button type="button" className="ios-row action destructive no-icon" disabled={busy} onClick={onDelete}>删除项目</button>
    </div><p className="ios-section-footer">只删除 Studio 中的项目设置、草稿和 DeepSeek 对话，不会删除电脑上的文件或开发工具里的会话。</p></section>}
  </form>;
}
