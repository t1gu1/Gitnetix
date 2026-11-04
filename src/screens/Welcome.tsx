import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAction, useConfig, useProjects } from "../api/hooks";
import { isLocal, onPathDrop, pickFolders, rpc } from "../api/transport";
import type { GitHubRepo, Project, RecentProject } from "../api/types";
import { Icon } from "../components/Icon";
import { dataUrl } from "../components/ImageDiff";
import { Logo } from "../components/Logo";
import { ProfileButton } from "../components/Profiles";
import { Busy, ErrorBox, initials, Modal, Seg } from "../components/ui";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";

export function Welcome() {
  const nav = useNav();
  const projects = useProjects();
  // The other profiles' projects, to add back: in place of a new profile's empty list, else under it.
  const recent = useQuery({ queryKey: ["projects", "recent"], queryFn: () => rpc<RecentProject[]>("projects.recent") }).data ?? [];
  const [over, setOver] = useState(false);
  const [manual, setManual] = useState("");
  const [cloning, setCloning] = useState(false);
  const add = useAction<Project[], { paths: string[] }>("projects.add", {
    invalidate: [["projects"], ["config"]],
    success: (r) => (r.length ? `Added ${r.map((p) => p.name).join(", ")}` : undefined),
  });
  const remove = useAction("projects.remove", { invalidate: [["projects"], ["config"]] });
  const reopen = useAction("projects.setHidden", { invalidate: [["projects"], ["config"]] });

  const openFirst = (r: Project[]) => {
    if (r[0]) {
      nav.setProject(r[0].id);
      nav.go({ name: "workspace" });
    }
  };
  const addPaths = (paths: string[]) => {
    if (paths.length) add.mutate({ paths }, { onSuccess: openFirst });
  };

  useEffect(() => onPathDrop(addPaths, setOver), []); // eslint-disable-line react-hooks/exhaustive-deps

  const list = projects.data ?? [];
  const cloneButton = (
    <button type="button" className="btn btn-md" onClick={() => setCloning(true)}>
      <Icon name="download" />
      <span>Git clone…</span>
    </button>
  );
  const offer = !list.length && recent.length > 0;
  const recentList = (
    <ul className="list">
      {recent.map((r) => (
        <li key={r.path} className="row project-row" style={{ margin: 0 }}>
          <button
            className="row grow list-link"
            style={{ gap: 14, minHeight: 60, padding: "0 16px", textAlign: "left", minWidth: 0 }}
            aria-label={`Add ${r.name} from ${r.profile}`}
            disabled={add.isPending}
            onClick={() => addPaths([r.path])}
          >
            <ProjectBadge name={r.name} path={r.path} />
            <span className="col" style={{ gap: 3, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{r.name}</span>
              <span className="mono faint ellipsis" style={{ fontSize: 11.5 }}>{r.path}</span>
            </span>
            <span className="grow" />
            <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{r.profile}</span>
            <Icon name="plus" size={12} stroke={1.6} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <header className="hdr">
        <div className="hdr-title muted">No project open</div>
        <div className="hdr-tools">
          <ProfileButton />
        </div>
      </header>
      <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "72px 24px 48px" }}>
        <div className="col" style={{ width: "100%", maxWidth: 640, gap: 40 }}>
          <div className="welcome-hero">
            <Logo size={56} />
            <div className="col" style={{ gap: 8 }}>
              <h1>{list.length ? "Open a project" : "Add your first project"}</h1>
              <p className="muted">
                Add one or more local Git repositories, or clone one. They stay in your project bar until you remove them.
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
                <div className="row wrap" style={{ justifyContent: "center" }}>
                  <button className="btn btn-primary btn-md" disabled={add.isPending} onClick={async () => addPaths((await pickFolders()) ?? [])}>
                    <Busy on={add.isPending}><Icon name="folder" /></Busy>
                    <span>Choose folders…</span>
                  </button>
                  {cloneButton}
                </div>
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
                {cloneButton}
              </form>
            )}
          </div>
          {cloning && (
            <CloneModal
              // Next to the first project by default: where this user keeps their repositories.
              base={list[0]?.path.replace(/[\\/][^\\/]+$/, "") || "~"}
              onClose={() => setCloning(false)}
              onDone={(r) => {
                setCloning(false);
                openFirst(r);
              }}
            />
          )}

          <section aria-label={offer ? "Recent projects" : "Your projects"} className="col">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="label">{offer ? "Recent projects" : "Your projects"}</h2>
              <span className="faint" style={{ fontSize: 12 }}>{offer ? "From your other profiles" : `${list.length} saved`}</span>
            </div>
            {offer ? recentList : list.length === 0 ? (
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
                      <ProjectBadge name={p.name} path={p.path} />
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
                    <button className="btn btn-ghost project-remove" aria-label={`Remove ${p.name} from list`} onClick={() => remove.mutate({ projectId: p.id })}>
                      <Icon name="close" size={12} stroke={1.6} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {list.length > 0 && recent.length > 0 && (
            <section aria-label="From your other profiles" className="col">
              <h2 className="label">From your other profiles</h2>
              {recentList}
            </section>
          )}
        </div>
      </main>
    </>
  );
}

/** Rows shown at once: enough to scroll, few enough to stay light with a thousand repositories. */
const SHOWN_REPOS = 50;

/** Clone a repository into a new folder named after it, then open it like an added one.
 * With GitHub, GitLab, Bitbucket or Gitea linked, its repositories are listed to pick from. */
function CloneModal({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: (r: Project[]) => void }) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(base);
  const i = useConfig().data?.integrations;
  const hosts = i ? ([["github", "GitHub", i.githubConnected], ["gitlab", "GitLab", i.gitlab.connected], ["bitbucket", "Bitbucket", i.bitbucket.connected], ["gitea", "Gitea", i.gitea.connected]] as const).filter((h) => h[2]) : [];
  const [hostPick, setHostPick] = useState<string>();
  const host = hosts.find((h) => h[0] === hostPick) ?? hosts[0];
  const linked = !!host;
  const repos = useQuery({ queryKey: [host?.[0], "repos"], queryFn: () => rpc<GitHubRepo[]>(`${host![0]}.repos`), enabled: linked, staleTime: 5 * 60_000, retry: false });
  const [proto, setProto] = useStored<"https" | "ssh">("gnx.clone.protocol", "ssh", (s) => (s === "https" ? "https" : "ssh"), String);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<GitHubRepo | null>(null);
  const urlOf = (r: GitHubRepo, p = proto) => (p === "ssh" ? r.sshUrl : r.cloneUrl);
  const pick = (r: GitHubRepo) => {
    setPicked(r);
    setUrl(urlOf(r));
  };
  const term = search.trim().toLowerCase();
  const matches = (repos.data ?? []).filter((r) => !term || r.fullName.toLowerCase().includes(term) || r.description?.toLowerCase().includes(term));
  // `git@host:owner/app.git`, `https://host/owner/app/` → `app`, the folder git clone would make.
  const name = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/:]/).pop() ?? "";
  const path = `${parent.trim().replace(/[\\/]+$/, "")}/${name}`;
  const clone = useAction<Project[], { url: string; path: string }>("projects.clone", {
    invalidate: [["projects"], ["config"]],
    success: (r) => r[0] && `Cloned ${r[0].name}`,
    onError: () => true, // shown in the dialog, not again as a toast
  });
  const ready = !!name && !!parent.trim() && !clone.isPending;
  const submit = () => ready && clone.mutate({ url: url.trim(), path }, { onSuccess: onDone });
  return (
    <Modal
      title="Clone a repository"
      onClose={clone.isPending ? undefined : onClose}
      footer={
        // Tied to the form: Enter in either field clones.
        <button type="submit" form="clone-form" className="btn btn-md btn-primary" disabled={!ready}>
          {clone.isPending && <span className="spinner" />}
          Clone
        </button>
      }
    >
      <form id="clone-form" className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {linked && (
          <div className="field">
            {hosts.length > 1 && <Seg label="Repositories from" value={host[0]} options={hosts.map(([value, label]) => ({ value, label }))} onChange={(h) => setHostPick(h)} />}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label htmlFor="clone-search">Your {host[1]} repositories</label>
              <Seg
                label="Clone with"
                value={proto}
                options={[{ value: "https", label: "HTTPS" }, { value: "ssh", label: "SSH" }]}
                onChange={(p) => {
                  setProto(p);
                  if (picked && url === urlOf(picked)) setUrl(urlOf(picked, p));
                }}
              />
            </div>
            <input
              id="clone-search"
              className="input"
              type="search"
              placeholder="Search by name or description"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Enter takes the first match instead of cloning whatever the URL field holds.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (matches[0]) pick(matches[0]);
              }}
            />
            <ul className="list" style={{ maxHeight: 232, overflowY: "auto" }}>
              {repos.isPending && <li className="list-row muted"><span className="spinner" /> Loading your repositories…</li>}
              {repos.isSuccess && !matches.length && <li className="list-row faint">{term ? "No match." : "No repositories on this account."}</li>}
              {matches.slice(0, SHOWN_REPOS).map((r) => (
                <li key={r.fullName}>
                  <button type="button" className="list-link list-row" style={{ minHeight: 44 }} aria-pressed={picked?.fullName === r.fullName && url === urlOf(r)} onClick={() => pick(r)}>
                    <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{r.fullName}</span>
                      {r.description && <span className="faint ellipsis" style={{ fontSize: 11.5 }}>{r.description}</span>}
                    </span>
                    {r.private && <span className="pill faint">Private</span>}
                  </button>
                </li>
              ))}
            </ul>
            {matches.length > SHOWN_REPOS && <span className="hint">{matches.length - SHOWN_REPOS} more. Search to narrow the list.</span>}
            {repos.error && <ErrorBox error={repos.error} />}
          </div>
        )}
        <div className="field">
          <label htmlFor="clone-url">Repository URL</label>
          <input id="clone-url" className="input mono" placeholder="https://github.com/owner/repo.git" autoFocus={!linked} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="clone-parent">Clone into</label>
          <div className="row">
            <input id="clone-parent" className="input mono grow" placeholder="~/code" value={parent} onChange={(e) => setParent(e.target.value)} />
            {isLocal && (
              <button
                type="button"
                className="btn btn-md"
                onClick={async () => {
                  const [dir] = (await pickFolders("Choose where to clone", false)) ?? [];
                  if (dir) setParent(dir);
                }}
              >
                Choose…
              </button>
            )}
          </div>
        </div>
        {name && <span className="muted" style={{ fontSize: 12.5 }}>Creates <span className="mono">{path}</span></span>}
      </form>
      {clone.error && <ErrorBox error={clone.error} />}
    </Modal>
  );
}

/** The repo's own icon (favicon, app icon, logo) when it has one, else its initials. */
function ProjectBadge({ name, path }: { name: string; path: string }) {
  const icon = useQuery({
    queryKey: ["projectIcon", path],
    queryFn: () => rpc<{ path: string; data: string } | null>("projects.icon", { path }),
    staleTime: Infinity,
    retry: false,
  }).data;
  return (
    <span className="mono-badge project-badge" aria-hidden="true">
      {icon ? <img src={dataUrl(icon.path, icon.data)} alt="" /> : initials(name)}
    </span>
  );
}
