import { ReactNode } from "react";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function SectionHeader({ title, subtitle, action }: SectionHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-4xl">
        <h2 className="text-lg font-semibold tracking-[0.02em] text-slate-50 sm:text-[1.35rem]">{title}</h2>
        {subtitle ? <p className="mt-1.5 text-[12px] leading-relaxed text-slate-400 sm:text-[13px]">{subtitle}</p> : null}
      </div>
      {action ? <div className="pt-0.5">{action}</div> : null}
    </div>
  );
}
