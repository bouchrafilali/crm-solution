import { runQuoteApprovalScenario } from "../services/quoteRequestService.js";

type CliInput = {
  leadId: string;
  inboundText: string;
  decision?: "APPROVE" | "EDIT" | "READY";
};

function parseArgs(argv: string[]): CliInput | null {
  const leadId = String(argv[0] || "").trim();
  const inboundText = String(argv[1] || "").trim();
  const rawDecision = String(argv[2] || "").trim().toUpperCase();
  const decision =
    rawDecision === "APPROVE" || rawDecision === "EDIT" || rawDecision === "READY"
      ? rawDecision
      : undefined;
  if (!leadId || !inboundText) return null;
  return { leadId, inboundText, decision };
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (!input) {
    console.log("Usage: npm run simulate:quote-approval -- <leadId> \"<inbound text>\" [APPROVE|EDIT|READY]");
    process.exitCode = 1;
    return;
  }

  const result = await runQuoteApprovalScenario({
    leadId: input.leadId,
    inboundText: input.inboundText,
    ...(input.decision ? { approveDecision: input.decision } : {})
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("[simulate-quote-approval] failed", error);
  process.exitCode = 1;
});
