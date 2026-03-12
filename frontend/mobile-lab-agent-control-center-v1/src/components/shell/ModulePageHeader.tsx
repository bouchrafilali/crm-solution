import { BackToIndexButton } from "./BackToIndexButton.js";

interface ModulePageHeaderProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
}

export function ModulePageHeader({ title, subtitle, onBack }: ModulePageHeaderProps) {
  return (
    <header className="mb-4 rounded-3xl border border-white/12 bg-white/[0.05] p-4 backdrop-blur-2xl md:p-5">
      <BackToIndexButton onClick={onBack} />
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100 md:text-[30px]">{title}</h1>
      {subtitle ? <p className="mt-1.5 max-w-3xl text-sm text-slate-400 md:text-base">{subtitle}</p> : null}
    </header>
  );
}
