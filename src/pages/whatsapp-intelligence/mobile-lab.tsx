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
        Loading mobile lab…
      </div>
    );
  }

  return (
    <>
      <div style={{ position: "fixed", top: 8, left: 8, zIndex: 20 }}>
        <a
          href="/admin/whatsapp-intelligence"
          style={{
            display: "inline-block",
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            fontSize: "12px",
            color: "#e8f5ff",
            background: "linear-gradient(180deg, rgba(20,36,60,.82) 0%, rgba(14,26,44,.75) 100%)",
            textDecoration: "none",
            border: "1px solid rgba(173, 209, 246, 0.35)",
            borderRadius: "999px",
            padding: "7px 11px",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)"
          }}
        >
          Back to WhatsApp Intelligence
        </a>
      </div>
      <WhatsAppMobileLab thread={thread} mode={mode} />
    </>
  );
}
