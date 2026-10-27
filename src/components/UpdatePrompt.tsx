import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

import { isLocal } from "../api/transport";
import { ErrorBox, Markdown, Modal } from "./ui";

/** On launch, asks to install a newer release published on GitHub. */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!isLocal || import.meta.env.DEV) return;
    let cancelled = false;
    import("@tauri-apps/plugin-updater")
      .then(({ check }) => check())
      .then((u) => !cancelled && setUpdate(u))
      // Offline or no release feed yet: try again next launch.
      .catch((e) => console.warn("update check failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  const install = async () => {
    setError(null);
    setProgress(0);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          if (total) setProgress(Math.min(99, Math.round((done / total) * 100)));
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(e);
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const close = () => !busy && setUpdate(null);

  return (
    <Modal
      title={`Gitnetix ${update.version} is available`}
      sub={`You have ${update.currentVersion}`}
      onClose={close}
      width={520}
      footer={
        <>
          <button className="btn btn-primary btn-md" disabled={busy} onClick={install}>
            {busy ? `Downloading… ${progress}%` : "Update and restart"}
          </button>
        </>
      }
    >
      {update.body ? <Markdown text={update.body} /> : <span className="muted">A new version is ready to install.</span>}
      <ErrorBox error={error} />
    </Modal>
  );
}
