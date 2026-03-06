import { useEffect, useState } from "react";
import { WhatsAppMobileLab } from "../../components/whatsapp/WhatsAppMobileLab.js";
import {
  createLiveMobileLabDataSource,
  createMockMobileLabDataSource,
  type MobileLeadThread
} from "../../modules/whatsapp/mobileLabAdapter.js";

const mockSource = createMockMobileLabDataSource();
const liveSource = createLiveMobileLabDataSource();

function parseQuery(): { mode: "mock" | "live"; leadId: string } {
  if (typeof window === "undefined") return { mode: "mock", leadId: "" };
  const params = new URLSearchParams(window.location.search);
  const mode = String(params.get("mode") || "mock").trim().toLowerCase() === "live" ? "live" : "mock";
  const leadId = String(params.get("leadId") || "").trim();
  return { mode, leadId };
}

export default function WhatsAppIntelligenceMobileLabPage() {
  const [thread, setThread] = useState<MobileLeadThread | null>(null);
  const [error, setError] = useState<string>("");
  const [{ mode, leadId }] = useState(parseQuery);

  useEffect(() => {
    let mounted = true;
    const source = mode === "live" ? liveSource : mockSource;
    void source
      .getThread({ leadId })
      .then((data) => {
        if (!mounted) return;
        setThread(data);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "mobile_lab_seed_failed");
      });

    return () => {
      mounted = false;
    };
  }, [leadId, mode]);

  if (error) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: "linear-gradient(180deg, #050912 0%, #0a1220 100%)",
          color: "#dbeafe",
          padding: "24px",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        }}
      >
        Mobile Lab error: {error}
      </div>
    );
  }

  if (!thread) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: "linear-gradient(180deg, #050912 0%, #0a1220 100%)",
          color: "#dbeafe",
          padding: "24px",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        }}
      >
        Loading mobile lab...
      </div>
    );
  }

  return <WhatsAppMobileLab thread={thread} mode={mode} />;
}
