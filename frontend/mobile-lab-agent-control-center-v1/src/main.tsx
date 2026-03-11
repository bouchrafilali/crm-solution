import { createRoot } from "react-dom/client";
import { App } from "./app.js";

declare global {
  interface Window {
    __ACC_BOOTED__?: boolean;
    __ACC_BOOT_ERROR__?: string;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

try {
  createRoot(rootElement).render(<App />);
  window.__ACC_BOOTED__ = true;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown bootstrap error";
  window.__ACC_BOOT_ERROR__ = message;
  throw error;
}
