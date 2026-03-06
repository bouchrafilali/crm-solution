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
      <div style={{ padding: "24px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
        Mobile Lab error: {error}
      </div>
    );
  }

  if (!thread) {
    return (
      <div style={{ padding: "24px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
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
            color: "#dbeafe",
            background: "rgba(15, 23, 42, 0.78)",
            textDecoration: "none",
            border: "1px solid rgba(148, 163, 184, 0.35)",
            borderRadius: "8px",
            padding: "6px 8px"
          }}
        >
          Back to WhatsApp Intelligence
        </a>
      </div>
      <WhatsAppMobileLab thread={thread} mode={mode} />
    </>
  );
}
