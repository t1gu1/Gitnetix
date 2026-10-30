import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { useAction, useProjects, useSubmodules } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { Project, Submodule } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Empty, EmptyState, ErrorBox, Header, Loading, Modal, Seg, swipeProps } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { copyToClipboard, toast } from "../lib/toast";

type Filter = "all" | "attention";

const short = (sha?: string | null) => sha?.slice(0, 7) ?? "—";

/** Path a URL clones into by default (same rule as the engine). */
const defaultPath = (url: string) => {
  const last = url.trim().replace(/\/+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/, "");
};

const needsYou = (s: Submodule) => s.state !== "clean" || s.dirty > 0 || s.upstreamBehind > 0 || s.staged || s.urlDrift;

/** One status line per submodule, most pressing first: [label, color class]. */
function status(s: Submodule): [string, string] {
  switch (s.state) {
    case "uninitialized":
      return ["Not cloned", "muted"];
    case "conflict":
      return ["Conflict", "c-del"];
    case "missing":
      return ["Not in index", "c-del"];
    case "moved":
      return ["Off its pin", "c-warn"];
  }
  if (s.upstreamBehind > 0) return ["Update available", "c-acc"];
  if (s.staged) return ["New pin staged", "c-acc"];
  return ["Up to date", "c-add"];
}

/** Results of a submodule command, kept until the next one. */
interface Output {
  title: string;
  text: string;
}

/**
 * Every submodule of the current project: what it is pinned to, what is checked
 * out, how far its remote has moved. Add, update, sync, re-pin and remove them,
 * one at a time or all at once.
 */
export function Submodules() {
  const nav = useNav();
  const pid = nav.projectId!;
  const project = useProjects().data?.find((p) => p.id === pid);
  const q = useSubmodules(pid);
  const list = q.data ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string>();
  const [pane, setPane] = useState<"list" | "detail">("list");
  const listW = usePaneWidth("gnx.pane.submodules", 400, 280, 720);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [output, setOutput] = useState<Output>();
  const inv = [["submodules", pid], ["overview", pid], ["files", pid]];
  const show = (title: string) => (r: { output?: string }) => setOutput(r.output?.trim() ? { title, text: r.output.trim() } : undefined);

  const update = useAction<{ output: string }, { projectId: string; path?: string; remote?: boolean }>("submodules.update", { invalidate: inv });
  const sync = useAction<{ output: string }, { projectId: string; path?: string }>("submodules.sync", { invalidate: inv, success: "URLs synced" });
  const fetch = useAction<{ fetched: number; failed: string[] }, { projectId: string }>("submodules.fetch", {
    invalidate: [["submodules", pid]],
    success: (r) => (r.failed.length ? undefined : `Checked ${plural(r.fetched, "remote")}`),
  });

  const updateAll = (remote: boolean) =>
    update.mutate(
      { projectId: pid, remote },
      {
        onSuccess: (r) => {
          toast(remote ? "Every submodule moved to its remote's latest" : "Every submodule checked out at its pin", "ok");
          show(remote ? "Pull latest, all" : "Update all")(r);
        },
      },
    );
  const checkRemotes = () =>
    fetch.mutate(
      { projectId: pid },
      { onSuccess: (r) => r.failed.length && setOutput({ title: `Could not reach ${plural(r.failed.length, "remote")}`, text: r.failed.join("\n") }) },
    );

  const shown = list.filter((s) => filter === "all" || needsYou(s));
  const cur = list.find((s) => s.path === sel) ?? shown[0];
  const attention = list.filter(needsYou).length;
  const behind = list.filter((s) => s.upstreamBehind > 0).length;
  const allBusy = update.isPending && !update.variables?.path;

  const openMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 2 });
  };
  const menuItems: MenuItem[] = [
    { id: "update", label: "Update all to their pins", icon: "box", run: () => updateAll(false) },
    { id: "remote", label: "Pull latest for all", icon: "stash", hint: "then pin them", run: () => updateAll(true) },
    "sep",
    { id: "sync", label: "Sync all URLs", icon: "swap", hint: "from .gitmodules", run: () => sync.mutate({ projectId: pid }) },
    { id: "fetch", label: "Check remotes for updates", icon: "refresh", run: checkRemotes },
  ];

  return (
    <>
      <Header title="Submodules" sub={project?.name} hideWide onBack={pane === "detail" ? () => setPane("list") : undefined} />
      <div className="body split">
        <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Submodules">
          {list.length > 0 && (
            <div className="master-tools">
              <div className="row" style={{ gap: 2, margin: 0 }}>
                <span className="grow" style={{ minWidth: 0, marginRight: 4 }}>
                  <Seg<Filter>
                    grid
                    label="Filter"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: <>All <span className="faint">{list.length}</span></> },
                      { value: "attention", label: <>Needs you <span className="faint">{attention}</span></> },
                    ]}
                  />
                </span>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  aria-label="Check remotes for updates"
                  data-tip={`Check remotes for updates (fetch) · ${behind ? `${behind} with updates on their remote` : "remotes as of last check"}`}
                  disabled={fetch.isPending}
                  onClick={checkRemotes}
                >
                  {fetch.isPending ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
                </button>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Add a submodule" data-tip="Add a submodule" onClick={() => setAdding(true)}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
            </div>
          )}
          <div className="scroll" style={{ flex: "1 1 auto", padding: "8px 0 12px" }}>
            {q.isLoading && <Loading />}
            {q.error && <div style={{ padding: 12 }}><ErrorBox error={q.error} /></div>}
            <div className="col" style={{ gap: 2 }}>
              {shown.map((s) => {
                const [label, cls] = status(s);
                const busy = update.isPending && (update.variables?.path === s.path || !update.variables?.path);
                return (
                  <button key={s.path} className="item-btn" aria-pressed={s.path === cur?.path} onClick={() => { setSel(s.path); setPane("detail"); }}>
                    <span className="row">
                      {busy ? <span className="spinner" /> : <Icon name="box" size={13} />}
                      <span className="mono ellipsis grow" style={{ fontSize: 12.5 }}>{s.path}</span>
                      <span className={cls} style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{label}</span>
                    </span>
                    <span className="row" style={{ gap: 8, fontSize: 11.5, paddingLeft: 21 }}>
                      <span className="faint ellipsis grow">{s.subject ?? s.url}</span>
                      {s.dirty > 0 && <span className="c-warn" title="Uncommitted files inside">●{s.dirty}</span>}
                      {s.upstreamBehind > 0 && <span className="c-acc mono" title={`New commits on ${s.upstream}`}>↓{s.upstreamBehind}</span>}
                      <span className="mono faint">{short(s.head ?? s.recorded)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {!q.isLoading && !q.error && list.length === 0 && (
              <Empty>
                No submodules in this project.
                <br />
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
                  <Icon name="plus" size={12} />
                  Add a submodule
                </button>
              </Empty>
            )}
            {list.length > 0 && shown.length === 0 && <Empty>Every submodule is up to date.</Empty>}
          </div>
          {list.length > 0 && (
            <div className="master-tools" style={{ borderBottom: 0, borderTop: "1px solid var(--line)" }}>
              <span className="split-btn" style={{ display: "flex" }}>
                <button
                  className="btn btn-primary split-main grow"
                  style={{ height: 48, fontSize: 13.5 }}
                  disabled={update.isPending}
                  data-tip="Clone missing submodules and check each out at the commit the project pins, nested ones included"
                  onClick={() => updateAll(false)}
                >
                  {allBusy ? <span className="spinner" /> : <Icon name="box" size={13} />}
                  Update all
                </button>
                <button className="btn btn-primary btn-icon split-more" style={{ height: 48, width: 48 }} aria-label="More bulk actions" data-tip="More bulk actions" aria-haspopup="menu" disabled={update.isPending} onClick={openMenu}>
                  <Icon name="chevronDown" size={13} />
                </button>
              </span>
            </div>
          )}
        </section>
        <Resizer pane={listW} label="Resize submodule list" />
        <main className="detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
          <div className="detail-inner">
            {cur ? (
              <Detail key={cur.path} pid={pid} root={project?.path} s={cur} onOutput={setOutput} />
            ) : (
              !q.isLoading && <EmptyState icon="box" title={list.length ? "No submodule selected" : "No submodules yet"}>{list.length ? "Pick one from the list to see its state and update it." : "Submodules show up here once added."}</EmptyState>
            )}
            {output && (
              <section className="col" style={{ gap: 8 }} aria-label="Command output">
                <div className="row">
                  <span className="label">{output.title}</span>
                  <span className="grow" />
                  <button className="btn btn-ghost btn-sm" onClick={() => setOutput(undefined)}>Clear</button>
                </div>
                <pre className="pre" style={{ maxHeight: 280, overflow: "auto" }}>{output.text}</pre>
              </section>
            )}
          </div>
        </main>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} alignRight label="Bulk submodule actions" items={menuItems} onClose={() => setMenu(null)} />}
      {adding && (
        <AddModal
          pid={pid}
          taken={list.map((s) => s.path)}
          onAdded={(path, out) => {
            setSel(path);
            setPane("detail");
            setOutput(out.trim() ? { title: `Added ${path}`, text: out.trim() } : undefined);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

function Detail({ pid, root, s, onOutput }: { pid: string; root?: string; s: Submodule; onOutput: (o?: Output) => void }) {
  const nav = useNav();
  const inv = [["submodules", pid], ["overview", pid], ["files", pid]];
  const update = useAction<{ output: string }, { projectId: string; path?: string; remote?: boolean }>("submodules.update", { invalidate: inv });
  const sync = useAction("submodules.sync", { invalidate: inv, success: "URL synced" });
  const stage = useAction("submodules.stage", { invalidate: inv, success: "New pin staged: commit it from the workspace" });
  const addProject = useAction<Project[], { paths: string[] }>("projects.add", { invalidate: [["projects"], ["config"]] });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [label, cls] = status(s);
  const cloned = !!s.head;
  const busy = update.isPending || sync.isPending || stage.isPending;

  const run = (remote: boolean) =>
    update.mutate(
      { projectId: pid, path: s.path, remote },
      {
        onSuccess: (r) => {
          toast(remote ? `${s.path} moved to the latest of ${s.upstream ?? "its remote"}` : cloned ? `${s.path} checked out at its pin` : `${s.path} cloned`, "ok");
          onOutput(r.output.trim() ? { title: `${remote ? "Pull latest" : "Update"} · ${s.path}`, text: r.output.trim() } : undefined);
        },
      },
    );

  const openAsProject = () => {
    if (!root) return;
    addProject.mutate(
      { paths: [`${root.replace(/[/\\]+$/, "")}/${s.path}`] },
      {
        onSuccess: (r) => {
          if (!r[0]) return;
          nav.setProject(r[0].id);
          nav.go({ name: "workspace" });
        },
      },
    );
  };

  const goCommit = () => nav.go({ name: "workspace" });

  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <div className="row wrap" style={{ fontSize: 12.5 }}>
          <span className={`pill ${cls}`}>{label}</span>
          {s.name !== s.path && <span className="muted">Named <span className="mono">{s.name}</span></span>}
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <h1 className="mono grow" style={{ fontSize: 18 }}>{s.path}</h1>
          {s.webUrl && (
            <button className="btn" data-tip={s.webUrl} onClick={() => openExternal(s.webUrl!)}>
              <Icon name="external" size={12} />
              View repository
            </button>
          )}
        </div>
      </div>

      <Callouts s={s} busy={busy} onClone={() => run(false)} onRepin={() => stage.mutate({ projectId: pid, path: s.path })} onReset={() => run(false)} onLatest={() => run(true)} onSync={() => sync.mutate({ projectId: pid, path: s.path })} onCommit={goCommit} />

      <div className="kv">
        <div>
          <span>Repository</span>
          <span className="row" style={{ gap: 4, minWidth: 0 }}>
            {s.webUrl ? (
              <a className="mono ellipsis" href={s.webUrl} title={`Open ${s.webUrl}`} style={{ fontSize: 12 }} onClick={(e) => { e.preventDefault(); openExternal(s.webUrl!); }}>{s.url}</a>
            ) : (
              <span className="mono ellipsis" title={s.url} style={{ fontSize: 12 }}>{s.url}</span>
            )}
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Copy URL" data-tip="Copy URL" onClick={() => copyToClipboard(s.url)}>
              <Icon name="copy" size={11} />
            </button>
          </span>
        </div>
        <div>
          <span>Tracks</span>
          <span className="mono">{s.branch ?? <span className="muted" style={{ fontFamily: "inherit" }}>Remote default{s.upstream ? ` (${s.upstream.replace(/^origin\//, "")})` : ""}</span>}</span>
        </div>
        <div>
          <span>Pinned at</span>
          <span className="mono" title={s.recorded ?? undefined}>{short(s.recorded)}{s.staged && <span className="c-acc" style={{ fontFamily: "inherit", fontSize: 11.5 }}> · staged</span>}</span>
        </div>
        <div>
          <span>Checked out</span>
          <span className="mono" title={s.head ?? undefined}>
            {cloned ? short(s.head) : "—"}
            {cloned && <span className="muted" style={{ fontFamily: "inherit", fontSize: 11.5 }}> · {s.headBranch ?? "detached"}</span>}
          </span>
        </div>
        <div>
          <span>Remote</span>
          <span>
            {!cloned ? "—" : !s.upstream ? <span className="muted">No remote branch</span> : s.upstreamBehind > 0 ? <span className="c-acc">{plural(s.upstreamBehind, "new commit")}</span> : <span className="c-add">Nothing new</span>}
          </span>
        </div>
        <div>
          <span>Working tree</span>
          <span className={s.dirty ? "c-warn" : undefined}>{!cloned ? "—" : s.dirty ? plural(s.dirty, "uncommitted file") : "Clean"}</span>
        </div>
      </div>

      {s.subject && (
        <div className="card col" style={{ padding: "12px 16px", gap: 4 }}>
          <span className="label">Last commit checked out</span>
          <span>{s.subject}</span>
          <span className="faint" style={{ fontSize: 12 }}>{s.author} · {ago(s.date)}</span>
        </div>
      )}

      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn" disabled={busy} data-tip={cloned ? "Check out the commit the project pins" : "Clone it and check out its pin"} onClick={() => run(false)}>
          {update.isPending && !update.variables?.remote ? <span className="spinner" /> : <Icon name="box" size={12} />}
          {cloned ? "Update" : "Clone"}
        </button>
        <button className="btn" disabled={busy} data-tip={`Check out the tip of ${s.upstream ?? "the tracked branch"}; then pin it to keep it`} onClick={() => run(true)}>
          {update.isPending && update.variables?.remote ? <span className="spinner" /> : <Icon name="stash" size={12} />}
          Pull latest
        </button>
        <button className="btn" disabled={busy || !cloned} data-tip="Copy the URL from .gitmodules into the local clone" onClick={() => sync.mutate({ projectId: pid, path: s.path })}>
          <Icon name="swap" size={12} />
          Sync URL
        </button>
        <button className="btn" disabled={busy || s.state !== "moved"} data-tip="Record the checked-out commit as the new pin (staged)" onClick={() => stage.mutate({ projectId: pid, path: s.path })}>
          <Icon name="check" size={12} />
          Pin this commit
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          <Icon name="edit" size={12} />
          Edit
        </button>
        <button className="btn" disabled={!cloned || !root || addProject.isPending} data-tip="Work on it in its own tab" onClick={openAsProject}>
          <Icon name="external" size={12} />
          Open as project
        </button>
        <span className="grow" />
        <button className="btn btn-danger" onClick={() => setRemoving(true)}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      </div>

      {editing && <EditModal pid={pid} s={s} onClose={() => setEditing(false)} />}
      {removing && <RemoveModal pid={pid} s={s} onClose={() => setRemoving(false)} />}
    </>
  );
}

/** What needs doing on a submodule, each with the action that does it. */
function Callouts({
  s,
  busy,
  onClone,
  onRepin,
  onReset,
  onLatest,
  onSync,
  onCommit,
}: {
  s: Submodule;
  busy: boolean;
  onClone: () => void;
  onRepin: () => void;
  onReset: () => void;
  onLatest: () => void;
  onSync: () => void;
  onCommit: () => void;
}) {
  const notes: { key: string; tone: string; text: ReactNode; actions?: ReactNode }[] = [];
  const act = (label: string, run: () => void, primary = false) => (
    <button key={label} className={`btn btn-sm${primary ? " btn-primary" : ""}`} disabled={busy} onClick={run}>{label}</button>
  );
  if (s.state === "uninitialized") notes.push({ key: "init", tone: "muted", text: "Declared but not cloned yet: its folder is empty.", actions: act("Clone", onClone, true) });
  if (s.state === "missing")
    notes.push({ key: "missing", tone: "c-del", text: <>Listed in <span className="mono">.gitmodules</span> but the project holds no pointer for it. Re-add it, or remove it to clean the entry up.</> });
  if (s.state === "conflict")
    notes.push({ key: "conflict", tone: "c-del", text: "Its pointer is conflicted. Check out the commit you want inside it, then pin it.", actions: act("Pin checked-out commit", onRepin, true) });
  if (s.state === "moved") {
    const drift = [s.ahead && `${plural(s.ahead, "commit")} ahead`, s.behind && `${s.behind} behind`].filter(Boolean).join(", ");
    notes.push({
      key: "moved",
      tone: "c-warn",
      text: <>Checked out at <span className="mono">{short(s.head)}</span>, not at its pin <span className="mono">{short(s.recorded)}</span>{drift ? ` (${drift})` : ""}.</>,
      actions: <>{act("Pin this commit", onRepin, true)}{act("Back to pin", onReset)}</>,
    });
  }
  if (s.upstreamBehind > 0 && s.state !== "moved")
    notes.push({ key: "latest", tone: "c-acc", text: <>{plural(s.upstreamBehind, "new commit")} on <span className="mono">{s.upstream}</span>.</>, actions: act("Pull latest", onLatest, true) });
  if (s.urlDrift)
    notes.push({
      key: "url",
      tone: "c-warn",
      text: <>The local clone fetches from <span className="mono">{s.localUrl}</span>, but <span className="mono">.gitmodules</span> says <span className="mono">{s.url}</span>.</>,
      actions: act("Sync URL", onSync, true),
    });
  if (s.staged && s.state === "clean")
    notes.push({ key: "staged", tone: "c-acc", text: "A new pin is staged. Commit it so everyone gets this version.", actions: act("Go commit", onCommit, true) });
  if (s.dirty > 0) notes.push({ key: "dirty", tone: "c-warn", text: <>{plural(s.dirty, "uncommitted file")} inside. Commit or stash them in the submodule before updating it.</> });
  if (!notes.length) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {notes.map((n) => (
        <div key={n.key} className={`card row wrap ${n.tone}`} style={{ padding: "10px 14px", gap: 10, borderLeft: "3px solid currentColor" }}>
          <span className="grow" style={{ color: "var(--fg)", fontSize: 12.5, lineHeight: 1.5, minWidth: 200 }}>{n.text}</span>
          {n.actions && <span className="row" style={{ gap: 6 }}>{n.actions}</span>}
        </div>
      ))}
    </div>
  );
}

function AddModal({ pid, taken, onAdded, onClose }: { pid: string; taken: string[]; onAdded: (path: string, output: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const add = useAction<{ output: string }>("submodules.add", { invalidate: [["submodules", pid], ["overview", pid], ["files", pid]] });
  const target = (path.trim() || defaultPath(url)).replace(/\/+$/, "");
  const clash = taken.includes(target);
  const submit = () =>
    add.mutate(
      { projectId: pid, url: url.trim(), path: target, branch: branch.trim() || undefined },
      {
        onSuccess: (r) => {
          toast(`Added ${target}: commit it from the workspace`, "ok");
          onAdded(target, r.output);
          onClose();
        },
      },
    );
  return (
    <Modal
      title="Add a submodule"
      sub="Clones the repository into the project and stages it"
      onClose={add.isPending ? () => {} : onClose}
      footer={
        <>
          <button className="btn btn-primary btn-md" disabled={!url.trim() || !target || clash || add.isPending} onClick={submit}>
            {add.isPending && <span className="spinner" />}
            {add.isPending ? "Cloning…" : "Add submodule"}
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); if (url.trim() && target && !clash) submit(); }}>
        <div className="field">
          <label htmlFor="sm-url">Repository URL</label>
          <input id="sm-url" className="input mono" placeholder="git@github.com:acme/ui-kit.git" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="sm-path">
            Folder in the project
            {clash && <span className="c-del">Already a submodule</span>}
          </label>
          <input id="sm-path" className="input mono" placeholder={defaultPath(url) || "libs/ui-kit"} value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sm-branch">
            Branch to track
            <span className="faint">optional</span>
          </label>
          <input id="sm-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <span className="hint">“Pull latest” follows this branch. Leave it empty to follow the remote's default branch.</span>
        </div>
        <button type="submit" hidden />
      </form>
      {add.error && <ErrorBox error={add.error} />}
    </Modal>
  );
}

function EditModal({ pid, s, onClose }: { pid: string; s: Submodule; onClose: () => void }) {
  const [url, setUrl] = useState(s.url);
  const [branch, setBranch] = useState(s.branch ?? "");
  const set = useAction("submodules.set", { invalidate: [["submodules", pid], ["overview", pid], ["files", pid]], success: "Submodule updated: commit .gitmodules to share it" });
  const changed = url.trim() !== s.url || branch.trim() !== (s.branch ?? "");
  return (
    <Modal
      title="Edit submodule"
      sub={<span className="mono">{s.path}</span>}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-primary btn-md"
            disabled={!changed || !url.trim() || set.isPending}
            onClick={() => set.mutate({ projectId: pid, path: s.path, url: url.trim(), branch: branch.trim() }, { onSuccess: onClose })}
          >
            {set.isPending && <span className="spinner" />}
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="sm-edit-url">Repository URL</label>
        <input id="sm-edit-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        <span className="hint">Written to .gitmodules and synced into the local clone.</span>
      </div>
      <div className="field">
        <label htmlFor="sm-edit-branch">Branch to track</label>
        <input id="sm-edit-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </div>
      {set.error && <ErrorBox error={set.error} />}
    </Modal>
  );
}

function RemoveModal({ pid, s, onClose }: { pid: string; s: Submodule; onClose: () => void }) {
  const remove = useAction("submodules.remove", { invalidate: [["submodules", pid], ["overview", pid], ["files", pid]], success: `Removed ${s.path}: commit the removal from the workspace` });
  return (
    <Modal
      title="Remove submodule?"
      sub={<span className="mono">{s.path}</span>}
      onClose={remove.isPending ? () => {} : onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" disabled={remove.isPending} onClick={() => remove.mutate({ projectId: pid, path: s.path }, { onSuccess: onClose })}>
            {remove.isPending && <span className="spinner" />}
            {s.dirty ? "Remove, losing local changes" : "Remove"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes the folder <span className="mono">{s.path}</span>, its local clone and its entry in <span className="mono">.gitmodules</span>. The removal is staged: commit it to share it. The repository at <span className="mono">{s.url}</span> is untouched.
      </p>
      {s.dirty > 0 && <div className="err-box">{plural(s.dirty, "uncommitted file")} inside the submodule will be lost.</div>}
    </Modal>
  );
}
