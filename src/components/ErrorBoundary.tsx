import { Component, type ReactNode } from 'react';

/** Keeps a rendering failure in one view from blanking the whole workspace. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    if (this.state.error) return <div className="notice bad" role="alert">This view failed to render: {this.state.error.message}. Your project is unchanged; switch views or reload. <button className="btn ghost" onClick={() => this.setState({ error: null })}>try again</button></div>;
    return this.props.children;
  }
}
