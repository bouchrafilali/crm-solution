import { Component, ErrorInfo, ReactNode } from "react";

interface SectionErrorBoundaryProps {
  children: ReactNode;
  sectionName: string;
}

interface SectionErrorBoundaryState {
  hasError: boolean;
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, SectionErrorBoundaryState> {
  state: SectionErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SectionErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[system-brain] section render failure", {
      sectionName: this.props.sectionName,
      error,
      errorInfo
    });
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <section className="ml-panel rounded-2xl border border-rose-400/30 p-4">
        <p className="text-[10px] uppercase tracking-[0.14em] text-rose-200">Section Error</p>
        <h3 className="mt-1 text-sm font-semibold text-slate-100">{this.props.sectionName}</h3>
        <p className="mt-1 text-xs text-slate-400">This block failed to render. Check browser console for stack details.</p>
      </section>
    );
  }
}
