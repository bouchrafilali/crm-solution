import { ModuleRow, ModuleRowItem } from "./ModuleRow.js";

export interface ModuleSectionData {
  id: string;
  label: string;
  items: ModuleRowItem[];
}

export function ModuleSection({ section }: { section: ModuleSectionData }) {
  return (
    <section className="rounded-[22px] border border-white/10 bg-white/[0.03] p-3.5 backdrop-blur-xl md:p-4">
      <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{section.label}</p>
      <div className="mt-2.5 space-y-2.5">
        {section.items.map((item) => (
          <ModuleRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
