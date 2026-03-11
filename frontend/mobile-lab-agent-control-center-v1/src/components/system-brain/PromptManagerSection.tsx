import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { PromptDefinitionRecord } from "../../system-brain-types.js";
import { SectionHeader } from "../SectionHeader.js";
import { StatusBadge } from "../StatusBadge.js";

export function PromptManagerSection({ prompts }: { prompts: PromptDefinitionRecord[] }) {
  const [activePromptId, setActivePromptId] = useState(prompts[0]?.id ?? "");
  const active = useMemo(() => prompts.find((item) => item.id === activePromptId) ?? prompts[0] ?? null, [prompts, activePromptId]);

  return (
    <section className="ml-panel rounded-2xl p-4">
      <SectionHeader
        title="Prompt Management + Versioning"
        subtitle="Active prompt controls, rollout visibility, version history, and instant rollback posture."
      />

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="ml-table-shell overflow-x-auto rounded-xl">
          <table className="ml-table w-full min-w-[760px] text-left text-xs">
            <thead>
              <tr>
                <th className="px-3 py-3">Prompt</th>
                <th className="px-3 py-3">Purpose</th>
                <th className="px-3 py-3">Active Version</th>
                <th className="px-3 py-3">Token Size</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((prompt) => {
                const activeVersion = prompt.versions.find((version) => version.environment === "production") ?? prompt.versions[0];
                return (
                  <tr key={prompt.id} className={activePromptId === prompt.id ? "bg-slate-800/35" : undefined}>
                    <td className="px-3 py-3">
                      <button type="button" onClick={() => setActivePromptId(prompt.id)} className="text-left">
                        <p className="font-semibold text-slate-100">{prompt.name}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{prompt.id}</p>
                      </button>
                    </td>
                    <td className="px-3 py-3 text-slate-400">{prompt.purpose}</td>
                    <td className="px-3 py-3"><StatusBadge value="active" /> <span className="ml-2 text-slate-300">{prompt.activeVersion}</span></td>
                    <td className="px-3 py-3 text-slate-300">{activeVersion?.tokenSize ?? "—"}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className="ml-button rounded-md px-2.5 py-1 text-[11px]">Preview</button>
                        <button type="button" className="ml-button rounded-md px-2.5 py-1 text-[11px]">Test</button>
                        <button type="button" className="ml-button rounded-md px-2.5 py-1 text-[11px]">Rollback</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <motion.aside key={active?.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="ml-panel-soft rounded-xl p-4">
          {active ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Version Timeline</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-100">{active.name}</h3>
              <div className="mt-3 space-y-2">
                {active.versions.map((version) => (
                  <article key={version.id} className="ml-panel rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-100">{version.version}</p>
                      <StatusBadge value={version.environment === "production" ? "active" : "pending"} />
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">{version.diffSummary}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {version.updatedBy} · {new Date(version.updatedAt).toLocaleString()}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {version.providerCompatibility.map((item) => (
                        <span key={item} className="ml-chip rounded-md px-2 py-0.5 text-[10px] text-slate-300">{item}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </motion.aside>
      </div>
    </section>
  );
}
