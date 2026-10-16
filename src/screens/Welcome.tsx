import { useEffect, useState } from "react";

import { useAction, useProjects } from "../api/hooks";
import { isLocal, onFolderDrop, pickFolders } from "../api/transport";
import type { Project } from "../api/types";
import { Icon } from "../components/Icon";
import { ThemeToggle } from "../components/ThemeToggle";
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
          <div className="col" style={{ gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em" }}>Open a project</h1>
            <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              Add one or more local Git repositories. They stay in your project bar until you remove them.
            </p>
          </div>

          <div
            className="col"
            style={{
              alignItems: "center",
              gap: 20,
              padding: "56px 24px",
              border: `1.5px dashed ${over ? "var(--accent)" : "var(--line)"}`,
              borderRadius: 4,
              background: over ? "var(--raised)" : "var(--panel)",
              textAlign: "center",
            }}
          >
            <Icon name="folder" size={36} stroke={1.1} className="faint" />
            {isLocal ? (
              <>
                <div className="col" style={{ alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 500 }}>{over ? "Release to add these folders" : "Drag project folders here"}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>Drop several at once to add them all</span>
                </div>
                <button className="btn btn-primary btn-md" disabled={add.isPending} onClick={async () => addPaths((await pickFolders()) ?? [])}>
                  {add.isPending ? <span className="spinner" /> : <Icon name="folder" />}
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
                  <li key={p.id} className="row" style={{ alignItems: "stretch", gap: 0 }}>
                    <button
                      className="row grow"
                      style={{ gap: 14, minHeight: 56, padding: "0 16px", border: 0, background: "transparent", textAlign: "left", minWidth: 0 }}
                      onClick={() => {
                        nav.setProject(p.id);
                        nav.go({ name: "workspace" });
                      }}
                    >
                      <span className="col" style={{ gap: 3, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                        <span className="mono faint ellipsis" style={{ fontSize: 11.5 }}>{p.path}</span>
                      </span>
                      <span className="grow" />
                      {!p.exists && <span className="pill c-del">Missing</span>}
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
