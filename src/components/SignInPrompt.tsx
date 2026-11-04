import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAiCatalog } from "../api/hooks";
import { isLocal, rpc } from "../api/transport";
import { ErrorBox, Modal } from "./ui";

/** An AI CLI failed because its sign-in expired: offers to sign in again from here. */
export function SignInPrompt() {
  const qc = useQueryClient();
  // Set by the engine's aiSignedOut event (see useEngineEvents).
  const provider = useQuery<string | null>({ queryKey: ["aiSignedOut"], queryFn: () => null, enabled: false, staleTime: Infinity }).data;
  const name = useAiCatalog().data?.providers.find((p) => p.info.id === provider)?.info.name ?? provider;
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The terminal opens on the desktop: a phone leaves it to the desktop window.
  if (!isLocal || !provider) return null;

  const close = () => {
    qc.setQueryData(["aiSignedOut"], null);
    setOpened(false);
    setError(null);
  };
  const signIn = () => {
    setBusy(true);
    setError(null);
    rpc("ai.signIn", { id: provider })
      .then(() => setOpened(true), setError)
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title={`Sign in to ${name} again`}
      sub="Its sign-in expired, so Gitnetix could not run it"
      onClose={close}
      width={460}
      footer={
        opened ? (
          <button className="btn btn-primary btn-md" autoFocus onClick={close}>Done</button>
        ) : (
          <>
            <button className="btn btn-md" onClick={close}>Later</button>
            <button className="btn btn-primary btn-md" autoFocus disabled={busy} onClick={signIn}>
              {busy && <span className="spinner" />}
              Sign in
            </button>
          </>
        )
      }
    >
      {opened ? (
        <span>A terminal opened and started the sign-in. Finish it in your browser, then run the action again.</span>
      ) : (
        <span>
          Sign in opens a terminal running <span className="mono">{provider === "claude" ? "claude auth login" : provider}</span>, which opens your browser to sign in.
        </span>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}
