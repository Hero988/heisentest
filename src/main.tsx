import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";
import "./styles/global.css";
import { App } from "./app/App";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
