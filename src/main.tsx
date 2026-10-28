import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/app.css";

import { queryClient } from "./api/hooks";
import { App } from "./App";
import { applyTheme, resolveTheme } from "./lib/themes";

// iOS Safari ignores user-scalable=no; cancelling WebKit's pinch gesture is the only way to block it.
if (navigator.maxTouchPoints > 0) document.addEventListener("gesturestart", (e) => e.preventDefault());

// The default theme until the saved one is read: the loading and pairing screens show it.
applyTheme(resolveTheme("system", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
