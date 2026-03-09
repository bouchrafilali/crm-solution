import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(<App />);
