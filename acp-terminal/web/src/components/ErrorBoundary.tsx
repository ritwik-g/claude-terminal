import React from 'react';

interface ErrorBoundaryProps {
  /** Changing this key clears the error, e.g. when the user opens another session. */
  resetKey?: string | null;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a render error to the pane that threw it. Without this, one bad turn
 * payload unmounts the whole app and leaves a blank page.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-loading" style={{ flexDirection: 'column', gap: '10px' }}>
        <div style={{ fontWeight: 600, color: '#f87171' }}>This view hit an error and stopped rendering.</div>
        <code style={{ fontSize: '12px', maxWidth: '80%', whiteSpace: 'pre-wrap' }}>{this.state.error.message}</code>
        <button type="button" className="btn-action" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
