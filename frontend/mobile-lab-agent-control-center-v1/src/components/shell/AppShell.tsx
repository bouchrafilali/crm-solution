import { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#070c16] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_10%_-5%,rgba(56,189,248,0.16),transparent_42%),radial-gradient(circle_at_95%_0%,rgba(16,185,129,0.14),transparent_36%),linear-gradient(180deg,#070c16_0%,#09101c_48%,#0a1220_100%)]" />
      <div className="relative">{children}</div>
    </div>
  );
}
