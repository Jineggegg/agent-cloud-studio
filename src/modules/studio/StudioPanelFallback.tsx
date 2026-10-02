import { Component } from 'react';
import type { ReactNode } from 'react';

import '@/modules/studio/studio-perf.css';

/**
 * Used by lazyStudioPanel (studio module) as the Suspense fallback of a cold sub-app: an iOS-style
 * shimmer sketch of the screen it stands in for, so the layout does not jump when the app arrives.
 */
export function StudioPanelPlaceholder({ variant }: { variant: 'list' | 'form' | 'dashboard' | 'chat' }) {
  if (variant === 'chat') {
    return <div className="studio-chat-layout studio-perf-fade" role="status" aria-label="正在打开对话">
      <aside className="studio-chat-list" aria-hidden="true">
        <div className="skeleton-block studio-perf-chat-search" />
        <div className="studio-perf-chat-rows">{[0, 1, 2, 3].map(index => <div className="skeleton-block" key={index} />)}</div>
      </aside>
      <div className="studio-chat" aria-hidden="true">
        <div className="studio-perf-bubbles">
          <div className="skeleton-block is-user" />
          <div className="skeleton-block is-long" />
          <div className="skeleton-block is-user" />
        </div>
      </div>
    </div>;
  }
  return <div className="studio-skeleton studio-perf-skeleton studio-perf-fade" role="status" aria-label="正在加载">
    {variant === 'dashboard' && <>
      <div className="skeleton-block is-hero" />
      <div className="skeleton-block is-chart" />
      <div className="studio-perf-skeleton-stats"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /></div>
    </>}
    {variant === 'list' && <>
      <div className="studio-perf-skeleton-group"><div className="skeleton-block is-tall" /><div className="skeleton-block" /></div>
      <div className="skeleton-block is-caption" />
      <div className="studio-perf-skeleton-group"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /></div>
    </>}
    {variant === 'form' && <>
      <div className="studio-perf-skeleton-group"><div className="skeleton-block" /><div className="skeleton-block" /></div>
      <div className="studio-perf-skeleton-group"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /></div>
    </>}
  </div>;
}

type StudioPanelBoundaryState = { failed: boolean };

type StudioPanelBoundaryProps = {
  // Remounts the sub-app (lazyStudioPanel re-keys the boundary), downloading its chunk again if needed.
  onRetry: () => void;
  children: ReactNode;
};

/**
 * Used by lazyStudioPanel (studio module) around every sub-app: a chunk that cannot load (offline, or
 * the app was redeployed under new file names) or a sub-app that throws must not blank the whole
 * Studio; the home screen and navigation stay usable and the panel offers 重试, which tries the sub-app
 * again in place, and a full reload as the last resort.
 */
export class StudioPanelBoundary extends Component<StudioPanelBoundaryProps, StudioPanelBoundaryState> {
  // Whether this sub-app failed; switches the panel to a recoverable message.
  state: StudioPanelBoundaryState = { failed: false };

  static getDerivedStateFromError(): StudioPanelBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[Studio] sub-app failed to load or render', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="ios-empty" role="alert">
      <span>这个页面没能打开，可能是网络中断或 Studio 刚刚更新。</span>
      <button type="button" className="ios-button tinted" onClick={this.props.onRetry}>重试</button>
      <button type="button" className="ios-button" onClick={() => window.location.reload()}>重新加载</button>
    </div>;
  }
}
