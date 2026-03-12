interface ExternalModulePageProps {
  src: string;
}

export function ExternalModulePage({ src }: ExternalModulePageProps) {
  return (
    <section className="overflow-hidden rounded-3xl border border-white/12 bg-[#0a111d]/90 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 text-xs text-slate-400">
        <span>Embedded module</span>
        <a
          href={src}
          className="rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 transition hover:border-cyan-200/40 hover:text-cyan-100"
        >
          Open full page
        </a>
      </div>
      <iframe
        src={src}
        title={`module-${src}`}
        className="h-[72vh] min-h-[560px] w-full border-0 bg-[#0a111d]"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </section>
  );
}
