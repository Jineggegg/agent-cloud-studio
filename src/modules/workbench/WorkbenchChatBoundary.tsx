import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

type BoundaryProps = { children: ReactNode; onNewChat: () => void };
type BoundaryState = { error: Error | null };

/**
 * Used by the workbench shell around its chat column: a chat that throws while rendering leaves the sidebar and
 * inspector working and offers a reload or a fresh chat, instead of blanking the whole workbench.
 */
export class WorkbenchChatBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[workbench] chat column crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="wb-stage-empty" role="alert">
      <TriangleAlert size={30} strokeWidth={1.5} aria-hidden="true" />
      <h2>对话区出错了</h2>
      <p>{this.state.error.message || '渲染这段对话时发生错误。'}会话本身没有丢失。</p>
      <div className="wb-stage-actions">
        <button type="button" className="ios-button tinted" onClick={() => this.setState({ error: null })}>重新载入对话</button>
        <button type="button" className="ios-button" onClick={() => { this.setState({ error: null }); this.props.onNewChat(); }}>开始新会话</button>
      </div>
    </div>;
  }
}
