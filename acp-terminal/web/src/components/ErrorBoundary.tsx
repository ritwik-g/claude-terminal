import React from 'react';
import { Button, Icon } from '../ui';

interface ErrorBoundaryProps {
  /** Changing this key clears the error, e.g. when the user opens another session. */
  resetKey?: string | null;
  /** Optional way out, e.g. back to home; the only exit on mobile once the pane's own header is gone. */
  onLeave?: { label: string; run: () => void };
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
      <div className="shell-error" role="alert">
        <span className="shell-error-icon" aria-hidden>
          <Icon name="alert" size={20} />
        </span>
        <div className="shell-error-title">This view hit an error and stopped rendering</div>
        <p className="shell-error-desc">The rest of the app still works. Try again, or open another session.</p>
        <code className="shell-error-detail">{this.state.error.message}</code>
        <div className="shell-error-actions">
          {this.props.onLeave && (
            <Button variant="ghost" icon="home" onClick={this.props.onLeave.run}>
              {this.props.onLeave.label}
            </Button>
          )}
          <Button variant="secondary" icon="refresh" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
