import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker caches the app shell for offline launch and shows push notifications; dev
// builds skip registering it so Vite's hot reload is never served stale.
if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  // A tapped notification moves an open tab to the page it is about (the app routes by hash).
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "shipmate:navigate" || typeof data.url !== "string") return;
    const url = new URL(data.url, window.location.origin);
    if (url.origin === window.location.origin) window.location.hash = url.hash;
  });
}
