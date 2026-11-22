import { Fragment, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { useAction, useProjects, useSubmodules } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { Project, Submodule } from "../api/types";
import { Avatar } from "../components/Avatar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, ErrorBox, Header, Modal, Seg, swipeProps } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { copyToClipboard, toast } from "../lib/toast";

type Filter = "all" | "attention";
/** A status's look: up to date, something new to take, a drift to settle, broken, not cloned. */
type Tone = "ok" | "new" | "warn" | "bad" | "off";

const short = (sha?: string | null) => sha?.slice(0, 7) ?? "—";

/** Path a URL clones into by default (same rule as the engine). */
const defaultPath = (url: string) => {
  const last = url.trim().replace(/\/+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/, "");
};

const needsYou = (s: Submodule) => s.state !== "clean" || s.dirty > 0 || s.upstreamBehind > 0 || s.staged || s.urlDrift;

/** One status per submodule, most pressing first. */
function status(s: Submodule): [string, Tone] {
  switch (s.state) {
    case "uninitialized":
      return ["Not cloned", "off"];
    case "conflict":
      return ["Conflict", "bad"];
    case "missing":
      return ["Not in index", "bad"];
    case "moved":
      return ["Off its pin", "warn"];
  }
  if (s.urlDrift) return ["URL out of sync", "warn"];
  if (s.upstreamBehind > 0) return [`${s.upstreamBehind} new on remote`, "new"];
  if (s.staged) return ["New pin staged", "new"];
  if (s.dirty > 0) return [plural(s.dirty, "changed file"), "warn"];
  return ["Up to date", "ok"];
}

/** How fresh the "new on remote" counts are: the oldest fetch among the clones, and how many have no fetch time (never
 * fetched, or the last fetch failed). */
function remoteCheck(list: Submodule[]) {
  const cloned = list.filter((s) => s.head).length;
  const times = list.flatMap((s) => (s.head && s.fetchedAt ? [s.fetchedAt] : [])).sort();
  const missing = cloned - times.length;
  return { cloned, missing, oldest: missing ? undefined : times[0] };
}

/** "a", "a and b", "a, b and c". */
const names = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

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
  // Remotes the last check could not reach ("path: error"): their counts stay from the check before.
  const [failed, setFailed] = useState<string[]>([]);
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
  const checkRemotes = () => fetch.mutate({ projectId: pid }, { onSuccess: (r) => setFailed(r.failed) });

  const attention = list.filter(needsYou);
  const groups = [
    { id: "you", label: "Needs you", items: attention },
    { id: "ok", label: "Up to date", items: filter === "all" ? list.filter((s) => !needsYou(s)) : [] },
  ].filter((g) => g.items.length);
  const shown = groups.flatMap((g) => g.items);
  const cur = list.find((s) => s.path === sel) ?? shown[0];
  const behind = list.filter((s) => s.upstreamBehind > 0).length;
  const allBusy = update.isPending && !update.variables?.path;
  const check = remoteCheck(list);
  const checked = !check.cloned ? undefined : check.missing === check.cloned ? "Remotes not checked yet" : check.missing ? `${plural(check.missing, "remote")} not checked` : `Remotes checked ${ago(check.oldest)}`;
  const stale = failed.map((f) => f.split(": ")[0]);

  const openMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 2 });
  };
  const menuItems: MenuItem[] = [
    { id: "update", label: "Update all to their pins", icon: "box", run: () => updateAll(false) },
    { id: "remote", label: "Pull latest for all", icon: "download", hint: "then pin them", run: () => updateAll(true) },
    "sep",
    { id: "sync", label: "Sync all URLs", icon: "swap", hint: "from .gitmodules", run: () => sync.mutate({ projectId: pid }) },
    { id: "fetch", label: "Check remotes for updates", icon: "refresh", run: checkRemotes },
  ];

  const bulk = (cls: string) => (
    <span className={`split-btn ${cls}`}>
      <button
        className="btn btn-sm btn-primary split-main"
        disabled={update.isPending}
        data-tip="Clone missing submodules and check each out at the commit the project pins, nested ones included"
        onClick={() => updateAll(false)}
      >
        {allBusy ? <span className="spinner" /> : <Icon name="box" size={13} />}
        {allBusy ? "Updating…" : "Update all"}
      </button>
      <button className="btn btn-sm btn-primary btn-icon split-more" aria-label="More bulk actions" data-tip="More bulk actions" aria-haspopup="menu" aria-expanded={!!menu} disabled={update.isPending} onClick={openMenu}>
        <Icon name="chevronDown" size={13} />
      </button>
    </span>
  );

  const header = (
    <Header
      title="Submodules"
      sub={project?.name}
      hideWide
      onBack={pane === "detail" ? () => setPane("list") : undefined}
      right={pane === "list" && <button className="btn btn-ghost btn-icon" aria-label="Add a submodule" onClick={() => setAdding(true)}><Icon name="plus" size={16} /></button>}
    />
  );
  // The branch map's toolbar: the title, the filter, then the remote check, Add and the bulk actions. A narrow window's
  // detail pane goes without it, and its list moves Add to the header and Update all under the rows.
  const bar = (
    <div className="map-bar sm-bar" data-detail={pane === "detail" || undefined}>
      <h2 className="map-title hide-narrow">Submodules</h2>
      {project && <span className="pr-where mono ellipsis hide-narrow">{project.name}{list.length > 0 && ` · ${list.length} in .gitmodules`}</span>}
      {list.length > 0 && (
        <Seg<Filter>
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: <>All <span className="faint">{list.length}</span></> },
            { value: "attention", label: <>Needs you <span className="faint">{attention.length}</span></> },
          ]}
        />
      )}
      <span className="grow" />
      {checked && <span className="sm-checked hide-narrow">{checked}</span>}
      {list.length > 0 && (
        <button
          className="btn btn-sm btn-icon"
          aria-label="Check remotes for updates"
          data-tip={`Check remotes for updates (fetch) · ${behind ? `${behind} with new commits on their remote` : "nothing new as of the last check"}`}
          disabled={fetch.isPending}
          onClick={checkRemotes}
        >
          <Busy on={fetch.isPending}><Icon name="refresh" size={14} /></Busy>
        </button>
      )}
      <button className="btn btn-sm hide-narrow" disabled={q.isLoading} onClick={() => setAdding(true)}>
        <Icon name="plus" size={12} />
        Add submodule
      </button>
      {list.length > 0 && bulk("hide-narrow")}
    </div>
  );
  const modals = (
    <>
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

  if (!q.isLoading && !q.error && list.length === 0)
    return (
      <>
        {header}
        {bar}
        <div className="empty-state">
          <span className="sm-mini" aria-hidden="true">
            {["Pinned", "Checked out", "Remote"].map((s) => (
              <span key={s}><span className="sm-glyph" data-glyph={s === "Pinned" ? "pin" : s === "Remote" ? "tip" : "head"} />{s}</span>
            ))}
          </span>
          <h2>No submodules in {project?.name ?? "this project"}</h2>
          <p>A submodule is another repository checked out inside this one. The project pins it to one commit, and this page shows how far your copy and its remote have moved from that pin.</p>
          <button className="btn btn-primary btn-md" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} />
            Add a submodule
          </button>
        </div>
        {modals}
      </>
    );

  return (
    <>
      {header}
      {bar}
      <div className="body split">
        <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Submodules" aria-busy={q.isLoading || undefined}>
          {stale.length > 0 && (
            <div className="err-box sm-stale" role="status" title={failed.join("\n")}>
              <span>
                <strong>Could not reach {plural(stale.length, "remote")}.</strong> <span className="mono">{names(stale)}</span> did not answer, so {stale.length === 1 ? "its" : "their"} new commit
                counts are from the check before.
              </span>
              <button className="btn btn-sm" disabled={fetch.isPending} onClick={checkRemotes}>
                <Busy on={fetch.isPending}>Try again</Busy>
              </button>
            </div>
          )}
          <div className="scroll sm-list">
            {q.isLoading && (
              <>
                <p className="tk-sync"><span className="spinner" />Reading .gitmodules…</p>
                {[64, 48, 56, 40].map((w, i) => (
                  <span key={i} className="sm-skel" aria-hidden="true"><i /><i style={{ width: `${w}%` }} /><i /></span>
                ))}
              </>
            )}
            {q.error && (
              <div className="err-box sm-stale" role="alert">
                <span>
                  <strong>Could not read the submodules.</strong> {q.error.message.replace(/\.$/, "")}. Fix the cause, then try again.
                </span>
                <button className="btn btn-sm" disabled={q.isFetching} onClick={() => q.refetch()}><Busy on={q.isFetching}>Try again</Busy></button>
              </div>
            )}
            {groups.map((g) => (
              <div key={g.id}>
                <div className="group-head">
                  <span>{g.label}</span>
                  <span className="mono">{g.items.length}</span>
                </div>
                <div className="col" style={{ gap: 1 }}>
                  {g.items.map((s) => (
                    <Row
                      key={s.path}
                      s={s}
                      active={s.path === cur?.path}
                      busy={update.isPending && (update.variables?.path === s.path || !update.variables?.path)}
                      onPick={() => {
                        setSel(s.path);
                        setPane("detail");
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {list.length > 0 && shown.length === 0 && (
              <div className="sm-none sm-clear">
                <Icon name="check" size={18} className="c-add" />
                <strong>Nothing needs you</strong>
                <p>
                  {list.length === 1 ? "The submodule sits at its pin with nothing new on its remote" : `All ${list.length} submodules sit at their pins with nothing new on their remotes`}
                  {check.oldest ? ` as of ${ago(check.oldest)}` : ""}.
                </p>
                <button className="btn btn-sm" onClick={() => setFilter("all")}>Show {list.length === 1 ? "it" : `all ${list.length}`}</button>
              </div>
            )}
          </div>
          {list.length > 0 && <div className="sm-foot">{bulk("")}</div>}
        </section>
        <Resizer pane={listW} label="Resize submodule list" />
        <main className="detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
          <div className="detail-inner sm-detail">
            {cur && <Detail key={cur.path} pid={pid} root={project?.path} s={cur} bulkBusy={update.isPending && !update.variables?.path} onOutput={setOutput} />}
            {allBusy && (
              <section className="sm-sec" aria-label="Command output">
                <div className="sm-sec-head">
                  <h2 className="label">Update all</h2>
                  <span className="spinner" />
                  <span>Checking out every submodule at its pin</span>
                </div>
              </section>
            )}
            {output && !allBusy && (
              <section className="sm-sec" aria-label="Command output">
                <div className="sm-sec-head">
                  <h2 className="label">Last command</h2>
                  <span className="ellipsis">{output.title}</span>
                  <span className="grow" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setOutput(undefined)}>Clear</button>
                </div>
                <pre className="pre sm-pre">{output.text}</pre>
              </section>
            )}
          </div>
        </main>
      </div>
      {modals}
    </>
  );
}

/** A row of the list: status ring, path and status, then the last commit's subject, uncommitted files and the commit. */
function Row({ s, active, busy, onPick }: { s: Submodule; active: boolean; busy: boolean; onPick: () => void }) {
  const [label, tone] = status(s);
  const sha = s.head ?? s.recorded;
  return (
    <button className="item-btn sm-row" aria-pressed={active} onClick={onPick}>
      {busy ? <span className="spinner" aria-label="Updating" /> : <span className="sm-ring" data-tone={tone} aria-hidden="true" />}
      <span className="mono ellipsis sm-row-path">{s.path}</span>
      <span className="sm-row-state" data-tone={busy ? undefined : tone}>{busy ? "Updating" : label}</span>
      <span className="sm-row-meta">
        <span className={s.subject ? "ellipsis" : "ellipsis mono"}>{s.subject ?? s.url}</span>
        {s.dirty > 0 && label !== plural(s.dirty, "changed file") && <span className="c-warn" data-tip="Uncommitted files inside">{s.dirty} changed</span>}
        {sha && <span className="mono">{short(sha)}</span>}
      </span>
    </button>
  );
}

function Detail({ pid, root, s, bulkBusy, onOutput }: { pid: string; root?: string; s: Submodule; bulkBusy: boolean; onOutput: (o?: Output) => void }) {
  const nav = useNav();
  const inv = [["submodules", pid], ["overview", pid], ["files", pid]];
  const update = useAction<{ output: string }, { projectId: string; path?: string; remote?: boolean }>("submodules.update", { invalidate: inv });
  const sync = useAction("submodules.sync", { invalidate: inv, success: "URL synced" });
  const stage = useAction("submodules.stage", { invalidate: inv, success: "New pin staged: commit it from the workspace" });
  const addProject = useAction<Project[], { paths: string[] }>("projects.add", { invalidate: [["projects"], ["config"]] });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [label, tone] = status(s);
  const cloned = !!s.head;
  const busy = bulkBusy || update.isPending || sync.isPending || stage.isPending;

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
  const repin = () => stage.mutate({ projectId: pid, path: s.path });
  const syncUrl = () => sync.mutate({ projectId: pid, path: s.path });

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
  const openMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom + 2 });
  };
  const menuItems: MenuItem[] = [
    { id: "update", label: cloned ? "Update to its pin" : "Clone", icon: "box", hint: "nested ones too", disabled: busy, run: () => run(false) },
    { id: "edit", label: "Edit URL or branch", icon: "edit", run: () => setEditing(true) },
    { id: "sync", label: "Sync URL", icon: "swap", hint: "from .gitmodules", disabled: busy || !cloned, why: "Clone it first", run: syncUrl },
    { id: "copy", label: "Copy URL", icon: "copy", run: () => copyToClipboard(s.url) },
    "sep",
    { id: "remove", label: "Remove", icon: "trash", danger: true, run: () => setRemoving(true) },
  ];

  return (
    <>
      <header className="sm-head">
        <div className="sm-title">
          <h1 className="mono">{s.path}</h1>
          <div className="sm-sub">
            <span className="tag" data-tone={tone}>{label}</span>
            {s.name !== s.path && <span>Named <span className="mono c-current">{s.name}</span></span>}
            {s.branch || s.upstream ? (
              <span>
                Tracks <span className="mono c-current">{s.branch ?? s.upstream!.replace(/^origin\//, "")}</span>
                {!s.branch && <span className="faint">, the remote's default</span>}
              </span>
            ) : (
              <span>Tracks the remote's default branch</span>
            )}
          </div>
        </div>
        <div className="sm-acts">
          {s.webUrl && (
            <button className="btn btn-sm" data-tip={s.webUrl} onClick={() => openExternal(s.webUrl!)}>
              <Icon name="external" size={12} />
              <span className="hide-narrow">View repository</span>
            </button>
          )}
          <button className="btn btn-sm hide-narrow" disabled={!cloned || !root || addProject.isPending} data-tip="Work on it in its own tab" onClick={openAsProject}>
            <Icon name="layers" size={12} />
            Open as project
          </button>
          <button className="btn btn-sm btn-icon" aria-label="More submodule actions" data-tip="Update, edit, sync or copy the URL, remove" aria-haspopup="menu" aria-expanded={!!menu} onClick={openMenu}>
            <Icon name="more" size={14} />
          </button>
        </div>
      </header>

      <section className="sm-sec">
        <div className="sm-sec-head">
          <h2 className="label">Where it stands</h2>
          {s.fetchedAt && <span>Remote as of {ago(s.fetchedAt)}</span>}
        </div>
        <PinLine
          s={s}
          busy={busy}
          pending={update.isPending ? (update.variables?.remote ? "latest" : "update") : stage.isPending ? "pin" : undefined}
          act={{ update: () => run(false), latest: () => run(true), pin: repin, commit: () => nav.go({ name: "workspace" }), remove: () => setRemoving(true) }}
        />
        {(s.urlDrift || (cloned && s.dirty > 0)) && (
          <div className="sm-notes">
            {s.urlDrift && (
              <div className="sm-note">
                <Icon name="swap" size={14} className="c-warn" />
                <span>
                  The local clone fetches from <span className="mono">{s.localUrl}</span>, but .gitmodules says <span className="mono">{s.url}</span>.
                </span>
                {/* The white button only when the line has none: one fix leads at a time. */}
                <button className={s.state === "clean" && !s.staged ? "btn btn-sm btn-primary" : "btn btn-sm"} disabled={busy} onClick={syncUrl}><Busy on={sync.isPending}>Sync URL</Busy></button>
              </div>
            )}
            {cloned && s.dirty > 0 && (
              <div className="sm-note">
                <Icon name="alert" size={14} className="c-warn" />
                <span>{plural(s.dirty, "uncommitted file")} inside. Commit or stash them in the submodule before you move it.</span>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="sm-grid">
        <section className="sm-sec">
          <h2 className="label">Details</h2>
          <dl className="sm-kv">
            <dt>Repository</dt>
            <dd>
              {s.webUrl ? (
                <a className="mono ellipsis" href={s.webUrl} title={`Open ${s.webUrl}`} onClick={(e) => { e.preventDefault(); openExternal(s.webUrl!); }}>{s.url}</a>
              ) : (
                <span className="mono ellipsis" title={s.url}>{s.url}</span>
              )}
              <button className="btn btn-ghost btn-sm btn-icon" aria-label="Copy URL" data-tip="Copy URL" onClick={() => copyToClipboard(s.url)}>
                <Icon name="copy" size={11} />
              </button>
            </dd>
            <dt>Tracks</dt>
            <dd>{s.branch ? <span className="mono">{s.branch}</span> : <span className="muted">Remote default{s.upstream ? ` (${s.upstream.replace(/^origin\//, "")})` : ""}</span>}</dd>
            <dt>Pinned at</dt>
            <dd>
              <span className="mono" title={s.recorded ?? undefined}>{short(s.recorded)}</span>
              {s.staged && <span className="muted">staged</span>}
            </dd>
            <dt>Checked out</dt>
            <dd>
              {cloned ? (
                <>
                  <span className="mono" title={s.head ?? undefined}>{short(s.head)}</span>
                  <span className="muted">{s.headBranch ? `on ${s.headBranch}` : "detached"}</span>
                </>
              ) : (
                <span className="muted">Not cloned</span>
              )}
            </dd>
            <dt>Working tree</dt>
            <dd className={s.dirty ? "c-warn" : undefined}>{!cloned ? <span className="muted">Not cloned</span> : s.dirty ? plural(s.dirty, "uncommitted file") : "Clean"}</dd>
          </dl>
        </section>
        {s.subject && (
          <section className="sm-sec">
            <h2 className="label">Last commit checked out</h2>
            <div className="sm-last">
              <strong>{s.subject}</strong>
              <span className="sm-by">
                {s.author && <Avatar name={s.author} size={16} />}
                {[s.author, ago(s.date)].filter(Boolean).join(" · ")}
                <span className="mono">{short(s.head)}</span>
              </span>
            </div>
          </section>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} alignRight label="Submodule actions" items={menuItems} onClose={() => setMenu(null)} />}
      {editing && <EditModal pid={pid} s={s} onClose={() => setEditing(false)} />}
      {removing && <RemoveModal pid={pid} s={s} onClose={() => setRemoving(false)} />}
    </>
  );
}

/** A commit the line stops at, with what can be done there. */
interface Stop {
  key: string;
  glyph: "pin" | "head" | "both" | "tip" | "ghost";
  bad?: boolean;
  label: string;
  sha: string;
  caption?: ReactNode;
  action?: ReactNode;
}
/** The stretch between two stops: drift off the pin, new commits on the remote, nothing, or no remote to compare with. */
interface Link {
  kind: "warn" | "dash" | "solid" | "off";
  text?: ReactNode;
  commits: number;
}

/**
 * Where a submodule stands as one line: the commit the project pins, the one checked out and its remote's tip, merged
 * where they are the same commit. Each action sits under the stop it moves the submodule to. A narrow pane runs it top
 * to bottom.
 */
function PinLine({
  s,
  busy,
  pending,
  act,
}: {
  s: Submodule;
  busy: boolean;
  pending?: "update" | "latest" | "pin";
  act: { update: () => void; latest: () => void; pin: () => void; commit: () => void; remove: () => void };
}) {
  const btn = (label: string, icon: string, run: () => void, primary: boolean, spin: boolean, tip?: string, danger = false) => (
    <button className={`btn btn-sm${primary ? " btn-primary" : ""}${danger ? " btn-danger" : ""}`} disabled={busy} data-tip={tip} onClick={run}>
      {spin ? <span className="spinner" /> : <Icon name={icon} size={12} />}
      {label}
    </button>
  );
  const stops: Stop[] = [];
  const links: Link[] = [];
  const tree = `${s.headBranch ? `On ${s.headBranch}` : "Detached"} · ${s.dirty ? plural(s.dirty, "uncommitted file") : "clean"}`;
  if (s.state === "missing") {
    stops.push({
      key: "none",
      glyph: "ghost",
      bad: true,
      label: "No pointer",
      sha: "no pin",
      caption: "Listed in .gitmodules, but the project holds no pointer for it. Re-add it, or remove the entry.",
      action: btn("Remove entry", "trash", act.remove, false, false, undefined, true),
    });
  } else if (!s.head) {
    stops.push({
      key: "pin",
      glyph: "ghost",
      label: "Pinned",
      sha: short(s.recorded),
      caption: "Declared but not cloned. Its folder is empty.",
      action: btn("Clone", "download", act.update, true, pending === "update", "Clone it and check out its pin"),
    });
  } else {
    const same = s.recorded === s.head;
    // Checked out behind the pin, and only behind: it comes first on the line.
    const older = !same && s.behind > 0 && s.ahead === 0;
    if (s.state === "conflict") {
      stops.push({
        key: "head",
        glyph: "both",
        bad: true,
        label: "Pointer conflicted",
        sha: short(s.head),
        caption: "Check out the commit you want inside it, then pin it.",
        action: btn("Pin checked-out commit", "pin", act.pin, true, pending === "pin", "Record the checked-out commit as the new pin (staged)"),
      });
    } else if (same) {
      stops.push({
        key: "both",
        glyph: "both",
        label: "Pinned · checked out",
        sha: short(s.head),
        caption: s.staged ? "New pin staged, not committed yet" : tree,
        action: s.staged ? btn("Go commit", "commit", act.commit, true, false, "Commit the new pin from the workspace so everyone gets this version") : undefined,
      });
    } else {
      const pin: Stop = {
        key: "pin",
        glyph: "pin",
        label: "Pinned",
        sha: short(s.recorded),
        caption: "What the project records",
        action: btn("Back to pin", "box", act.update, older, pending === "update", "Check out the commit the project pins"),
      };
      const head: Stop = {
        key: "head",
        glyph: "head",
        label: "Checked out",
        sha: short(s.head),
        caption: tree,
        action: btn("Pin this commit", "pin", act.pin, !older, pending === "pin", "Record the checked-out commit as the new pin (staged)"),
      };
      stops.push(...(older ? [head, pin] : [pin, head]));
      links.push({
        kind: "warn",
        text: s.ahead && s.behind ? `${s.ahead} ahead, ${s.behind} behind the pin` : s.ahead ? `${s.ahead} ahead of the pin` : `${s.behind} behind the pin`,
        commits: s.ahead || s.behind,
      });
    }
    const n = s.upstreamBehind;
    if (s.upstream) {
      // The stretch to the remote starts at the stop before it: the pin when the checkout is older than the pin.
      const m = older ? s.pinUpstreamBehind : n;
      links.push(m ? { kind: "dash", text: <>{m} new on <span className="mono">{s.upstream}</span></>, commits: m } : { kind: "solid", text: older ? "nothing newer" : "nothing new", commits: 0 });
      stops.push({
        key: "tip",
        glyph: "tip",
        label: "Remote",
        sha: s.upstream,
        caption: n ? `${plural(n, "commit")} newer than checked out. Pin it afterwards to keep it.` : "Nothing newer",
        action: n ? btn("Pull latest", "download", act.latest, same && !s.staged && !s.urlDrift && s.state === "clean", pending === "latest", `Check out the tip of ${s.upstream}; then pin it to keep it`) : undefined,
      });
    } else {
      links.push({ kind: "off", commits: 0 });
      stops.push({ key: "tip", glyph: "ghost", label: "Remote", sha: "none", caption: "No remote branch to compare with" });
    }
  }
  return (
    <ol className="sm-line" aria-label="Pinned, checked out and remote commits">
      {stops.map((st, i) => (
        <Fragment key={st.key}>
          {i > 0 && (
            <li className="sm-link" data-kind={links[i - 1].kind}>
              <span className="sm-rule" aria-hidden="true">
                {Array.from({ length: Math.min(9, Math.max(0, links[i - 1].commits - 1)) }, (_, t) => (
                  <i key={t} style={{ left: `${((t + 1) * 100) / Math.min(10, links[i - 1].commits)}%` }} />
                ))}
              </span>
              {links[i - 1].text && <em>{links[i - 1].text}</em>}
            </li>
          )}
          <li className="sm-stop" data-next={links[i]?.kind}>
            <span className="sm-glyph" data-glyph={st.glyph} data-bad={st.bad || undefined} aria-hidden="true" />
            <span className={st.bad ? "label c-del" : "label"}>{st.label}</span>
            <span className={st.sha === "none" || st.sha === "no pin" ? "mono sm-sha faint" : "mono sm-sha"}>{st.sha}</span>
            {st.caption && <span className="sm-cap">{st.caption}</span>}
            {st.action}
          </li>
        </Fragment>
      ))}
    </ol>
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
          <button className="btn btn-md" disabled={add.isPending} onClick={onClose}>Cancel</button>
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
          <input id="sm-path" className="input mono" aria-invalid={clash || undefined} placeholder={defaultPath(url) || "libs/ui-kit"} value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sm-branch">
            Branch to track
            <span className="faint">optional</span>
          </label>
          <input id="sm-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <span className="hint">“Pull latest” follows this branch. Leave it empty to follow the remote's default branch.</span>
        </div>
        {url.trim() && target && !clash && (
          <p className="sm-lands">
            <span className="sm-glyph" data-glyph="pin" aria-hidden="true" />
            <span>
              Clones into <span className="mono">{target}</span> and pins the tip of {branch.trim() ? <span className="mono">{branch.trim()}</span> : "the remote's default branch"}.
              {path.trim() && defaultPath(url) && path.trim() !== defaultPath(url) ? <> Leave the folder empty to use <span className="mono">{defaultPath(url)}</span>.</> : null}
            </span>
          </p>
        )}
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
  const branchChanged = branch.trim() !== (s.branch ?? "");
  return (
    <Modal
      title="Edit submodule"
      sub={<span className="mono">{s.path}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" disabled={set.isPending} onClick={onClose}>Cancel</button>
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
        {branchChanged && (
          <span className="hint">
            Was {s.branch ? <span className="mono">{s.branch}</span> : "the remote's default"}. “Pull latest” will follow {branch.trim() ? <span className="mono">{branch.trim()}</span> : "the remote's default branch"}.
          </span>
        )}
      </div>
      {set.error && <ErrorBox error={set.error} />}
    </Modal>
  );
}

function RemoveModal({ pid, s, onClose }: { pid: string; s: Submodule; onClose: () => void }) {
  const remove = useAction("submodules.remove", { invalidate: [["submodules", pid], ["overview", pid], ["files", pid]], success: `Removed ${s.path}: commit the removal from the workspace` });
  return (
    <Modal
      title={<>Remove <span className="mono">{s.path}</span>?</>}
      sub="The removal is staged. Commit it to share it."
      onClose={remove.isPending ? () => {} : onClose}
      footer={
        <>
          <button className="btn btn-md" autoFocus disabled={remove.isPending} onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-danger" disabled={remove.isPending} onClick={() => remove.mutate({ projectId: pid, path: s.path }, { onSuccess: onClose })}>
            {remove.isPending && <span className="spinner" />}
            {s.dirty ? "Remove, losing local changes" : "Remove"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes the folder <span className="mono">{s.path}</span>, its local clone and its entry in <span className="mono">.gitmodules</span>. The repository at <span className="mono">{s.url}</span> is untouched.
      </p>
      {s.dirty > 0 && <div className="err-box">{plural(s.dirty, "uncommitted file")} inside the submodule will be lost.</div>}
      {remove.error && <ErrorBox error={remove.error} />}
    </Modal>
  );
}
