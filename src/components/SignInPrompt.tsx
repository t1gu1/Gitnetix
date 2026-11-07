import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAiCatalog } from "../api/hooks";
import { isLocal, rpc } from "../api/transport";
import { DeviceSignIn } from "../screens/Settings";
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

/** api.github.com turned down the saved token. GitHub's OAuth tokens never expire, so GitHub revoked it: offers a new sign-in from here. */
export function GitHubSignInPrompt() {
  const qc = useQueryClient();
  // Set by the engine's githubSignedOut event (see useEngineEvents), false once put off.
  const asked = useQuery<boolean | null>({ queryKey: ["githubSignedOut"], queryFn: () => null, enabled: false, staleTime: Infinity }).data;
  if (!asked) return null;

  const later = () => qc.setQueryData(["githubSignedOut"], false);
  return (
    <Modal
      title="Sign in to GitHub again"
      sub="GitHub no longer accepts the saved sign-in"
      onClose={later}
      width={460}
      footer={
        <button className="btn btn-md" onClick={later}>
          Later
        </button>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <span>
          GitHub revoked it, for example when it was removed in your GitHub settings or after more than 10 newer sign-ins to Gitnetix. Pull requests, checks and issues come back once you sign in again.
        </span>
        <DeviceSignIn method="github" name="GitHub" site="GitHub" onDone={() => qc.setQueryData(["githubSignedOut"], null)} />
      </div>
    </Modal>
  );
}
