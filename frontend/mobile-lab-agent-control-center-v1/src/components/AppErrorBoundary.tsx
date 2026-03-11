import { Component, ErrorInfo, ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[agent-control-center] render failure", { error, errorInfo });
  }

  handleReset = (): void => {
    this.setState({ hasError: false });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <section className="ml-panel rounded-2xl border border-rose-400/30 p-6">
        <p className="text-[10px] uppercase tracking-[0.14em] text-rose-200">Rendering Error</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-100">System Brain temporarily unavailable</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-400">
          A UI component failed to render. Use reset to return to dashboard and keep operating.
        </p>
        <button type="button" onClick={this.handleReset} className="ml-button-primary mt-4 rounded-lg px-3 py-1.5 text-xs">
          Reset to Dashboard
        </button>
      </section>
    );
  }
}
