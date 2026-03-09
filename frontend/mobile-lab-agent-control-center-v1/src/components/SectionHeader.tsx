import { ReactNode } from "react";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function SectionHeader({ title, subtitle, action }: SectionHeaderProps) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold tracking-wide text-zinc-100 sm:text-lg">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs text-zinc-400 sm:text-sm">{subtitle}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
