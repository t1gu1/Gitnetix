import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import "@fontsource-variable/inter/index.css";
import "@fontsource/antonio/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles/app.css";

import { queryClient } from "./api/hooks";
import { App } from "./App";
import { applyTheme, DEFAULT_THEME, resolveTheme } from "./lib/themes";

// iOS Safari ignores user-scalable=no; cancelling WebKit's pinch gesture is the only way to block it.
if (navigator.maxTouchPoints > 0) document.addEventListener("gesturestart", (e) => e.preventDefault());

// WebKitGTK (the Linux app) draws its own overlay scrollbars above toasts and dialogs once scrollbar-width is set:
// flagged, it keeps the app's ::-webkit-scrollbar ones, which the page paints in order (app.css).
if (/Linux/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent)) document.documentElement.dataset.gtk = "";

// The default theme until the saved one is read: the loading and pairing screens show it.
applyTheme(resolveTheme(DEFAULT_THEME, "dark"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
