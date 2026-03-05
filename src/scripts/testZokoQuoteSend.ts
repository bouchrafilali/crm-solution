import { sendTeamQuoteMessageDebug } from "../services/quoteRequestService.js";

async function main(): Promise<void> {
  const quoteRequestId = String(process.argv[2] || "").trim();
  if (!quoteRequestId) {
    console.log("Usage: npm run test:zoko-quote-send -- <quoteRequestId>");
    process.exitCode = 1;
    return;
  }

  const result = await sendTeamQuoteMessageDebug(quoteRequestId);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[test-zoko-quote-send] failed", error);
  process.exitCode = 1;
});
