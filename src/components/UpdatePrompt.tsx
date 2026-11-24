import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Update } from "@tauri-apps/plugin-updater";

import { queryClient } from "../api/hooks";
import { isLocal } from "../api/transport";
import { useIdle } from "../lib/motion";
import { ErrorBox, Markdown, Modal } from "./ui";

/** The version this app runs: a dev build keeps 0.1.0 in its config, so it goes by the newest release tag. */
export const devVersion = import.meta.env.DEV ? __DEV_TAG__?.replace(/^v/, "") : undefined;

let show: (u: Update) => void = () => {};

const NEWER = ["newerRelease"];
const EVERY = 15 * 60_000;

/** Asks GitHub for a newer release. Null when this is the latest. */
async function newer(): Promise<Update | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const u = await check();
  // The updater compares with 0.1.0 in a dev build: only a release past its tag is newer.
  return !u || (devVersion && u.version.localeCompare(devVersion, undefined, { numeric: true }) <= 0) ? null : u;
}

/** Asks GitHub for a newer release and, when there is one, opens the prompt to install it. Null when this is the latest. */
export async function checkUpdate(): Promise<Update | null> {
  const u = await newer();
  queryClient.setQueryData(NEWER, u);
  if (u) show(u);
  return u;
}

/** The newer release {@link UpdatePrompt} found, for the dots on the settings gear and the menu's update button. */
export const useNewerRelease = () => useQuery({ queryKey: NEWER, queryFn: newer, enabled: false }).data;

/** On launch, asks to install a newer release published on GitHub; `checkUpdate` asks again on demand.
 *  Then checks again every 15 minutes, only the dots telling of a find. */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const idle = useIdle();
  // Paused while idle or hidden, as the animations; back from idle past 15 minutes, it checks at once and the 15 minutes start over.
  // A find stops it: the update button checks again anyway.
  const found = useQuery({
    queryKey: NEWER,
    queryFn: newer,
    enabled: (q) => isLocal && !import.meta.env.DEV && !idle && !q.state.data,
    staleTime: EVERY,
    refetchInterval: EVERY,
    retry: false,
  });
  // Only the launch check opens the prompt; offline, the next launch tries again.
  const launched = useRef(false);
  useEffect(() => {
    if (found.isPending || launched.current) return;
    launched.current = true;
    if (found.data) setUpdate(found.data);
  }, [found.isPending]);

  useEffect(() => {
    show = setUpdate;
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
      sub={`You have ${devVersion ? `a dev build of ${devVersion}` : update.currentVersion}`}
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
