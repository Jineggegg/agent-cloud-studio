import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Cloud, Code2, ExternalLink, FolderGit2, LayoutDashboard, LogOut, MessageSquare, Plus, Plug, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { useAuth } from '@/modules/auth';
import { api } from '@/shared/api';
import { useStudio } from '@/modules/studio/hooks/useStudio';
import { StudioChat } from '@/modules/studio/StudioChat';
import { StudioConnections } from '@/modules/studio/StudioConnections';
import { StudioSnrView } from '@/modules/studio/StudioSnrView';
import '@/modules/studio/studio.css';

const NAV = [
  { id: 'home', label: '工作台', icon: LayoutDashboard },
  { id: 'chat', label: '对话', icon: MessageSquare },
  { id: 'snr', label: 'SNR 实验室', icon: Activity },
  { id: 'connections', label: '连接', icon: Plug },
] as const;
type View = typeof NAV[number]['id'];

/** Used by App as the mobile-first landing workspace while retaining the inherited IDE at /workspace. */
export function StudioPage() {
  const studio = useStudio();
  const { user, logout } = useAuth();
  // Peer destinations adapt from a sidebar on iPad to a bottom bar on phones.
  const [view, setView] = useState<View>('home');
  // History filtering is local and never changes saved conversation titles.
  const [search, setSearch] = useState('');
  const signOut = () => { void api.studio.closeSnr().finally(logout).catch(() => {}); };
  const openChat = async (id?: string) => {
    if (studio.sending) return;
    if (id) await studio.select(id); else studio.startNew();
    setView('chat');
  };
  const history = studio.history.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const title = NAV.find(item => item.id === view)?.label ?? '工作台';
  return <div className="studio">
    <aside className="studio-sidebar">
      <Link to="/" className="studio-brand" onClick={() => setView('home')}><span className="studio-mark"><Cloud size={24} /></span><span>Agent Cloud<span className="brand-subline">STUDIO</span></span></Link>
      <nav aria-label="主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}><Icon size={20} /><span>{label}</span>{id === 'connections' && !studio.status?.deepseek.configured && <span className="nav-indicator" />}</button>)}</nav>
      <div className="studio-sidebar-projects"><span className="studio-overline">项目</span><Link to="/workspace"><FolderGit2 size={17} />开发工具<ArrowRight size={15} /></Link><button onClick={() => setView('snr')}><Activity size={17} />SNR 3.0<span className={`small-dot ${studio.snr?.connected ? 'good' : ''}`} /></button></div>
      <div className="studio-account"><span className="avatar">{user?.username?.slice(0, 1).toUpperCase()}</span><div>{user?.username}<small>个人工作空间</small></div><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={signOut}><LogOut size={17} /></button></div>
    </aside>
    <main className={`studio-main ${view === 'chat' ? 'chat-view' : ''}`}>
      <header className="studio-header"><div><span className="studio-mobile-brand">Agent Cloud Studio</span><h1>{title}</h1></div><div className="header-actions"><span className="studio-private"><ShieldCheck size={15} />私有工作空间</span><button className="icon-button" aria-label="刷新状态" title="刷新状态" disabled={studio.loading} onClick={() => void studio.refresh()}><RefreshCw size={18} /></button>{view === 'chat' && <button className="icon-button" aria-label="新建对话" title="新建对话" disabled={studio.sending} onClick={() => void openChat()}><Plus size={20} /></button>}<button className="icon-button studio-mobile-logout" title="退出登录" aria-label="退出登录" onClick={signOut}><LogOut size={17} /></button></div></header>
      {studio.error && <div className="studio-alert" role="alert">{studio.error}<button onClick={() => void studio.refresh()}>重试</button></div>}
      {studio.loading ? <div className="studio-loading" role="status">正在连接工作台...</div> : <>
        {view === 'home' && <div className="studio-content">
          <div className="studio-greeting"><h2>你的工作空间</h2><span>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(new Date())}</span></div>
          <div className="studio-launchers">
            <button className="studio-launcher" onClick={() => void openChat()}><span className="connection-symbol deepseek"><MessageSquare size={24} /></span><div><h3>DeepSeek</h3><p>{studio.status?.deepseek.configured ? '新对话' : '待配置 API'}</p></div><ArrowRight size={18} /></button>
            <a className={`studio-launcher ${!studio.status?.agentWorkbenchUrl ? 'unavailable' : ''}`} href={studio.status?.agentWorkbenchUrl ?? undefined} target="_blank" rel="noreferrer"><span className="connection-symbol claude"><Code2 size={24} /></span><div><h3>Claude · Codex</h3><p>{studio.status?.agentWorkbenchUrl ? '订阅工作台' : '入口未配置'}</p></div><ExternalLink size={18} /></a>
            <button className="studio-launcher" onClick={() => setView('snr')}><span className="connection-symbol snr"><Activity size={24} /></span><div><h3>SNR 3.0</h3><p>{studio.snr?.connected ? '本地实验室在线' : '本地实验室离线'}</p></div><ArrowRight size={18} /></button>
          </div>
          <div className="studio-section-heading"><h2>最近对话</h2><button className="command-button" onClick={() => void openChat()}><Plus size={16} />新对话</button></div>
          <div className="studio-history-list">
            {history.slice(0, 6).map(item => <button className="history-row" key={item.id} onClick={() => void openChat(item.id)}><MessageSquare size={18} /><div><strong>{item.title}</strong><small>{item.model}</small></div><time>{new Date(item.updated_at).toLocaleDateString('zh-CN')}</time><ArrowRight size={16} /></button>)}
            {!history.length && <div className="studio-empty-row"><MessageSquare size={20} /><span>还没有保存的对话</span><button onClick={() => void openChat()}>新建</button></div>}
          </div>
          <div className="studio-section-heading"><h2>项目</h2><Link className="text-link" to="/workspace">开发工具<ArrowRight size={15} /></Link></div>
          <div className="studio-project-row"><span className="project-square"><FolderGit2 size={24} /></span><div><h3>Agent Cloud Studio</h3><p>个人分支 · 开发中</p></div><a className="icon-button" aria-label="打开 GitHub 仓库" title="打开 GitHub 仓库" href="https://github.com/Jineggegg/agent-cloud-studio" target="_blank" rel="noreferrer"><ExternalLink size={18} /></a></div>
          <button className="studio-project-row project-action" onClick={() => setView('snr')}><span className="project-square snr"><Activity size={24} /></span><div><h3>SNR 3.0 Strategy Laboratory</h3><p>HPA / EL / AOI · 研究阶段</p></div><span className={`status-label ${studio.snr?.connected ? 'good' : ''}`}>{studio.snr?.connected ? '在线' : '离线'}</span><ArrowRight size={18} /></button>
        </div>}
        {view === 'chat' && <div className="studio-chat-layout">
          <aside className="studio-chat-history"><input type="search" aria-label="搜索对话" placeholder="搜索对话" value={search} onChange={event => setSearch(event.target.value)} />
            <button className="command-button new-chat-button" disabled={studio.sending} onClick={() => void openChat()}><Plus size={17} />新对话</button>
            <div className="chat-history-scroll">{history.map(item => <div className={`chat-history-item ${studio.active?.id === item.id ? 'selected' : ''}`} key={item.id}><button disabled={studio.sending} onClick={() => void studio.select(item.id)}><strong>{item.title}</strong><small>{item.model}</small></button><button className="icon-button" title="删除对话" aria-label={`删除 ${item.title}`} disabled={studio.sending} onClick={() => { if (window.confirm('删除此对话及全部消息？')) void studio.remove(item.id); }}><Trash2 size={15} /></button></div>)}</div>
          </aside>
          <StudioChat active={studio.active} models={studio.status?.deepseek.models ?? ['deepseek-flash', 'deepseek-v4-pro']} sending={studio.sending} onSend={studio.send} onStop={studio.stop} />
        </div>}
        {view === 'snr' && <div className="studio-content">
          <div className="snr-title"><span className="connection-symbol snr"><Activity size={28} /></span><div><h2>SNR 3.0</h2><p>Strategy Laboratory</p></div><span className={`status-label ${studio.snr?.connected ? 'good' : ''}`}>{studio.snr?.connected ? '在线' : '离线'}</span></div>
          {!studio.snr?.connected && <p className="studio-feedback" role="status">{studio.snr?.reason ?? '未连接'}</p>}
          <div className="snr-facts"><div><span>研究阶段</span><strong>{studio.snr?.phase ? `Phase ${studio.snr.phase}` : '未知'}</strong></div><div><span>数据集</span><strong>{studio.snr?.connected ? studio.snr.datasetCount ?? 0 : '-'}</strong></div><div><span>策略规则</span><strong>{studio.snr?.connected ? studio.snr.rulesApproved ? '已批准' : '待审核' : '未知'}</strong></div><div><span>交易</span><strong>{studio.snr?.connected ? studio.snr.tradingEnabled ? '已启用' : '未启用' : '未知'}</strong></div></div>
          <div className="studio-section-heading"><h2>研究工作区</h2><span>登录保护</span></div>
          {['行情回放与图表标注', 'HPA / EL / SNR AOI', '纠正记录与样本库', 'Wiki 规则审核'].map((label, index) => <div className="snr-research-row" key={label}><span className="snr-row-number">0{index + 1}</span><span>{label}</span><span className="status-label">开发中</span></div>)}
          <div className="snr-actions"><StudioSnrView connected={Boolean(studio.snr?.connected)} />{studio.status?.snrRemoteUrl && <a className="command-button" href={studio.status.snrRemoteUrl} target="_blank" rel="noreferrer">独立入口<ExternalLink size={16} /></a>}</div>
          <div className="studio-boundary"><ShieldCheck size={18} /><span>规则未审批 · 不自动训练 · 不执行交易</span></div>
        </div>}
        {view === 'connections' && <div className="studio-content"><StudioConnections status={studio.status} onChange={studio.refresh} /></div>}
      </>}
      <nav className="studio-bottom-nav" aria-label="移动主导航">{NAV.map(({ id, label, icon: Icon }) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}><Icon size={22} /><span>{label}</span></button>)}</nav>
    </main>
  </div>;
}
