import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode; label?: string; onHome?: () => void; fullPage?: boolean };
type State = { error: Error | null; stack: string };

/**
 * Catches render errors so a bug shows a readable message with a way out, instead of React
 * unmounting everything and leaving a black page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Voidcraft] ${this.props.label ?? 'App'} crashed:`, error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}${stack ? `\n\nComponent:${stack.split('\n').slice(0, 6).join('\n')}` : ''}`;
    return (
      <div className="crash" role="alert" style={this.props.fullPage ? { minHeight: '100vh' } : undefined}>
        <div className="crash-box">
          <h2>{this.props.label ? `${this.props.label} hit an error` : 'Voidcraft hit an error'}</h2>
          <p>Your saved projects are safe. Unsaved edits are kept in the autosave slot and offered for recovery when you reopen the project.</p>
          <pre>{details}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => this.setState({ error: null, stack: '' })}>
              Try again
            </button>
            {this.props.onHome && (
              <button
                className="btn"
                onClick={() => {
                  this.setState({ error: null, stack: '' });
                  this.props.onHome?.();
                }}
              >
                Go to Home
              </button>
            )}
            <button className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(details)}>
              Copy error
            </button>
          </div>
        </div>
      </div>
    );
  }
}
