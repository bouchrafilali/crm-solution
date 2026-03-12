interface HeroSectionProps {
  moduleCount: number;
}

export function HeroSection({ moduleCount }: HeroSectionProps) {
  return (
    <section className="relative overflow-hidden rounded-[28px] border border-white/12 bg-white/[0.04] p-5 backdrop-blur-2xl md:p-7">
      <div className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="grid gap-5 lg:grid-cols-[1.6fr_0.85fr]">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Project Control Center</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-100 md:text-4xl">
            Central index for all project areas
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300 md:text-base">
            A simple, structured entry point to the platform.
          </p>
        </div>

        <aside className="rounded-3xl border border-white/10 bg-slate-900/35 p-4 backdrop-blur-xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">System Summary</p>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-3 py-2">
              <span className="text-slate-400">Modules</span>
              <span className="font-semibold text-slate-100">{moduleCount}</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-3 py-2">
              <span className="text-slate-400">Structure</span>
              <span className="font-semibold text-emerald-200">Structured</span>
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-3 py-2">
              <span className="text-slate-400">Navigation</span>
              <span className="font-semibold text-slate-100">Clear</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
