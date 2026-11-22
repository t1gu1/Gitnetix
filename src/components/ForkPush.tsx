import { useAction, useConfig } from "../api/hooks";
import { endForkAsk, useForkAsk, type ForkAsk } from "../lib/forkAsk";
import { useNav } from "../lib/nav";
import { DeviceSignIn } from "../screens/Settings";
import { Modal } from "./ui";

/** Offers a fork when GitHub refused a push to origin (a clone of someone else's project): forks it to the user's
 * account, pushes the branch there, then says a pull request can propose it to the original project. */
export function ForkPush() {
  const ask = useForkAsk();
  if (!ask) return null;
  return <ForkForm key={`${ask.projectId}:${ask.branch}`} {...ask} />;
}

function ForkForm({ projectId, branch, repo }: ForkAsk) {
  const nav = useNav();
  const signedIn = !!useConfig().data?.integrations.githubConnected;
  const fork = useAction<{ fork: string }>("workspace.pushToFork", { invalidate: [["overview", projectId], ["commits", projectId], ["prs", projectId]] });
  const close = () => !fork.isPending && endForkAsk();
  const done = fork.data?.fork;
  const b = <span className="mono">{branch}</span>;

  if (done) {
    return (
      <Modal
        title="Pushed to your fork"
        sub={<>{b} is on <span className="mono">{done}</span></>}
        onClose={close}
        width={460}
        footer={
          <>
            <button className="btn btn-md" onClick={close}>Close</button>
            {nav.projectId === projectId && (
              <button
                className="btn btn-md btn-primary"
                autoFocus
                onClick={() => {
                  endForkAsk();
                  nav.selectBranch(branch);
                  nav.go({ name: "prs" });
                }}
              >
                Open a pull request
              </button>
            )}
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          To propose your commits to <span className="mono">{repo}</span>, open a pull request from your fork, now or whenever you want. Later pushes of {b} go
          to your fork.
        </p>
      </Modal>
    );
  }
  return (
    <Modal
      title={`Fork ${repo}?`}
      sub="GitHub refused the push: you can't push to this repository"
      onClose={close}
      width={460}
      footer={
        <>
          <button className="btn btn-md" disabled={fork.isPending} onClick={close}>Back</button>
          <button className="btn btn-md btn-primary" autoFocus disabled={!signedIn || fork.isPending} onClick={() => fork.mutate({ projectId, branch })}>
            {fork.isPending && <span className="spinner" />}
            {fork.isPending ? "Forking and pushing…" : "Fork and push"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          Gitnetix can fork <span className="mono">{repo}</span> to your GitHub account and push {b} to your fork instead. A fork you already have is used as it is.
        </p>
        <p className="hint" style={{ margin: 0 }}>After that, you can open a pull request to propose your commits to {repo}, if you want.</p>
        {!signedIn && (
          <>
            <span className="hint">Forking needs your GitHub sign-in:</span>
            <DeviceSignIn method="github" name="GitHub" site="GitHub" />
          </>
        )}
      </div>
    </Modal>
  );
}
