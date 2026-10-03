import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

import { IconChevronRight, IconMinus, IconPlus } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type {
  HubAutomationDefaults, HubModule, HubProduct, HubProject, HubProjectInput, HubProvider, StudioMailAccount, StudioMailAccounts, StudioRemoteHost,
} from '@/shared/types';
import { StudioIconPicker } from '@/modules/studio/StudioIconPicker';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import '@/modules/studio/studio-automations.css';

const MODULES: { id: HubModule; name: string; caption: string }[] = [
  { id: 'agents', name: 'AI 助手', caption: '在项目目录中启动 Claude / Codex 等' },
  { id: 'snr-lab', name: 'K 线实验室', caption: 'SNR 本地研究实验室' },
  { id: 'trading212', name: '股票分析', caption: 'Trading 212 只读账户看板' },
  { id: 'mail', name: '邮箱', caption: 'Gmail / Outlook 统一收件箱（只读）' },
  { id: 'automations', name: '自动化', caption: '用一句话安排定时提醒、邮件摘要和构建失败通知' },
];
// Every project has these; each product adds its own module in its own section (the server enforces the same).
const GENERIC_MODULES: HubModule[] = ['agents', 'automations'];
// What belongs only to one product: its module, and where its other settings live.
const PRODUCT_SECTIONS: Record<HubProduct, { title: string; module?: HubModule; note: string; settings?: string } | null> = {
  snr: { title: 'K 线实验室', module: 'snr-lab', note: 'SNR 3.0 的 K 线回放与研究实验室在这台电脑上运行，地址由服务器配置。关闭后项目里不再显示 K 线实验室。' },
  trading212: { title: '股票分析', module: 'trading212', note: 'Trading 212 的盈亏、曲线与持仓看板。', settings: '交易模式、下单上限和面容 ID 在「设置 → 交易安全」' },
  mail: { title: '邮箱', module: 'mail', note: '所有已连接邮箱的统一收件箱，只读。', settings: '添加或移除邮箱账户在「设置 → 邮箱」' },
  professor: null,
  custom: null,
};
const DEFAULT_AUTOMATION: HubAutomationDefaults = { notify: true, mailAccountId: '', morningTime: '08:00' };

// Older servers send no product: the built-ins are recognised by their integration, or 超级教授 by name or folder.
function productOf(project: HubProject | undefined): HubProduct {
  if (!project) return 'custom';
  if (project.product) return project.product;
  if (project.modules.includes('snr-lab')) return 'snr';
  if (project.modules.includes('trading212')) return 'trading212';
  if (project.name.trim() === '超级教授' || /\/super-professor\/?$/.test(project.workspacePath || project.remoteDir)) return 'professor';
  return project.modules.includes('mail') ? 'mail' : 'custom';
}

// A link to the Settings app inside the router; plain text where the editor is shown without one.
function SettingsHint({ text }: { text: string }) {
  if (!useInRouterContext()) return <p className="ios-section-footer">{text}。</p>;
  return <div className="ios-list product-settings-link"><Link className="ios-row no-icon" to="/apps/connections">
    <span className="ios-row-body"><strong>打开设置</strong><small>{text}</small></span><IconChevronRight size={18} className="chevron" aria-hidden="true" />
  </Link></div>;
}
// Cursor and OpenCode are not offered (OFFERED_AGENT_PROVIDERS); the server saves either as Claude Code.
const PROVIDERS: { id: HubProvider; name: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'deepseek', name: 'DeepSeek' },
];
// Must match the server's link limit.
const MAX_LINKS = 8;
const EMPTY: HubProjectInput = { name: '', description: '', workspacePath: '', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'slate', glyph: 'folder', links: [], remoteHost: '', remoteDir: '' };

/**
 * Used by StudioPage to create a project and by its 设置 tab to edit one; never touches secrets or the filesystem.
 * Only the settings that belong to the project's product are shown: every project has its name, place, links, icon,
 * models, AI 助手 / 自动化 and notification and automation defaults; SNR, Trading 212 and 邮件 add their own section.
 */
export function StudioProjectEditor({ project, onSaved, onCancel, onDelete }: {
  project?: HubProject; onSaved: (value: HubProject) => void; onCancel?: () => void; onDelete?: () => void;
}) {
  const formId = useId();
  const product = productOf(project);
  const productSection = PRODUCT_SECTIONS[product];
  // Generic modules, plus any other module this project already had (so an older project can switch it off).
  const moduleRows = MODULES.filter(module => GENERIC_MODULES.includes(module.id) || (module.id !== productSection?.module && project?.modules.includes(module.id)));
  // Changes remain local until explicitly saved.
  const [form, setForm] = useState<HubProjectInput>(project ?? EMPTY);
  // Saving locks the form and exposes only sanitized server errors.
  const [busy, setBusy] = useState(false);
  // Validation and transport failures remain next to the form.
  const [error, setError] = useState('');
  // SSH hosts the server allows; empty when none are configured, which hides the remote option.
  const [hosts, setHosts] = useState<StudioRemoteHost[]>([]);
  // Connected mailboxes, offered as the project's default mailbox for mail automations.
  const [mailAccounts, setMailAccounts] = useState<StudioMailAccount[]>([]);
  useEffect(() => {
    let active = true;
    void api.studio.remote.hosts().then(readApiJson<StudioRemoteHost[]>).then(value => { if (active) setHosts(value); }).catch(() => {});
    void Promise.resolve().then(() => api.studio.mail.accounts()).then(readApiJson<StudioMailAccounts>)
      .then(value => { if (active) setMailAccounts(value.accounts); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const automation = form.automation ?? project?.automation ?? DEFAULT_AUTOMATION;
  const setAutomation = (patch: Partial<HubAutomationDefaults>) => setForm({ ...form, automation: { ...automation, ...patch } });
  // A default mailbox removed since keeps its own option, so saving never silently changes it.
  const mailOptions = automation.mailAccountId && !mailAccounts.some(account => account.id === automation.mailAccountId)
    ? [...mailAccounts, { id: automation.mailAccountId, email: '已移除的邮箱' } as StudioMailAccount] : mailAccounts;
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
      <div className="ios-section-header"><h2 id={`${formId}-links`}>{product === 'professor' ? '教学网站' : '网站'}</h2><span className="caption">项目里的地球按钮快速打开</span></div>
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

    {productSection && <section className="ios-section" aria-labelledby={`${formId}-product`}>
      <div className="ios-section-header"><h2 id={`${formId}-product`}>{productSection.title}</h2></div>
      {productSection.module && <div className="ios-list">
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>在项目里显示</strong><small>{MODULES.find(module => module.id === productSection.module)?.caption}</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label={productSection.title} checked={form.modules.includes(productSection.module)}
            onChange={event => setForm({ ...form, modules: toggle(form.modules, productSection.module as HubModule, event.target.checked) })} />
        </label>
      </div>}
      <p className="ios-section-footer">{productSection.note}</p>
      {productSection.settings && <SettingsHint text={productSection.settings} />}
    </section>}

    <section className="ios-section" aria-labelledby={`${formId}-modules`}>
      <div className="ios-section-header"><h2 id={`${formId}-modules`}>功能</h2></div>
      <div className="ios-list">
        {moduleRows.map(module => <label className="ios-row no-icon switch-row" key={module.id}>
          <span className="ios-row-body"><strong>{module.name}</strong>
            <small>{GENERIC_MODULES.includes(module.id) ? module.caption : '不属于这个项目，关闭后不能再在这里开启'}</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label={module.name} checked={form.modules.includes(module.id)}
            onChange={event => setForm({ ...form, modules: toggle(form.modules, module.id, event.target.checked) })} />
        </label>)}
      </div>
    </section>

    <section className="ios-section" aria-labelledby={`${formId}-automation`}>
      <div className="ios-section-header"><h2 id={`${formId}-automation`}>通知与自动化</h2></div>
      <div className="ios-list">
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>自动化通知</strong><small>关闭后自动化照常运行，但不推送</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label="自动化通知" checked={automation.notify}
            onChange={event => setAutomation({ notify: event.target.checked })} />
        </label>
        <div className="ios-field"><label htmlFor={`${formId}-mailbox`}>默认邮箱</label>
          <select id={`${formId}-mailbox`} value={automation.mailAccountId} onChange={event => setAutomation({ mailAccountId: event.target.value })}>
            <option value="">每次选择</option>
            {mailOptions.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}
          </select></div>
        <div className="ios-field"><label htmlFor={`${formId}-morning`}>“早上”</label>
          <input id={`${formId}-morning`} type="time" required value={automation.morningTime} onChange={event => setAutomation({ morningTime: event.target.value })} /></div>
      </div>
      <p className="ios-section-footer">在「自动化」里用一句话创建时，没说用哪个邮箱就用默认邮箱，只说“早上”就按这个时间。</p>
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
