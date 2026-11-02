import { useEffect } from "react";

import { isLocal } from "../api/transport";
import { comboOf, DEFAULTS, MAC, useKeys } from "./keys";
import { useStored } from "./stored";

// Five Ctrl + steps up from the webview's 100%.
const DEFAULT_ZOOM = 1.5;

/** Ctrl (Cmd on macOS) + and - zoom the desktop window, 0 resets it (or the keys set for them); the level is kept between sessions. */
export function useZoomKeys() {
  const [zoom, setZoom] = useStored("gnx.zoom", DEFAULT_ZOOM, Number, String);
  const keys = useKeys();
  useEffect(() => {
    if (!isLocal) return;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(zoom)).catch(() => {});
  }, [zoom]);
  useEffect(() => {
    if (!isLocal) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("[data-keys-input]")) return;
      const k = comboOf(e);
      // Left as they come, they also go by the character, so + zooms wherever the layout has it (with Shift, on the numpad).
      const loose = (MAC ? e.metaKey : e.ctrlKey) && !e.altKey;
      const is = (id: string, chars: string) => k === keys[id] || (loose && keys[id] === DEFAULTS[id] && [...chars].includes(e.key));
      const next = is("zoomIn", "+=") ? zoom + 0.1 : is("zoomOut", "-") ? zoom - 0.1 : is("zoomReset", "0") ? DEFAULT_ZOOM : null;
      if (next === null) return;
      e.preventDefault();
      // Kept from the terminal, where Ctrl - is a control character.
      e.stopPropagation();
      setZoom(Math.min(2, Math.max(0.5, Math.round(next * 10) / 10)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [zoom, keys]); // eslint-disable-line react-hooks/exhaustive-deps
}
