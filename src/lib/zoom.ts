import { useEffect } from "react";

import { isLocal } from "../api/transport";
import { useStored } from "./stored";

const MAC = /Mac/.test(navigator.userAgent);
// Three Ctrl + steps up from the webview's 100%.
const DEFAULT_ZOOM = 1.3;

/** Ctrl (Cmd on macOS) + and - zoom the desktop window, 0 resets it; the level is kept between sessions. */
export function useZoomKeys() {
  const [zoom, setZoom] = useStored("gnx.zoom", DEFAULT_ZOOM, Number, String);
  useEffect(() => {
    if (!isLocal) return;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(zoom)).catch(() => {});
  }, [zoom]);
  useEffect(() => {
    if (!isLocal) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(MAC ? e.metaKey : e.ctrlKey) || e.altKey) return;
      const next = e.key === "+" || e.key === "=" ? zoom + 0.1 : e.key === "-" ? zoom - 0.1 : e.key === "0" ? DEFAULT_ZOOM : null;
      if (next === null) return;
      e.preventDefault();
      // Kept from the terminal, where Ctrl - is a control character.
      e.stopPropagation();
      setZoom(Math.min(2, Math.max(0.5, Math.round(next * 10) / 10)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
}
