import { useEffect, useState } from "react";

import { useAction, useProjects } from "../api/hooks";
import { isLocal, onFolderDrop, pickFolders } from "../api/transport";
import type { Project } from "../api/types";
import { Icon } from "../components/Icon";
import { ThemeToggle } from "../components/ThemeToggle";
import { Busy, initials } from "../components/ui";
import { useNav } from "../lib/nav";

export function Welcome() {
  const nav = useNav();
  const projects = useProjects();
  const [over, setOver] = useState(false);
  const [manual, setManual] = useState("");
  const add = useAction<Project[], { paths: string[] }>("projects.add", {
    invalidate: [["projects"], ["config"]],
    success: (r) => (r.length ? `Added ${r.map((p) => p.name).join(", ")}` : undefined),
  });
  const remove = useAction("projects.remove", { invalidate: [["projects"], ["config"]] });
  const reopen = useAction("projects.setHidden", { invalidate: [["projects"], ["config"]] });

  const addPaths = (paths: string[]) => {
    if (!paths.length) return;
    add.mutate(
      { paths },
      {
        onSuccess: (r) => {
          if (r[0]) {
            nav.setProject(r[0].id);
            nav.go({ name: "workspace" });
          }
        },
      },
    );
  };

  useEffect(() => onFolderDrop(addPaths, setOver), []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = projects.data ?? [];
  return (
    <>
      <header className="hdr">
        <button className="hdr-icon" aria-label="Open menu" onClick={() => nav.go({ name: "menu" })}>
          <Icon name="menu" size={18} stroke={1.4} />
        </button>
        <div className="hdr-title muted">No project open</div>
        <div className="hdr-tools">
          <ThemeToggle />
        </div>
      </header>
      <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "72px 24px 48px" }}>
        <div className="col" style={{ width: "100%", maxWidth: 640, gap: 40 }}>
          <div className="welcome-hero">
            <img src="/logo.png" alt="" width={56} height={56} />
            <div className="col" style={{ gap: 8 }}>
              <h1>{list.length ? "Open a project" : "Welcome to Gitnetix"}</h1>
              <p className="muted">
                Add one or more local Git repositories. They stay in your project bar until you remove them.
              </p>
            </div>
          </div>

          <div className="dropzone" data-over={over || undefined}>
            <span className="dropzone-icon" aria-hidden="true">
              <Icon name="folder" size={26} stroke={1.3} />
            </span>
            {isLocal ? (
              <>
                <div className="col" style={{ alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{over ? "Release to add these folders" : "Drag project folders here"}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>Drop several at once to add them all</span>
                </div>
                <button className="btn btn-primary btn-md" disabled={add.isPending} onClick={async () => addPaths((await pickFolders()) ?? [])}>
                  <Busy on={add.isPending}><Icon name="folder" /></Busy>
                  <span>Choose folders…</span>
                </button>
              </>
            ) : (
              <form
                className="row wrap"
                style={{ width: "100%", maxWidth: 480, justifyContent: "center" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  addPaths([manual]);
                }}
              >
                <label htmlFor="add-path" className="sr-only">Path on the computer</label>
                <input id="add-path" className="input mono grow" placeholder="~/code/my-repo (path on the computer)" value={manual} onChange={(e) => setManual(e.target.value)} />
                <button className="btn btn-primary btn-md" disabled={!manual || add.isPending}>Add</button>
              </form>
            )}
          </div>

          <section aria-label="Your projects" className="col">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="label">Your projects</h2>
              <span className="faint" style={{ fontSize: 12 }}>{list.length} saved</span>
            </div>
            {list.length === 0 ? (
              <div className="empty card">Nothing here yet.</div>
            ) : (
              <ul className="list">
                {list.map((p) => (
                  <li key={p.id} className="row project-row" style={{ alignItems: "stretch", gap: 0, margin: 0 }}>
                    <button
                      className="row grow list-link"
                      style={{ gap: 14, minHeight: 60, padding: "0 16px", textAlign: "left", minWidth: 0 }}
                      onClick={() => {
                        if (p.hidden) reopen.mutate({ projectId: p.id, hidden: false });
                        nav.setProject(p.id);
                        nav.go({ name: "workspace" });
                      }}
                    >
                      <span className="mono-badge" aria-hidden="true">{initials(p.name)}</span>
                      <span className="col" style={{ gap: 3, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                        <span className="mono faint ellipsis" style={{ fontSize: 11.5 }}>{p.path}</span>
                      </span>
                      <span className="grow" />
                      {!p.exists && <span className="pill c-del">Missing</span>}
                      {p.hidden && <span className="pill faint">Closed</span>}
                      <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                        {p.nextRelease ? `Next: v${p.nextRelease}` : "No open release"}
                      </span>
                    </button>
                    <button className="btn btn-ghost" style={{ width: 44, height: "auto", border: 0 }} aria-label={`Remove ${p.name} from list`} onClick={() => remove.mutate({ projectId: p.id })}>
                      <Icon name="close" size={12} stroke={1.6} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
