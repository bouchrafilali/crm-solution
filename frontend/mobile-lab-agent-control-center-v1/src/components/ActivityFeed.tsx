import { ActivityEvent, Agent, Lead, RunRecord } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

interface ActivityFeedProps {
  events: ActivityEvent[];
  runs: RunRecord[];
  leads: Lead[];
  agents: Agent[];
  onOpenLead: (leadId: string) => void;
}

function mapDefaultAgent(eventType: ActivityEvent["type"]): string {
  if (eventType === "orchestrator") return "Orchestrator Agent";
  if (eventType === "advisor") return "Strategic Advisor Agent";
  if (eventType === "reply") return "Reply Draft Agent";
  if (eventType === "approval") return "Human Approval Agent";
  if (eventType === "learning") return "Learning Loop Agent";
  if (eventType === "blocked") return "Orchestrator Agent";
  return "Ingress";
}

function mapDefaultStatus(eventType: ActivityEvent["type"]): string {
  if (eventType === "approval") return "waiting_human_approval";
  if (eventType === "blocked") return "blocked";
  return "success";
}

function toEventTypeLabel(type: ActivityEvent["type"]): string {
  return type.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function ActivityFeed({ events, runs, leads, agents, onOpenLead }: ActivityFeedProps) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <div className="ml-table-shell overflow-hidden rounded-xl">
      <div className="max-h-[420px] overflow-y-auto scroll-dark">
        <table className="ml-table w-full min-w-[900px] text-left text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3">Time</th>
              <th className="px-3 py-3">Event Type</th>
              <th className="px-3 py-3">Lead</th>
              <th className="px-3 py-3">Agent</th>
              <th className="px-3 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const relatedRun = runs.find((run) => run.leadId === event.leadId && run.timestamp.includes(event.timestamp))
                ?? runs.find((run) => run.leadId === event.leadId);

              const leadName = leadById.get(event.leadId)?.name ?? event.leadId;
              const agentName = relatedRun ? (agentById.get(relatedRun.triggeredAgentId)?.name ?? relatedRun.triggeredAgentId) : mapDefaultAgent(event.type);
              const status = relatedRun?.status ?? mapDefaultStatus(event.type);

              return (
                <tr key={event.id} className="cursor-pointer transition" onClick={() => onOpenLead(event.leadId)}>
                  <td className="ml-code px-3 py-3 text-[11px] text-slate-400">{event.timestamp}</td>
                  <td className="px-3 py-3 text-slate-300">{toEventTypeLabel(event.type)}</td>
                  <td className="px-3 py-3">
                    <p className="font-semibold text-slate-100">{leadName}</p>
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{event.detail}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-300">{agentName}</td>
                  <td className="px-3 py-3">
                    <StatusBadge value={status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
