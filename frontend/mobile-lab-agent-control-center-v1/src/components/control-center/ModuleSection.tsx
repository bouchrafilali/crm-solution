import { ModuleRow, ModuleRowItem } from "./ModuleRow.js";

export interface ModuleSectionData {
  id: string;
  label: string;
  items: ModuleRowItem[];
}

export function ModuleSection({ section }: { section: ModuleSectionData }) {
  return (
    <section className="rounded-[26px] border border-white/12 bg-white/[0.04] p-4 backdrop-blur-2xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-400">{section.label}</p>
      <div className="mt-3 space-y-2.5">
        {section.items.map((item) => (
          <ModuleRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
