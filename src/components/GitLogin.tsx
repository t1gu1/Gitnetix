import { useState } from "react";

import { useAction, useConfig } from "../api/hooks";
import { endGitLogin, useGitLoginAsk } from "../lib/gitLogin";
import { DeviceSignIn } from "../screens/Settings";
import { Modal } from "./ui";

/** Asks for the login git needs to sign in to an HTTPS host, keeps it in the keychain, then runs again what failed. */
export function GitLogin() {
  const ask = useGitLoginAsk();
  if (!ask) return null;
  return <LoginForm key={ask.host} host={ask.host} refused={ask.refused} />;
}

function LoginForm({ host, refused }: { host: string; refused: boolean }) {
  const cfg = useConfig().data;
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const save = useAction("git.saveLogin");
  const github = host === "github.com";
  const close = () => !save.isPending && endGitLogin(false);
  return (
    <Modal
      title={`Sign in to ${host}`}
      sub={refused ? `${host} refused the login git gave it` : "Git needs a login to reach it over HTTPS"}
      onClose={close}
      width={460}
      footer={
        <>
          <button className="btn btn-md" disabled={save.isPending} onClick={close}>
            Cancel
          </button>
          <button className="btn btn-md btn-primary" type="submit" form="git-login" disabled={!username.trim() || !token.trim() || save.isPending}>
            {save.isPending && <span className="spinner" />}
            Save and try again
          </button>
        </>
      }
    >
      <form
        id="git-login"
        className="col"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ host, username, token }, { onSuccess: () => endGitLogin(true) });
        }}
      >
        {github && !cfg?.integrations.githubConnected && (
          <>
            <DeviceSignIn method="github" name="GitHub" site="GitHub" onDone={() => endGitLogin(true)} />
            <span className="hint">Or use a personal access token:</span>
          </>
        )}
        <div className="field">
          <label htmlFor="git-login-user">Username</label>
          <input id="git-login-user" className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="git-login-token">{github ? "Personal access token" : "Access token or password"}</label>
          <input id="git-login-token" type="password" className="input mono" autoComplete="current-password" placeholder={github ? "github_pat_…" : undefined} value={token} onChange={(e) => setToken(e.target.value)} />
          <span className="hint">
            {github ? "A classic token with the repo scope, or a fine-grained one with Contents read and write. " : "GitLab and Bitbucket take an access token or an app password here. "}
            Kept in your OS keychain, for every repository on {host}.
          </span>
        </div>
      </form>
    </Modal>
  );
}
