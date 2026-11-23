import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useAction, useCommits, useOverview, usePendingBranches, usePr, usePrDiff, usePrFiles, useProjectPrefs, usePrs } from "../api/hooks";
import { openExternal, rpc, RpcError } from "../api/transport";
import type { BranchView, FileChange, Overview, PrDetail, PrFork, PrSummary, PrThread } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Avatar } from "../components/Avatar";
import { DiffView, type DiffAt, type Review } from "../components/DiffView";
import { Icon } from "../components/Icon";
import { PictureSource } from "../components/Picture";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, Empty, EmptyState, ErrorBox, Header, Loading, Markdown, MEDIA, MediaAsk, Modal, Seg, swipeProps } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored, useStoredFlag } from "../lib/stored";
import { toast } from "../lib/toast";

type Tab = "open" | "review" | "closed";
type View = "conversation" | "files";
type Who = "mine" | "others" | "all";
const GROUPS: PrSummary["state"][] = ["open", "draft", "merged", "closed"];
const GROUP_LABEL: Record<PrSummary["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const EMOJI: [string, string, string][] = [
  ["THUMBS_UP", "👍", "Thumbs up"],
  ["THUMBS_DOWN", "👎", "Thumbs down"],
  ["LAUGH", "😄", "Laugh"],
  ["HOORAY", "🎉", "Hooray"],
  ["HEART", "❤️", "Heart"],
  ["ROCKET", "🚀", "Rocket"],
];

const HOSTS: Record<string, string> = { github: "GitHub", azure: "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket", gitea: "Gitea" };

/** Name of the host the project's pull requests live on, from the cached list. */
function useHost(pid: string) {
  return HOSTS[usePrs(pid).data?.provider ?? ""] ?? "GitHub";
}

/** The open pull request already made from `branch` here. One from a fork is it only when it is the user's: other
 * people's forks have branches of every name. */
export const openPrOf = (items: PrSummary[] | undefined, branch?: string | null) =>
  items?.find((p) => p.head === branch && (p.state === "open" || p.state === "draft") && (!p.fork || p.mine));

export function PullRequests({ initial }: { initial?: number }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const qc = useQueryClient();
  const prs = usePrs(pid);
  const ov = useOverview(pid).data;
  const [tab, setTab] = useState<Tab>("open");
  const [who, setWho] = useStored<Who>("gnx.prs.who", "mine", (s) => (s === "others" || s === "all" ? s : "mine"), String);
  const [search, setSearch] = useStored("gnx.prs.search", "");
  const [sel, setSel] = useState<number | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.prs", 380, 280, 720);
  const all = prs.data?.items ?? [];
  const fork = prs.data?.fork ?? undefined;
  const term = search.trim().toLowerCase();
  const items = all.filter((p) => !term || `#${p.number} ${p.title} ${p.head} ${p.author}`.toLowerCase().includes(term));
  // The open pull request's checks and reviews are fetched on their own, so a sync refreshes them too.
  const sync = () => {
    prs.refetch();
    qc.invalidateQueries({ queryKey: ["pr", pid] });
  };
  // Another repository's pull requests: the list starts over, none of the old one stays picked.
  const pick = useAction("projects.setPrefs", { invalidate: [["pr", pid]] });
  const pickRepo = (to: string) =>
    fork &&
    pick.mutate(
      { projectId: pid, prRepo: { origin: fork.origin, to } },
      {
        onSuccess: () => {
          setSel(undefined);
          qc.resetQueries({ queryKey: ["prs", pid] });
        },
      },
    );
  // Review requests are always on someone else's pull requests, so the author filter skips them.
  const inTab = (p: PrSummary, t: Tab) =>
    t === "review"
      ? p.reviewRequested && p.state !== "merged" && p.state !== "closed"
      : (who === "all" || p.mine === (who === "mine")) && (t === "closed" ? p.state === "merged" || p.state === "closed" : p.state === "open" || p.state === "draft");
  const list = items.filter((p) => inTab(p, tab));
  const current = sel ?? list[0]?.number;
  const errCode = prs.error instanceof RpcError ? prs.error.code : undefined;
  const repo = prs.data && `${prs.data.repo.owner}/${prs.data.repo.repo}`;
  const host = HOSTS[prs.data?.provider ?? ""] ?? "GitHub";
  const opened = (n: number) => {
    setSel(n);
    setPane("detail");
  };

  return (
    <>
      <Header title="Pull requests" sub={`${ov?.project.name ?? ""}${prs.data ? ` · ${host} ${repo}` : ""}`} hideWide onBack={pane === "detail" ? () => setPane("list") : undefined} />
      {prs.error ? (
        <EmptyState
          icon="pr"
          title={errCode === "unsupported" ? "Git provider not supported" : errCode === "not_connected" ? "No Git provider connected" : "Couldn't load pull requests"}
          action={<button className="btn btn-primary btn-md" onClick={() => nav.go({ name: "menu", section: "git" })}>Open Git providers</button>}
        >
          {prs.error.message}
        </EmptyState>
      ) : (
        <>
          {/* The branch map's toolbar: the title, the filters, then search, sync and the new pull request. In a narrow
              window the detail pane goes without it. */}
          <div className="map-bar pr-bar" data-detail={pane === "detail" || undefined}>
            <h2 className="map-title hide-narrow">Pull requests</h2>
            {repo && <span className="pr-where mono ellipsis hide-narrow">{host} · {repo}</span>}
            <Seg<Tab>
              label="Filter"
              value={tab}
              onChange={(t) => { setTab(t); setSel(undefined); }}
              options={(["open", "review", "closed"] as Tab[]).map((t) => ({
                value: t,
                label: <>{t === "open" ? "Open" : t === "review" ? "To review" : "Closed"} <span className="faint">{items.filter((p) => inTab(p, t)).length}</span></>,
              }))}
            />
            {tab !== "review" && (
              <Seg<Who>
                label="Author"
                value={who}
                onChange={(w) => { setWho(w); setSel(undefined); }}
                options={[{ value: "mine", label: "Mine" }, { value: "others", label: "Others" }, { value: "all", label: "All" }]}
              />
            )}
            <span className="grow" />
            <div className="pr-search">
              <Icon name="search" size={13} className="faint" />
              <label htmlFor="pr-q" className="sr-only">Search pull requests</label>
              <input id="pr-q" className="input" placeholder="Search by number, title, branch or author" value={search} onChange={(e) => setSearch(e.target.value, false)} onBlur={() => setSearch(search)} />
            </div>
            <button className="btn btn-sm btn-icon" aria-label="Sync now" data-tip={prs.dataUpdatedAt ? `Sync now · synced ${ago(new Date(prs.dataUpdatedAt).toISOString())}` : "Sync now"} onClick={sync}>
              <Busy on={prs.isFetching}><Icon name="refresh" size={14} /></Busy>
            </button>
            <NewPr pid={pid} repo={repo} fork={fork} onOpened={opened} />
          </div>
          <div className="body split">
            <section aria-label="Pull request list" className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"}>
              {fork?.parent && (
                <div className="master-tools">
                  <ForkPick fork={fork} onPick={pickRepo} />
                </div>
              )}
              <div className="scroll pr-list">
                {(prs.isLoading || pick.isPending) && <Loading />}
                {!prs.isLoading && !pick.isPending && list.length === 0 && <Empty>{term && all.length ? "No pull requests match this search." : "Nothing here."}</Empty>}
                {GROUPS.map((s) => ({ s, items: list.filter((p) => p.state === s) }))
                  .filter((g) => g.items.length)
                  .map(({ s, items }) => (
                    <div key={s}>
                      <div className="group-head">
                        <span>{GROUP_LABEL[s]}</span>
                        <span className="mono">{items.length}</span>
                      </div>
                      <div className="col" style={{ gap: 2 }}>
                        {items.map((p) => (
                          <PrRow key={p.number} p={p} base={ov?.defaultBranch} active={p.number === current} onPick={() => opened(p.number)} />
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
              <div className="pr-legend" aria-hidden="true">
                <span className="label">Legend</span>
                <span className="pr-legend-keys">
                  {(tab === "closed" ? (["merged", "closed"] as const) : (["open", "draft"] as const)).map((s) => (
                    <span key={s}><span className="pr-ring" data-state={s} />{GROUP_LABEL[s]}</span>
                  ))}
                </span>
              </div>
            </section>
            <Resizer pane={listW} label="Resize pull request list" />
            <main className="detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
              {current ? <Detail key={current} pid={pid} number={current} /> : <EmptyState icon="pr" title="No pull request selected">Pick one from the list to read its description, checks and reviews.</EmptyState>}
            </main>
          </div>
        </>
      )}
    </>
  );
}

/** Where a GitHub fork's pull requests go: the repository it was forked from, or the fork itself. Asked until picked. */
function ForkPick({ fork, onPick }: { fork: PrFork; onPick: (to: string) => void }) {
  const to = fork.to ?? fork.origin;
  return (
    <div className="pr-repo">
      <span className="label" aria-hidden="true">Pull requests on</span>
      <Seg<string>
        grid
        label="Pull requests on"
        value={to}
        onChange={(r) => r !== to && onPick(r)}
        options={[fork.parent!, fork.origin].map((r) => ({ value: r, label: <span className="mono ellipsis" data-tip={r} data-tip-overflow>{r}</span> }))}
      />
      {!fork.to && <p className="hint">{fork.origin} is your fork of {fork.parent}. Pick {fork.parent} to open your pull requests there.</p>}
    </div>
  );
}

/** A row of the list: its state as a station ring, the title, then number, author and branch (and its base, when it is
 * not the default branch). */
function PrRow({ p, base, active, onPick }: { p: PrSummary; base?: string; active: boolean; onPick: () => void }) {
  return (
    <button className="item-btn pr-row" aria-pressed={active} onClick={onPick}>
      <span className="pr-ring" data-state={p.state} />
      <span className="pr-row-text">
        <span className="pr-row-title">{p.title}</span>
        <span className="pr-row-meta">
          <span className="mono">#{p.number}</span>
          <span>{p.mine ? "You" : p.author}</span>
          {p.fork && <span className="tag">Fork</span>}
          <span className="mono pr-row-route">
            {p.head}
            {p.base !== base && <> <span className="pr-arrow">→</span> {p.base}</>}
          </span>
        </span>
      </span>
      <span className="pr-row-age">{ago(p.updatedAt)}</span>
    </button>
  );
}

/** The toolbar's button: opens the new pull request modal, then shows the pull request opening (its title and
 * description written by AI takes a while) until it opens. */
function NewPr({ pid, repo, fork, onOpened }: { pid: string; repo?: string; fork?: PrFork; onOpened: (n: number) => void }) {
  const nav = useNav();
  const ov = useOverview(pid).data;
  const branch = nav.selectedBranch ?? ov?.currentBranch;
  const [asking, setAsking] = useState(false);
  const create = useAction<PrSummary>("prs.create", { invalidate: [["prs", pid]], success: (r) => (r.fork ? `Forked ${repo} and opened #${r.number}` : `Opened #${r.number}`) });
  // From the mutation cache, so it still shows after leaving the page and coming back.
  const creating = usePendingBranches("prs.create", pid).length > 0;
  const viaFork = !!fork && !fork.canPush;
  if (!ov) return null;
  return (
    <>
      <button
        className="btn btn-sm btn-primary pr-new-btn"
        aria-disabled={creating || undefined}
        data-tip={creating ? undefined : "Pick its branches; AI writes its title and description"}
        onClick={() => !creating && setAsking(true)}
      >
        <Busy on={creating}><Icon name={viaFork ? "branch" : "sparkle"} size={13} /></Busy>
        <span>{creating ? (viaFork ? "Forking and pushing…" : "Opening pull request…") : "New pull request"}</span>
        {!creating && branch && <span className="pr-new-from mono ellipsis">{branch}</span>}
      </button>
      {asking && (
        <NewPrModal
          pid={pid}
          repo={repo}
          fork={fork}
          start={branch ?? ov.defaultBranch}
          onClose={() => setAsking(false)}
          onShow={(n) => {
            setAsking(false);
            onOpened(n);
          }}
          onCreate={(args) => {
            setAsking(false);
            create.mutate({ projectId: pid, ...args }, { onSuccess: (r) => onOpened(r.number) });
          }}
        />
      )}
    </>
  );
}

/** Branches to pick as a pull request's base or head: every branch here but `not`, the parent, default branch, releases
 * and the checked-out one noted. */
function branchOptions(ov: Overview, not: string | null, parent?: string | null) {
  return ov.branches
    .filter((b) => b.exists && b.name !== not)
    .map((b) => ({
      value: b.name,
      label: b.name,
      hint: b.name === parent ? "parent" : b.name === ov.defaultBranch ? "default" : b.role === "release" ? "release" : b.checkedOut ? "checked out" : undefined,
    }));
}

const COMMITS_SHOWN = 6;

/** A new pull request: the branch it comes from (the selected or checked-out one) and the one it merges into (its
 * parent), each one to change; on a fork of a repository you can push to, the repository it opens on. Under them, the
 * commits it would bring, or why it can't open. */
function NewPrModal({ pid, repo, fork, start, onClose, onShow, onCreate }: {
  pid: string;
  repo?: string;
  fork?: PrFork;
  start: string;
  onClose: () => void;
  onShow: (n: number) => void;
  onCreate: (args: { branch: string; base: string; to?: string }) => void;
}) {
  const ov = useOverview(pid).data!;
  const items = usePrs(pid).data?.items;
  const [from, setFrom] = useState(start);
  // Null: the From branch's parent, following it when From changes.
  const [picked, setPicked] = useState<string | null>(null);
  const bv = ov.branches.find((b) => b.name === from);
  const viaFork = !!fork && !fork.canPush;
  // Origin is your fork of a repository: the pull request opens there (to contribute) or in the fork itself.
  const repos = fork?.parent && fork.canPush ? { parent: fork.parent, origin: fork.origin } : null;
  const [on, setOn] = useState(fork?.to ?? fork?.origin ?? "");
  // The default branch has no base: through a fork, it goes to origin's copy of it.
  const to = picked ?? bv?.parent ?? ov.defaultBranch;
  const self = to === from;
  const commits = useCommits(pid, self ? undefined : from, 50, false, to);
  const already = openPrOf(items, from);
  // Without the row marking where it left its base.
  const list = (commits.data ?? []).filter((c) => !c.base);
  const blocked =
    self && !viaFork
      ? `${from} can't merge into itself: pick another branch to merge into.`
      : bv && !viaFork && (!bv.remote || bv.ahead - bv.upstreamAhead <= 0) && to === bv.parent
        ? `Push commits to ${from} before opening a pull request.`
        : !self && commits.data && list.length === 0
          ? `${from} has no commits that ${to} doesn't have.`
          : undefined;
  const how = viaFork
    ? `You can't push to ${repo}. This forks it to your GitHub account, pushes ${from} there and opens the pull request on ${repo}.`
    : repos
      ? on === repos.parent
        ? `Pushes ${from} to your fork ${repos.origin}, then opens the pull request on ${repos.parent}.`
        : `Between two branches of your fork ${repos.origin}. ${repos.parent} sees nothing.`
      : null;
  const ready = !already && !blocked && (self || !!commits.data);
  return (
    <Modal
      title="New pull request"
      sub="AI writes its title and description from the changes."
      onClose={onClose}
      width={580}
      footer={
        <>
          <span className="grow" />
          <button className="btn btn-md" onClick={onClose}>Back</button>
          <button className="btn btn-md btn-primary" disabled={!ready} onClick={() => onCreate({ branch: from, base: to, ...(repos && { to: on }) })}>
            <Icon name={viaFork ? "branch" : "sparkle"} size={13} />
            {viaFork ? "Fork and open pull request" : "Open pull request"}
          </button>
        </>
      }
    >
      <div className="pr-new">
        {repos && (
          <div className="field">
            <span className="flabel">Open it on</span>
            <Seg<string>
              grid
              label="Open it on"
              value={on}
              onChange={setOn}
              options={[
                { value: repos.parent, label: <span className="pr-on"><span className="mono ellipsis">{repos.parent}</span><small>Contribute to the original</small></span> },
                { value: repos.origin, label: <span className="pr-on"><span className="mono ellipsis">{repos.origin}</span><small>Your fork</small></span> },
              ]}
            />
          </div>
        )}
        {how && <p className="hint">{how}</p>}
        <div className="pr-from-to">
          <div className="field">
            <label htmlFor="pr-from">From</label>
            <MenuChoice
              id="pr-from"
              className="select menu-select mono"
              label="From"
              search="Filter branches"
              value={from}
              options={branchOptions(ov, null)}
              onChange={(b) => {
                setFrom(b);
                setPicked(null);
              }}
            />
          </div>
          <span className="pr-arrow" aria-hidden="true">→</span>
          <div className="field">
            <label htmlFor="pr-to">To</label>
            {/* shortcut: on a fork, the branches listed are origin's, not those of the repository it opens on; list that one's from its host if they differ. */}
            <MenuChoice id="pr-to" className="select menu-select mono" label="To" search="Filter branches" value={to} options={branchOptions(ov, viaFork ? null : from, bv?.parent)} onChange={setPicked} />
          </div>
        </div>
        {already ? (
          <div className="pr-already">
            <span>
              #{already.number} is already open from <span className="mono">{from}</span> into <span className="mono">{already.base}</span>. Commits you push to it show there.
            </span>
            <button className="btn btn-sm" onClick={() => onShow(already.number)}>Show #{already.number}</button>
          </div>
        ) : blocked ? (
          <div className="err-box warn">{blocked}</div>
        ) : (
          !self && (
            <div className="pr-preview" aria-busy={commits.isFetching || undefined}>
              <div className="pr-preview-head">
                <span className="label">{commits.data ? plural(list.length, "commit") : "Commits"}</span>
                {commits.isFetching && <span className="spinner" />}
              </div>
              {commits.error && <div style={{ padding: "8px 12px" }}><ErrorBox error={commits.error} /></div>}
              {list.slice(0, COMMITS_SHOWN).map((c) => (
                <div key={c.sha} className="pr-preview-row">
                  <span className="mono faint">{c.sha.slice(0, 7)}</span>
                  <span className="ellipsis">{c.subject}</span>
                  <span className="mono faint">{ago(c.date)}</span>
                </div>
              ))}
              {list.length > COMMITS_SHOWN && <span className="pr-preview-more">and {plural(list.length - COMMITS_SHOWN, "more commit")}</span>}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}

function Detail({ pid, number }: { pid: string; number: number }) {
  const nav = useNav();
  const q = usePr(pid, number);
  const host = useHost(pid);
  const prefs = useProjectPrefs(pid);
  const ov = useOverview(pid).data;
  const media = prefs.dialogs.prMedia;
  // Pictures behind the host's sign-in (private repository, GitLab or Gitea upload, Azure DevOps attachment) load through the app.
  const pictures = useMemo(() => ({ key: `pr:${pid}`, load: (url: string) => rpc<string>("prs.picture", { projectId: pid, url }) }), [pid]);
  const source = media ? pictures : null;
  const inv = [["pr", pid, number], ["prs", pid]];
  // The branch map refreshes on its own: the merge fetches origin, which says the project changed.
  const merge = useAction("prs.merge", {
    invalidate: inv,
    // Shows it merged at once (out of the open list), while the refetches come back.
    patch: (qc) => {
      qc.setQueryData<PrDetail>(["pr", pid, number], (p) => p && { ...p, state: "merged" });
      qc.setQueryData<{ items: PrSummary[] }>(["prs", pid], (l) => l && { ...l, items: l.items.map((p) => (p.number === number ? { ...p, state: "merged" } : p)) });
    },
    success: `Merged #${number}`,
  });
  // From the mutation cache, so it still shows after picking another pull request and coming back.
  const merging = useMutationState({
    filters: { mutationKey: ["prs.merge"], status: "pending" },
    select: (m) => m.state.variables as { projectId?: string; number?: number } | undefined,
  }).some((v) => v?.projectId === pid && v.number === number);
  const update = useAction("prs.update", { invalidate: inv, success: `Saved to ${host}` });
  const close = useAction<{ deleteError: string | null }>("prs.close", {
    invalidate: [...inv, ["overview", pid], ["files", pid], ["worktrees"]],
    success: (r) => (r.deleteError ? undefined : `Closed #${number}`),
  });
  const reopen = useAction("prs.close", { invalidate: inv, success: `Reopened #${number}` });
  const gen = useAction<{ title: string; body: string }>("prs.generate");
  const move = useAction("prs.retarget", { invalidate: inv });
  // The branch picked to merge into instead, asked about before it changes; and whether AI rewrites the text for it.
  const [retarget, setRetarget] = useState<string | null>(null);
  // The ⋯ menu of a narrow pane, under its button.
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [rewrite, setRewrite] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [filter, setFilter] = useState<"all" | "open">("all");
  const [view, setView] = useState<View>("conversation");
  // A conversation to see in the code: the files view opens on its file and line.
  const [focus, setFocus] = useState<PrThread | null>(null);
  const files = usePrFiles(pid, q.data);

  if (q.isLoading) return <Loading />;
  if (q.error) return <EmptyState icon="pr" title="Couldn't load pull request">{q.error.message}</EmptyState>;
  const d = q.data!;
  const open = d.state === "open" || d.state === "draft";
  const pending = d.checks.filter((c) => c.status === "run" || c.status === "wait").length;
  const unresolved = d.threads.filter((t) => t.resolvable && !t.resolved).length;
  const threads = filter === "open" ? d.threads.filter((t) => t.resolvable && !t.resolved) : d.threads;
  const hidden = !media && (MEDIA.test(d.body) || d.threads.some((t) => t.comments.some((c) => MEDIA.test(c.body))));
  // A short description sits above the conversation, a long one beside it, each half the pane.
  // shortcut: counts characters and lines, not the drawn height; measure it if short ones still look lost beside the talk.
  const short = !(media && MEDIA.test(d.body)) && d.body.length < 400 && d.body.split("\n").length <= 6;
  // Its branch here, when it is not a fork's: its type and how far behind its base it is.
  const bv = d.fork ? undefined : ov?.branches.find((b) => b.name === d.head);
  const startEdit = () => {
    setTitle(d.title);
    setBody(d.body);
    setEditing(true);
  };
  const showCode = (t: PrThread) => {
    setFocus(t);
    setView("files");
  };

  // What moves it on, at the end of its line: merge it, resolve its conflicts, or reopen it.
  const action =
    open && !d.conflict && d.state !== "draft" ? (
      <button className="btn btn-primary btn-sm" disabled={merging || pending > 0} onClick={() => merge.mutate({ projectId: pid, number })}>
        {merging && <span className="spinner" />}
        {merging ? `Merging into ${d.base}…` : `Merge into ${d.base}`}
      </button>
    ) : open && d.conflict ? (
      <button
        className="btn btn-primary btn-sm"
        onClick={() => {
          nav.selectBranch(d.head);
          nav.go({ name: "workspace" });
        }}
      >
        <Icon name="sparkle" size={12} />
        Resolve conflicts with AI
      </button>
    ) : d.state === "closed" ? (
      <button className="btn btn-primary btn-sm" disabled={reopen.isPending} onClick={() => reopen.mutate({ projectId: pid, number, reopen: true })}>
        {reopen.isPending && <span className="spinner" />}
        Reopen
      </button>
    ) : null;

  return (
    <div className="detail-inner pr-detail">
      <header className="pr-strip">
        <div className="pr-strip-top">
          {editing ? (
            <div className="field grow">
              <label htmlFor="pr-title">Title</label>
              <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          ) : (
            <div className="pr-title">
              <h1>{d.title}</h1>
              {open && (
                <button className="btn btn-ghost btn-icon btn-sm pr-wide" aria-label="Edit title and description" onClick={startEdit}>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          )}
          <div className="pr-meta">
            <span className="mono faint">#{d.number}</span>
            <span className="pr-meta-by">
              <Avatar name={d.author} size={16} />
              {d.mine ? "Opened by you" : `Opened by ${d.author}`} · updated {ago(d.updatedAt)}
            </span>
            {d.fork && <span className="tag" data-tip="Its branch lives in a fork">Fork</span>}
          </div>
          <span className="grow" />
          <div className="pr-actions">
            {open && (
              <button className="btn btn-sm" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>Review</button>
            )}
            {open && (
              <button
                className="btn btn-sm"
                disabled={gen.isPending}
                onClick={() =>
                  gen.mutate(
                    { projectId: pid, branch: d.head, base: d.base },
                    {
                      onSuccess: (r) => {
                        setTitle(r.title);
                        setBody(r.body);
                        setEditing(true);
                      },
                    },
                  )
                }
              >
                <Busy on={gen.isPending}><Icon name="sparkle" size={12} /></Busy>
                Rewrite with AI
              </button>
            )}
            <button className="btn btn-sm pr-wide" onClick={() => openExternal(d.url)}>
              <Icon name="external" size={12} />
              Open on {host}
            </button>
            {open && (
              <button className="btn btn-sm btn-icon btn-danger pr-wide" aria-label="Close pull request" data-tip="Close pull request" disabled={close.isPending} onClick={() => setConfirmClose(true)}>
                <Icon name="prClosed" size={14} />
              </button>
            )}
            {/* Narrow, the rest goes in a menu. */}
            <button
              className="btn btn-sm btn-icon pr-narrow"
              aria-label="More actions"
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMore({ x: r.right, y: r.bottom + 2 });
              }}
            >
              <Icon name="more" size={14} />
            </button>
            {more && (
              <ContextMenu
                x={more.x}
                y={more.y}
                alignRight
                label="More actions"
                onClose={() => setMore(null)}
                items={[
                  { id: "open", label: `Open on ${host}`, icon: "external", run: () => openExternal(d.url) },
                  ...(open
                    ? ([
                        { id: "edit", label: "Edit title and description", icon: "edit", run: startEdit },
                        "sep",
                        { id: "close", label: "Close pull request", icon: "prClosed", danger: true, disabled: close.isPending, run: () => setConfirmClose(true) },
                      ] as MenuItem[])
                    : []),
                ]}
              />
            )}
          </div>
        </div>
        <PrLine
          d={d}
          bv={bv}
          host={host}
          action={action}
          bases={open && ov ? branchOptions(ov, d.head, bv?.parent) : undefined}
          onBase={setRetarget}
          onUnresolved={() => {
            setView("conversation");
            setFocus(null);
            setFilter("open");
          }}
        />
      </header>

      {confirmClose && (
        <Modal
          title={`Close #${number}?`}
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn btn-md" autoFocus onClick={() => setConfirmClose(false)}>
                Back
              </button>
              <button className="btn btn-md btn-danger" disabled={close.isPending} onClick={() =>
                  close.mutate(
                    { projectId: pid, number, ...(deleteBranch && !d.fork && { deleteBranch: d.head }) },
                    {
                      onSuccess: (r) => {
                        if (r.deleteError) toast(`Closed #${number}, but the branch was kept: ${r.deleteError}`, "error");
                        setConfirmClose(false);
                      },
                    },
                  )
                }
              >
                {close.isPending && <span className="spinner" />}
                {deleteBranch ? "Close and delete branch" : "Close without merging"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {deleteBranch ? (
              <>Abandons the pull request on {host} and deletes <span className="mono">{d.head}</span> here and on origin, with its worktree. Commits not merged elsewhere are lost.</>
            ) : (
              <>Abandons the pull request on {host}. The branch <span className="mono">{d.head}</span> and its commits stay, and you can reopen it later.</>
            )}
          </p>
          {/* A fork's branch lives in the fork: one of that name here is someone else's work. */}
          {!d.fork && (
            <label className="check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
              <span>Also delete <span className="mono">{d.head}</span>, locally and on origin</span>
            </label>
          )}
        </Modal>
      )}

      {retarget && (
        <Modal
          title={`Change #${number}'s target to ${retarget}?`}
          sub={<>From <span className="mono">{d.base}</span> to <span className="mono">{retarget}</span> on {host}.</>}
          onClose={() => setRetarget(null)}
          width={480}
          footer={
            <>
              <span className="grow" />
              <button className="btn btn-md" onClick={() => setRetarget(null)}>Back</button>
              <button
                className="btn btn-md btn-primary"
                disabled={move.isPending}
                onClick={() =>
                  move.mutate(
                    { projectId: pid, number, base: retarget },
                    {
                      onSuccess: () => {
                        toast(`#${number} now merges into ${retarget}`);
                        // Rewritten into the editor: saved only once looked at.
                        if (rewrite)
                          gen.mutate(
                            { projectId: pid, branch: d.head, base: retarget },
                            {
                              onSuccess: (r) => {
                                setTitle(r.title);
                                setBody(r.body);
                                setEditing(true);
                              },
                            },
                          );
                        setRetarget(null);
                      },
                    },
                  )
                }
              >
                {move.isPending && <span className="spinner" />}
                Change target
              </button>
            </>
          }
        >
          <label className="check pr-rewrite">
            <input type="checkbox" checked={rewrite} onChange={() => setRewrite(!rewrite)} />
            <span>
              Rewrite the title and description with AI
              <small>They were written from the changes against {d.base}. You see the new ones before they are saved.</small>
            </span>
          </label>
        </Modal>
      )}

      {reviewOpen && (
        <div className="pr-review">
          <ReviewForm pid={pid} d={d} onDone={() => setReviewOpen(false)} />
        </div>
      )}

      <div className="pr-tabs" role="tablist" aria-label="Show">
        {(["conversation", "files"] as View[]).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => {
              setView(v);
              setFocus(null);
            }}
          >
            <Icon name={v === "files" ? "file" : "comment"} size={13} />
            {v === "files" ? "Files changed" : "Conversation"}
            <span className="faint mono">{v === "files" ? (files.data?.length ?? "") : d.threads.length}</span>
          </button>
        ))}
      </div>

      {view === "files" && (
        <PictureSource.Provider value={source}>
          <PrFiles key={focus?.id} pid={pid} d={d} media={media} focus={focus} />
        </PictureSource.Provider>
      )}

      {view === "conversation" && (
        <div className="pr-conv" data-stacked={short || undefined}>
          <section className="pr-desc" aria-label="Description">
            <div className="pr-sec-head">
              <h2>Description</h2>
              <span className="grow" />
              {open && !editing && (
                <button className="btn btn-sm btn-ghost" onClick={startEdit}>
                  <Icon name="edit" size={12} />
                  Edit
                </button>
              )}
            </div>
            {hidden && !editing && <MediaAsk onShow={() => prefs.setDialogs({ prMedia: true })} />}
            {editing ? (
              <div className="col">
                <label htmlFor="pr-body" className="sr-only">Description</label>
                <textarea id="pr-body" className="textarea mono" rows={14} style={{ fontSize: 12.5 }} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="row wrap">
                  <span className="grow" />
                  <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={!title.trim() || update.isPending} onClick={() => update.mutate({ projectId: pid, number, title, body }, { onSuccess: () => setEditing(false) })}>
                    Save to {host}
                  </button>
                </div>
              </div>
            ) : d.body ? (
              <div className="pr-body">
                <PictureSource.Provider value={source}>
                  <Markdown text={d.body} html={media} breaks />
                </PictureSource.Provider>
              </div>
            ) : (
              <span className="muted">No description.</span>
            )}
          </section>

          <section className="pr-talk" aria-label="Conversation">
            <div className="pr-sec-head">
              <h2>Conversation</h2>
              <span className="hint">{d.threads.length ? `${unresolved} unresolved of ${d.threads.length}` : ""}</span>
              <span className="grow" />
              <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "open", label: "Unresolved" }]} />
            </div>
            {threads.length > 0 && (
              <div className="pr-rail">
                <PictureSource.Provider value={source}>
                  {threads.map((t) => (
                    <div key={t.id} className="pr-rail-item" data-open={(t.resolvable && !t.resolved) || undefined}>
                      <ThreadView pid={pid} number={number} t={t} media={media} onShowCode={t.path ? () => showCode(t) : undefined} />
                    </div>
                  ))}
                </PictureSource.Provider>
              </div>
            )}
            {threads.length === 0 && <span className="muted">{d.threads.length === 0 ? "No comments yet." : "Every conversation is resolved."}</span>}
            <div className="pr-talk-new">
              <NewComment pid={pid} number={number} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const CHECK_ORDER = { fail: 0, run: 1, wait: 2, pass: 3 };
const CHECK_WORD = { pass: "Passed", fail: "Failed", run: "Running", wait: "Waiting" };
const VOTE_WORD = { approve: "Approved", changes: "Changes requested", comment: "Commented", pending: "Review requested" };
/** Checks listed before "Show all": the failing and running ones come first. */
const CHECKS_SHOWN = 6;

type Gate = { key: "checks" | "review" | "talk"; label: string; value: ReactNode; state: "pass" | "fail" | "wait"; running?: boolean };

/** The pull request as a line of the branch map: its branch's box, a station for each gate it passes (checks, review,
 * conversations), then its base. The route runs solid up to the first gate not passed. Checks and Review open what
 * they hold, Conversations shows the unresolved ones. After the base: what holds it back, and `action`. */
function PrLine({ d, bv, host, action, bases, onBase, onUnresolved }: {
  d: PrDetail;
  bv?: BranchView;
  host: string;
  action: ReactNode;
  /** Branches it can merge into instead: its base then opens them to pick from, while it is open. */
  bases?: { value: string; label: string; hint?: string }[];
  onBase: (base: string) => void;
  onUnresolved: () => void;
}) {
  const [pop, setPop] = useState<"checks" | "review" | null>(null);
  const [all, setAll] = useState(false);
  const line = useRef<HTMLDivElement>(null);
  // Closed by a press anywhere else or Escape, like a menu.
  useEffect(() => {
    if (!pop) return;
    const down = (e: PointerEvent) => !line.current?.contains(e.target as Node) && setPop(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [pop]);
  const count = (s: string) => d.checks.filter((c) => c.status === s).length;
  const [passed, failing, pending] = [count("pass"), count("fail"), count("run") + count("wait")];
  const approvals = d.reviewers.filter((r) => r.vote === "approve").length;
  const asked = d.reviewers.filter((r) => r.vote === "changes").map((r) => r.login);
  const unresolved = d.threads.filter((t) => t.resolvable && !t.resolved).length;
  const checks = [...d.checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
  const sentence =
    d.state === "merged"
      ? `Merged into ${d.base}.`
      : d.state === "closed"
        ? "Closed without merging."
        : d.conflict
          ? `Conflicts with ${d.base}: resolve them on ${d.head} to merge it.`
          : failing
            ? `${plural(failing, "check")} failing.`
            : pending
              ? `Merge waits for ${plural(pending, "check")} still running.`
              : d.state === "draft"
                ? `A draft: mark it ready for review on ${host} to merge it.`
                : asked.length
                  ? `${asked.join(", ")} asked for changes.`
                  : approvals
                    ? `Ready to merge into ${d.base}.`
                    : d.reviewers.length
                      ? "Waiting for a review."
                      : "No review asked for yet.";
  const gates: Gate[] = [
    ...(d.checks.length
      ? [{ key: "checks", label: "Checks", value: <>{passed}<small>/{d.checks.length}</small></>, state: failing ? "fail" : pending ? "wait" : "pass", running: pending > 0 } as Gate]
      : []),
    { key: "review", label: "Review", value: <>{approvals}<small>/{d.reviewers.length}</small></>, state: asked.length ? "fail" : approvals ? "pass" : "wait" },
    { key: "talk", label: "Unresolved", value: unresolved, state: unresolved ? "wait" : "pass" },
  ];
  const merged = d.state === "merged";
  const shut = d.state === "closed";
  // How far the route runs: through every gate passed in a row (all of them once merged, none once closed).
  const reach = merged ? gates.length : shut ? -1 : (gates.findIndex((g) => g.state !== "pass") + 1 || gates.length + 1) - 1;
  const seg = (i: number) => <span className="pr-seg" data-on={(i <= reach && !shut) || undefined} />;
  const kind = bv?.role === "branch" && bv.kind;
  return (
    <div className="pr-line" ref={line}>
      <span className="pr-line-head">
        <span className="pr-line-box" data-draft={d.state === "draft" || undefined}>
          {kind && <span className="map-kind">{kind}</span>}
          <span className="mono ellipsis" data-tip={d.head} data-tip-overflow>{kind ? bv.short : d.head}</span>
        </span>
        {bv && bv.parent === d.base && bv.behind > 0 && (
          <span className="pr-chip mono" data-tip={`${plural(bv.behind, "commit")} of ${d.base} not in ${d.head} yet`}>
            <span className="c-del">↓{bv.behind}</span>
          </span>
        )}
      </span>
      {gates.map((g, i) => (
        <Fragment key={g.key}>
          {seg(i)}
          <span className="pr-gate-wrap">
            <button
              className="pr-gate"
              aria-expanded={g.key === "talk" ? undefined : pop === g.key}
              aria-label={g.key === "talk" ? `${plural(unresolved, "unresolved conversation")}, show them` : undefined}
              onClick={() => (g.key === "talk" ? onUnresolved() : setPop(pop === g.key ? null : g.key))}
            >
              <span className="pr-stn" data-state={g.state === "pass" ? "pass" : g.state === "fail" ? "fail" : i === reach ? "now" : undefined} />
              <span className="label">{g.label}</span>
              <b>{g.value}</b>
              {g.running && <span className="pulse pr-check-dot run" />}
            </button>
            {pop === "checks" && g.key === "checks" && (
              <div className="pr-pop" role="group" aria-label="Checks">
                <ul className="pr-status-list">
                  {(all ? checks : checks.slice(0, CHECKS_SHOWN)).map((c, i) => {
                    const row = (
                      <>
                        <span className={`pulse pr-check-dot ${c.status}`} />
                        <span className="grow ellipsis">{c.name}</span>
                        <span className={c.status === "fail" ? "c-del" : "muted"}>{CHECK_WORD[c.status]}</span>
                        {c.url && <Icon name="external" size={11} className="faint" />}
                      </>
                    );
                    return <li key={i}>{c.url ? <button className="pr-status-row" data-tip="Open its logs" onClick={() => openExternal(c.url!)}>{row}</button> : <div className="pr-status-row">{row}</div>}</li>;
                  })}
                </ul>
                {checks.length > CHECKS_SHOWN && (
                  <button className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
                    {all ? "Show fewer" : `Show all ${checks.length}`}
                  </button>
                )}
              </div>
            )}
            {pop === "review" && g.key === "review" && (
              <div className="pr-pop" role="group" aria-label="Reviewers">
                {d.reviewers.length === 0 ? (
                  <span className="hint">No reviewers yet.</span>
                ) : (
                  <ul className="pr-status-list">
                    {d.reviewers.map((r) => (
                      <li key={r.login} className="pr-status-row">
                        <Avatar name={r.login} size={18} />
                        <span className="grow ellipsis">{r.login}</span>
                        <span className={r.vote === "changes" ? "c-warn" : r.vote === "approve" ? "c-current" : "faint"}>
                          {r.vote === "approve" && <Icon name="check" size={11} />}
                          {VOTE_WORD[r.vote]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </span>
        </Fragment>
      ))}
      {seg(gates.length)}
      <span className="pr-line-base">
        <span className="pr-stn" data-main data-state={merged ? "pass" : undefined} />
        {bases ? (
          <MenuChoice className="pr-base-pick" label={`Merges into ${d.base}: change it`} search="Filter branches" value={d.base} options={bases} onChange={(b) => b !== d.base && onBase(b)} />
        ) : (
          d.base
        )}
      </span>
      <span className="pr-line-say">{sentence}</span>
      {action}
    </div>
  );
}

/** The lines picked in the open file, first and last in diff order, and the comment being written on them. */
interface Note {
  path: string;
  /** The commits the diff was drawn at, `base...head`: once the pull request moves on, the lines no longer stand. */
  drawn: string;
  from: DiffAt;
  to: DiffAt;
  text: string;
}

/** Hosts whose comments take a suggestion block, which the author applies in one click. */
const SUGGESTS = ["GitHub", "GitLab"];

/** A suggestion block holding `lines`, the current text of the lines a comment is on: the change starts as them, to
 * edit. GitLab counts the lines it replaces up from the commented one, the last. The fence outgrows any run of
 * backticks in the code. */
function suggestionBlock(host: string, lines: string[]): string {
  const ticks = Math.max(2, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((m) => m.length)));
  const fence = "`".repeat(ticks + 1);
  const info = host === "GitLab" ? `suggestion:-${lines.length - 1}+0` : "suggestion";
  return `${fence}${info}\n${lines.join("\n")}\n${fence}`;
}

const NO_THREADS: PrThread[] = [];

/** A conversation's line in a file's diff, in the version it numbers: `o12` in the base, `n12` in the head. */
const lineKey = (t: PrThread) => `${t.old ? "o" : "n"}${t.line}`;

/** The selector of a conversation's line among the diff's rows (DiffView numbers them `data-o`, `data-n`). */
const rowOf = (t: PrThread) => `[data-${t.old ? "o" : "n"}="${t.line}"]`;

/** Below this width the code pane has no room for the conversations' margin: a conversation opens over the code. */
const MARGIN_ROOM = 760;

/** The pull request's changed files and the diff of one, its conversations in a margin beside their lines (over the
 * code, one at a time, when the pane is narrow). Pressing a line number starts a comment there; on hosts that take
 * ranges, shift-click or a drag takes in more lines. */
function PrFiles({ pid, d, media, focus }: { pid: string; d: PrDetail; media: boolean; focus: PrThread | null }) {
  const host = useHost(pid);
  // Bitbucket's and Gitea's APIs put a comment on one line only.
  const ranges = host === "GitHub" || host === "GitLab" || host === "Azure DevOps";
  const qc = useQueryClient();
  const files = usePrFiles(pid, d);
  const list = files.data ?? [];
  const [sel, setSel] = useState(focus?.path ?? undefined);
  const file = list.find((f) => f.path === sel) ?? list[0];
  const diff = usePrDiff(pid, d, file);
  const [mode, setMode] = useStored<"unified" | "split">("gnx.prs.diff", "unified", (s) => (s === "split" ? "split" : "unified"), String);
  const [anyway, setAnyway] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // "Collapse all": the margin hidden, for every pull request.
  const [hidden, setHidden] = useStoredFlag("gnx.prs.marginHidden");
  const [active, setActive] = useState<string | null>(focus?.id ?? null);
  const [wide, setWide] = useState(true);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWide(e.contentRect.width >= MARGIN_ROOM));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const post = useAction("prs.lineComment", { invalidate: [["pr", pid, d.number]], success: `Comment posted to ${host}` });
  const byFile = useMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const t of d.threads) if (t.path) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [d.threads]);
  const here = (file && byFile.get(file.path)) || NO_THREADS;
  const onLines = useMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const t of here) if (t.line != null && !t.outdated) m.set(lineKey(t), [...(m.get(lineKey(t)) ?? []), t]);
    return m;
  }, [here]);
  // Lines the diff draws, in its order, so the conversations on others (outdated, or out of its hunks) show above it.
  const drawn = useMemo(() => {
    const order = new Map<string, number>();
    for (const h of diff.data ?? []) {
      let [o, n] = [h.oldStart, h.newStart];
      for (const l of h.lines) {
        if (l.kind !== "+") order.set(`o${o++}`, order.size);
        if (l.kind !== "-") order.set(`n${n++}`, order.size);
      }
    }
    return order;
  }, [diff.data]);
  // The conversations on drawn lines, in the diff's order: the margin's cards, and what the arrows step through.
  const placed = useMemo(
    () => here.filter((t) => t.line != null && !t.outdated && drawn.has(lineKey(t))).sort((a, b) => drawn.get(lineKey(a))! - drawn.get(lineKey(b))!),
    [here, drawn],
  );
  const elsewhere = diff.data ? here.filter((t) => !placed.includes(t)) : [];
  // The conversation picked (in the conversation list, or with the arrows), brought into view once its file's diff is
  // drawn: its line, or its own box above the diff.
  const [toFocus, setToFocus] = useState(focus?.id);
  useEffect(() => {
    if (!toFocus || !diff.data) return;
    const t = placed.find((x) => x.id === toFocus);
    const el = t ? document.querySelector(`.pr-code ${rowOf(t)}`) : document.getElementById(`pr-thread-${toFocus}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    // Again once the lines above it are laid out: off screen they only had an estimated height.
    requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
    setToFocus(undefined);
  }, [toFocus, diff.data, anyway, placed]);

  /** Opens a conversation: in the margin, which a collapsed margin comes back for (and stays), or over the code when
   * the pane is narrow. `scroll` brings its line into view. */
  const pick = (id: string | null, scroll = false) => {
    setActive(id);
    if (id && wide && hidden) setHidden(false);
    if (id && scroll) setToFocus(id);
  };
  // The arrows step through the open conversations, from the picked one.
  const from = placed.findIndex((t) => t.id === active);
  const next = placed.slice(from + 1).find((t) => !t.resolved);
  const prev = [...(from < 0 ? placed : placed.slice(0, from))].reverse().find((t) => !t.resolved);
  const open = placed.filter((t) => !t.resolved);
  const shown = wide ? undefined : placed.find((t) => t.id === active);
  const lineThreads = (at: DiffAt) => [...(at.kind !== "+" ? (onLines.get(`o${at.old}`) ?? []) : []), ...(at.kind !== "-" ? (onLines.get(`n${at.new}`) ?? []) : [])];

  const at = `${d.baseSha}...${d.headSha}`;
  const picked = note && file && note.path === file.path && note.drawn === at ? { from: note.from, to: note.to } : null;
  // A suggestion replaces lines of the head: both ends of the picked lines must be there (lines removed in between
  // are left out).
  const suggestion =
    picked && SUGGESTS.includes(host) && picked.from.kind !== "-" && picked.to.kind !== "-"
      ? () => {
          const lines = diff.data?.[picked.from.hunk]?.lines.slice(picked.from.i, picked.to.i + 1).filter((l) => l.kind !== "-");
          return lines?.length ? suggestionBlock(host, lines.map((l) => l.text)) : null;
        }
      : undefined;
  // Only the comment box sends, and it shows only while the lines stand at `d`'s commits.
  const send = () => {
    if (!note || !file || !note.text.trim()) return;
    const pos = (a: DiffAt) => ({ kind: a.kind, old: a.old, new: a.new });
    const one = note.from.hunk === note.to.hunk && note.from.i === note.to.i;
    post.mutate(
      { projectId: pid, number: d.number, path: file.path, from: file.from, head: d.headSha, start: one ? undefined : pos(note.from), end: pos(note.to), endLen: note.to.len, body: note.text },
      {
        onSuccess: () => setNote(null),
        // A push since the diff loaded: the pull request comes back with its new head, and its diff with it.
        onError: () => void qc.invalidateQueries({ queryKey: ["pr", pid, d.number] }),
      },
    );
  };
  const review: Review = {
    ranges,
    picked,
    onPick: (from, to) => file && setNote((n) => ({ path: file.path, drawn: at, from, to, text: n?.path === file.path ? n.text : "" })),
    below: (at) =>
      note &&
      picked &&
      picked.to.hunk === at.hunk &&
      picked.to.i === at.i && (
        <div className="col">
          <NoteForm host={host} note={note} ranges={ranges} busy={post.isPending} suggestion={suggestion} onText={(text) => setNote({ ...note, text })} onCancel={() => setNote(null)} onSend={send} />
        </div>
      ),
    threads: placed.length
      ? (at) => {
          const ts = lineThreads(at);
          return ts.length ? { count: ts.length, resolved: ts.every((t) => t.resolved), on: ts.some((t) => t.id === active) } : null;
        }
      : undefined,
    onThreads: (at) => {
      const ts = lineThreads(at);
      // Pressed again, the picked conversation's line lets it go.
      if (ts.some((t) => t.id === active)) pick(null);
      else pick((ts.find((t) => !t.resolved) ?? ts[0])?.id ?? null);
    },
    margin: wide && !hidden && placed.length > 0 && <PrMargin pid={pid} number={d.number} threads={placed} active={active} media={media} mode={mode} onPick={(id) => pick(id)} />,
  };

  if (!d.headSha) return <EmptyState icon="pr" title="Couldn't read the changes">{host} named no head commit for this pull request.</EmptyState>;
  if (files.isLoading) return <Loading />;
  if (files.error) return <EmptyState icon="pr" title="Couldn't read the changes">{files.error.message}</EmptyState>;
  if (!file) return <EmptyState icon="pr" title="No changes">This pull request changes no files.</EmptyState>;
  const cut = file.path.lastIndexOf("/");
  return (
    <section className="pr-files" aria-label="Files changed">
      <nav className="pr-files-list" aria-label="Changed files">
        {list.map((f) => (
          <PrFileRow key={f.path} f={f} active={f === file} threads={byFile.get(f.path)?.length ?? 0} onPick={() => { setSel(f.path); setAnyway(false); setActive(null); }} />
        ))}
      </nav>
      <div className="pr-code" ref={measure}>
        <div className="code-file pr-code-bar">
          <span className="code-path mono ellipsis grow" data-tip={file.from ? `${file.from} → ${file.path}` : file.path} data-tip-overflow>
            {file.from && <span className="faint">{file.from} → </span>}
            <span className="faint">{file.path.slice(0, cut + 1)}</span>
            <b>{file.path.slice(cut + 1)}</b>
          </span>
          <span className="hint ellipsis hide-narrow">{ranges ? "Click or drag line numbers, or a hunk's Comment, to comment" : "Click a line number to comment"}</span>
          {placed.length > 0 && (
            <>
              <StepButtons prev={prev && (() => pick(prev.id, true))} next={next && (() => pick(next.id, true))} />
              {wide && (
                <button className="btn btn-sm" onClick={() => { setHidden(!hidden); setActive(null); }}>
                  {hidden ? "Expand all" : "Collapse all"}
                </button>
              )}
            </>
          )}
          <Seg<"unified" | "split"> label="Diff mode" value={mode} onChange={setMode} options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
        </div>
        {elsewhere.length > 0 && (
          <div className="pr-elsewhere">
            {elsewhere.map((t) => <ThreadView key={t.id} pid={pid} number={d.number} t={t} media={media} />)}
          </div>
        )}
        <div className="diff">
          {diff.isLoading && <Loading />}
          {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
          {diff.data && diff.data.length > 0 && <DiffView path={file.path} hunks={diff.data} mode={mode} review={review} anyway={anyway} onAnyway={() => setAnyway(true)} />}
          {diff.data && diff.data.length === 0 && (
            <div className="empty" style={{ fontFamily: "var(--sans)" }}>{file.from ? `Renamed from ${file.from}, no other changes.` : "Binary file, or no changes to its text."}</div>
          )}
        </div>
        {shown && (
          <PrThreadPane
            pid={pid}
            number={d.number}
            t={shown}
            media={media}
            count={open.includes(shown) ? `${open.indexOf(shown) + 1} / ${open.length}` : null}
            prev={prev && (() => pick(prev.id, true))}
            next={next && (() => pick(next.id, true))}
            onClose={() => setActive(null)}
          />
        )}
      </div>
    </section>
  );
}

/** Up and down through a file's open conversations; an arrow with none that way is off. */
function StepButtons({ prev, next }: { prev?: () => void; next?: () => void }) {
  return (
    <>
      <button className="btn btn-ghost btn-icon btn-sm" aria-label="Previous conversation" data-tip="Previous conversation" disabled={!prev} onClick={prev}>
        <Icon name="chevronUp" size={14} />
      </button>
      <button className="btn btn-ghost btn-icon btn-sm" aria-label="Next conversation" data-tip="Next conversation" disabled={!next} onClick={next}>
        <Icon name="chevronDown" size={14} />
      </button>
    </>
  );
}

/** The conversations on a file's drawn lines, in a margin beside the diff, each level with its line where it can be:
 * the picked one open, the others as their first lines, the resolved ones folded. A card that would cover the one above
 * moves down; the picked one keeps its line and moves the ones above it up. `mode` redraws the lines it lines up with. */
function PrMargin({ pid, number, threads, active, media, mode, onPick }: { pid: string; number: number; threads: PrThread[]; active: string | null; media: boolean; mode: string; onPick: (id: string) => void }) {
  const rail = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = rail.current;
    const lines = el?.previousElementSibling;
    if (!el || !lines) return;
    const place = () => {
      const cards = [...el.children] as HTMLElement[];
      const origin = el.getBoundingClientRect().top;
      const want = cards.map((c) => (lines.querySelector(c.dataset.row!)?.getBoundingClientRect().top ?? origin) - origin);
      const h = cards.map((c) => c.offsetHeight);
      const gap = 8;
      // Each card at its line or under the one before; the picked one at its line, the ones above moving up only when
      // they would cover it, the ones below it after it. No room above it: all from the top down instead.
      const down = (from: number, tops: number[]) => {
        for (let i = from; i < cards.length; i++) tops[i] = Math.max(want[i], i ? tops[i - 1] + h[i - 1] + gap : 0);
        return tops;
      };
      const on = cards.findIndex((c) => c.dataset.on);
      let tops = down(0, [...want]);
      if (on >= 0) {
        tops[on] = want[on];
        down(on + 1, tops);
        for (let i = on - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - h[i] - gap);
        if (tops[0] < 0) tops = down(0, [...want]);
      }
      cards.forEach((c, i) => (c.style.top = `${tops[i]}px`));
      el.style.minHeight = cards.length ? `${tops[cards.length - 1] + h[cards.length - 1] + gap}px` : "";
    };
    place();
    // Again when lines wrap or get laid out, and when a card opens, folds or grows.
    const ro = new ResizeObserver(place);
    ro.observe(lines);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  }, [threads, active, mode]);
  // The picked card comes into view, its line beside it.
  useEffect(() => {
    rail.current?.querySelector("[data-on]")?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <aside ref={rail} className="pr-margin" aria-label="Conversations">
      {threads.map((t) => {
        const on = t.id === active;
        return (
          <div key={t.id} className={`pr-mcard${on ? " on" : ""}`} data-row={rowOf(t)} data-on={on || undefined}>
            {on || t.resolved ? <ThreadView pid={pid} number={number} t={t} media={media} inline expand={on} /> : <ThreadCard t={t} media={media} onOpen={() => onPick(t.id)} />}
          </div>
        );
      })}
    </aside>
  );
}

/** A conversation in the margin until picked: who started it, when, the start of what they wrote, how many replies. */
function ThreadCard({ t, media, onOpen }: { t: PrThread; media: boolean; onOpen: () => void }) {
  const first = t.comments[0];
  const replies = t.comments.length - 1;
  return (
    <article id={`pr-thread-${t.id}`} className="thread pr-card" onClick={onOpen}>
      <button className="pr-card-head" aria-label={`Open the conversation${first ? ` started by ${first.author}` : ""}`}>
        {first && <Avatar name={first.author} size={18} decorative />}
        <span className="ellipsis" style={{ fontWeight: 500 }}>{first?.author}</span>
        <span className="faint grow" style={{ fontSize: 12 }}>{first ? ago(first.createdAt) : ""}</span>
      </button>
      {first && (
        <div className="pr-card-body">
          <Markdown text={first.body} html={media} breaks />
        </div>
      )}
      {replies > 0 && (
        <span className="pr-card-foot">
          <Icon name="comment" size={11} />
          {replies === 1 ? "1 reply" : `${replies} replies`}
        </span>
      )}
    </article>
  );
}

/** A conversation over the code pane when the pane has no room for the margin (the whole screen on a phone): the
 * lines it is on, its comments, the reply box kept at the bottom. Back, or Escape, returns to the diff where it was. */
function PrThreadPane({ pid, number, t, media, count, prev, next, onClose }: { pid: string; number: number; t: PrThread; media: boolean; count: string | null; prev?: () => void; next?: () => void; onClose: () => void }) {
  useEffect(() => {
    // Not from a box being typed in: Escape there would throw its text away.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("textarea, input")) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <section className="pr-thread-pane" aria-label="Conversation">
      <header className="hdr">
        <button className="hdr-icon" aria-label="Back to the code" onClick={onClose}>
          <Icon name="back" size={16} />
        </button>
        <div className="hdr-title">
          <strong>Conversation</strong>
          {count && <span className="muted mono">{count}</span>}
        </div>
        <div className="hdr-tools">
          <StepButtons prev={prev} next={next} />
        </div>
      </header>
      <div className="pr-thread-pane-body">
        <ThreadView key={t.id} pid={pid} number={number} t={t} media={media} expand />
      </div>
    </section>
  );
}

function PrFileRow({ f, active, threads, onPick }: { f: FileChange; active: boolean; threads: number; onPick: () => void }) {
  const cut = f.path.lastIndexOf("/");
  const color = ({ A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod" } as Record<string, string>)[f.status] ?? "faint";
  return (
    <button className="file-btn" aria-pressed={active} onClick={onPick}>
      <span className={`file-st ${color}`}>{f.status}</span>
      <span className="grow ellipsis" data-tip={f.from ? `${f.from} → ${f.path}` : f.path} data-tip-overflow>
        <span>{f.path.slice(cut + 1)}</span> <span className="faint" style={{ fontSize: 11.5 }}>{f.path.slice(0, Math.max(cut, 0))}</span>
      </span>
      {threads > 0 && (
        <span className="pr-file-threads" aria-label={plural(threads, "conversation")}>
          <Icon name="comment" size={11} />
          {threads}
        </span>
      )}
      <span className="row mono file-nums">
        <span className="c-add">{f.additions > 0 && `+${f.additions}`}</span>
        <span className="c-del">{f.deletions > 0 && `−${f.deletions}`}</span>
      </span>
    </button>
  );
}

/** The comment being written on the picked lines, under the last one. `suggestion` gives the block "Suggest change"
 * puts in, when the host takes one on these lines. */
function NoteForm({
  host,
  note,
  ranges,
  busy,
  suggestion,
  onText,
  onCancel,
  onSend,
}: {
  host: string;
  note: Note;
  ranges: boolean;
  busy: boolean;
  suggestion?: () => string | null;
  onText: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const num = (a: DiffAt) => (a.kind === "-" ? a.old : a.new);
  const one = note.from.hunk === note.to.hunk && note.from.i === note.to.i;
  const what = one ? `${note.to.kind === "-" ? "removed line" : "line"} ${num(note.to)}` : `lines ${num(note.from)} to ${num(note.to)}`;
  // Opened under lines near the bottom of the view: brought in whole, buttons too.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const area = useRef<HTMLTextAreaElement>(null);
  // The block goes where the caret is (over a selection), on lines of its own; the caret then ends its code, to edit.
  const suggest = () => {
    const block = suggestion?.();
    const el = area.current;
    if (!block || !el) return;
    const [before, after] = [note.text.slice(0, el.selectionStart), note.text.slice(el.selectionEnd)];
    const head = before + (before && !before.endsWith("\n") ? "\n" : "");
    onText(head + block + (after && !after.startsWith("\n") ? "\n" : "") + after);
    const caret = head.length + block.lastIndexOf("\n");
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };
  return (
    <div ref={box} className="note-form">
      <label htmlFor="pr-note" className="sr-only">Comment on {what}</label>
      <textarea
        ref={area}
        id="pr-note"
        className="textarea"
        // Tall enough to show a suggestion's code, up to 14 lines.
        rows={Math.min(14, Math.max(3, note.text.split("\n").length))}
        autoFocus
        placeholder={`Comment on ${what}…`}
        value={note.text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="row wrap" style={{ margin: 0, gap: 6 }}>
        {suggestion && (
          <button className="btn btn-sm" data-tip={`Put in the picked lines as a change the author can apply on ${host}`} onClick={suggest}>
            <Icon name="suggest" size={12} />
            Suggest change
          </button>
        )}
        <span className="hint grow">
          {what[0].toUpperCase() + what.slice(1)}
          {ranges ? " · shift-click or drag line numbers for more" : ` · ${host} comments on one line at a time`}
        </span>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!note.text.trim() || busy} onClick={onSend}>
          <Busy on={busy}>{null}</Busy>
          Comment
        </button>
      </div>
    </div>
  );
}

function ReviewForm({ pid, d, onDone }: { pid: string; d: PrDetail; onDone: () => void }) {
  const host = useHost(pid);
  // GitHub and Gitea refuse votes from a PR's author; the others take them.
  const authorOnly = d.mine && (host === "GitHub" || host === "Gitea");
  const opts: [string, string, string][] = authorOnly
    ? [["comment", "Comment", "General feedback, no explicit approval."]]
    : [
        ["comment", "Comment", "General feedback, no explicit approval."],
        ["approve", "Approve", "Ready to merge."],
        ["changes", "Request changes", "Must be addressed before merging."],
      ];
  const [vote, setVote] = useState(opts[0][0]);
  const [text, setText] = useState("");
  const submit = useAction("prs.review", { invalidate: [["pr", pid, d.number]], success: `Review posted to ${host}` });
  const draft = useAction<{ text: string }>("prs.draftReview");
  return (
    <section aria-label="Submit review" className="col card" style={{ padding: 16, gap: 12 }}>
      {/* Not a .section, so the h2's browser margins and .row's 10px margin are reset here. */}
      <div className="row wrap" style={{ margin: "0 0 4px", alignItems: "baseline", rowGap: 2 }}>
        <h2 className="grow" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Submit review</h2>
        <span className="hint">{host === "GitHub" || host === "Gitea" ? `Posted to ${host} as a review` : `Posted to ${host} as your vote and a comment`}</span>
      </div>
      <div className="field">
        <label htmlFor="pr-review-text">Summary <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
        <textarea id="pr-review-text" className="textarea" rows={3} placeholder="Overall feedback for the author…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ fontSize: 12, fontWeight: 500, padding: "0 0 6px" }}>Review type</legend>
        {opts.map(([v, t, s]) => (
          <button key={v} type="button" className="radio-card" aria-pressed={vote === v} onClick={() => setVote(v)}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      {authorOnly && <span className="hint">You opened this pull request, so GitHub only lets you comment on it.</span>}
      <div className="row wrap" style={{ margin: 0 }}>
        <button className="btn" disabled={draft.isPending} onClick={() => draft.mutate({ projectId: pid, number: d.number }, { onSuccess: (r) => setText(r.text) })}>
          <Busy on={draft.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
          Draft with AI
        </button>
        <span className="grow" />
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={submit.isPending || (vote === "comment" && !text.trim())} onClick={() => submit.mutate({ projectId: pid, number: d.number, vote, body: text }, { onSuccess: onDone })}>
          Submit review
        </button>
      </div>
    </section>
  );
}

/** `inline`: drawn beside its line, so without its file and code. `expand` opens it even when resolved (resolved ones
 * start folded). `onShowCode` opens it in the files view. */
function ThreadView({ pid, number, t, media, inline, expand, onShowCode }: { pid: string; number: number; t: PrThread; media: boolean; inline?: boolean; expand?: boolean; onShowCode?: () => void }) {
  const host = useHost(pid);
  // Azure DevOps comments only take likes, Bitbucket's none.
  const emoji = host === "Azure DevOps" ? EMOJI.slice(0, 1) : host === "Bitbucket" ? [] : EMOJI;
  // Gitea's API can't resolve a conversation.
  const resolvable = t.resolvable && host !== "Gitea";
  const [open, setOpen] = useState(expand || !t.resolved);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  useEffect(() => setOpen(expand || !t.resolved), [t.resolved, expand]);
  const inv = [["pr", pid, number]];
  const reply = useAction("prs.reply", { invalidate: inv });
  const comment = useAction("prs.comment", { invalidate: inv });
  const resolve = useAction("prs.resolve", { invalidate: inv });
  const react = useAction("prs.react", { invalidate: inv });
  const save = useAction("prs.editComment", { invalidate: inv });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const ai = useAction<{ text: string }>("prs.draftReply");
  const improve = useAction<{ text: string }>("prs.draftReply");
  const first = t.comments[0];
  const file = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : null;

  if (!open) {
    return (
      <article id={`pr-thread-${t.id}`} className="thread row" style={{ padding: "8px 14px", gap: 10 }}>
        <span className="tag">Resolved</span>
        {file && !inline && <span className="mono faint" style={{ fontSize: 11.5 }}>{file}</span>}
        <span className="ellipsis grow muted">{first ? `${first.author}: ${first.body}` : ""}</span>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Show</button>
      </article>
    );
  }
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const done = { onSuccess: () => setDraft("") };
    if (t.resolvable && first?.databaseId) reply.mutate({ projectId: pid, number, threadId: t.id, commentId: first.databaseId, body: text }, done);
    else comment.mutate({ projectId: pid, number, body: text }, done);
  };
  return (
    <article id={`pr-thread-${t.id}`} className="thread">
      {file && !inline && (
        <>
          <div className="thread-file">
            <Icon name="file" size={12} />
            <span className="grow ellipsis">{file}</span>
            {t.outdated && <span className="tag">Outdated</span>}
            {onShowCode && (
              <button className="btn btn-ghost btn-sm" onClick={onShowCode}>
                <Icon name="file" size={11} />
                Show in code
              </button>
            )}
          </div>
          {t.snippet.length > 0 && (
            <div className="snippet">
              {t.snippet.map((l, i) => (
                <div key={i} className={l.startsWith("+") ? "c-add" : l.startsWith("-") ? "c-del" : "muted"}>{l}</div>
              ))}
            </div>
          )}
        </>
      )}
      {t.comments.map((c) => (
        <div key={c.id} className="comment">
          <Avatar name={c.author} size={28} />
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500 }}>{c.author}</span>
              {t.review && (
                <span className={`tag ${t.review === "changes" ? "c-warn" : ""}`}>
                  {{ approve: "Approved", changes: "Requested changes", comment: "Reviewed" }[t.review]}
                </span>
              )}
              <span className="faint grow" style={{ fontSize: 12 }}>{ago(c.createdAt)}</span>
              {c.canEdit && editing?.id !== c.id && (
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Edit comment" onClick={() => setEditing({ id: c.id, text: c.body })}>
                  <Icon name="edit" size={12} />
                </button>
              )}
            </div>
            {editing?.id === c.id ? (
              <div className="col" style={{ gap: 6 }}>
                <label htmlFor={`edit-${c.id}`} className="sr-only">Edit comment</label>
                <textarea id={`edit-${c.id}`} className="textarea" rows={3} autoFocus value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} />
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    disabled={!editing.text.trim() || improve.isPending}
                    title="Fix spelling and grammar and smooth the wording"
                    onClick={() =>
                      improve.mutate(
                        { projectId: pid, number, threadId: t.id, draft: editing.text, editing: c.id },
                        { onSuccess: (r) => setEditing((e) => (e?.id === c.id ? { id: c.id, text: r.text } : e)) },
                      )
                    }
                  >
                    <Busy on={improve.isPending}><Icon name="sparkle" size={11} className="c-acc" /></Busy>
                    Improve
                  </button>
                  <span className="grow" />
                  <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!editing.text.trim() || editing.text === c.body || save.isPending}
                    onClick={() => save.mutate({ projectId: pid, commentId: c.id, body: editing.text }, { onSuccess: () => setEditing(null) })}
                  >
                    <Busy on={save.isPending}>{null}</Busy>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="comment-body"><Markdown text={c.body} html={media} breaks /></div>
            )}
            <div className="row wrap" style={{ gap: 6, position: "relative" }}>
              {c.reactions.map((r) => (
                <button key={r.content} className="reaction" aria-pressed={r.mine} aria-label={`${r.content} ${r.count}${r.mine ? ", you reacted" : ""}`} onClick={() => react.mutate({ projectId: pid, subjectId: c.id, content: r.content, add: !r.mine })}>
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              ))}
              {emoji.length > 0 && (
                <button className="reaction" aria-label="Add reaction" aria-expanded={picker === c.id} onClick={() => setPicker(picker === c.id ? null : c.id)}>
                  <Icon name="smile" size={13} stroke={1.3} />
                </button>
              )}
              {picker === c.id && (
                <div role="group" aria-label="Pick a reaction" className="row card" style={{ gap: 2, padding: 4 }}>
                  {emoji.map(([content, e, label]) => (
                    <button key={content} className="btn btn-ghost btn-sm" aria-label={label} onClick={() => { react.mutate({ projectId: pid, subjectId: c.id, content, add: true }); setPicker(null); }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      <div className="col" style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--line)" }}>
        <label htmlFor={`reply-${t.id}`} className="sr-only">Reply</label>
        <textarea id={`reply-${t.id}`} className="textarea" rows={2} placeholder="Reply…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row wrap">
          <button
            className="btn btn-sm"
            disabled={ai.isPending}
            title={draft.trim() ? "Fix spelling and grammar and smooth the wording of your reply" : undefined}
            onClick={() => ai.mutate({ projectId: pid, number, threadId: t.id, draft }, { onSuccess: (r) => setDraft(r.text) })}
          >
            <Busy on={ai.isPending}><Icon name="sparkle" size={11} className="c-acc" /></Busy>
            {draft.trim() ? "Improve reply" : "Draft reply"}
          </button>
          <span className="grow" />
          {resolvable && !t.resolved && (
            <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: true })}>
              <Icon name="check" size={11} />
              Resolve
            </button>
          )}
          {t.resolved && (
            <>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
              {resolvable && <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: false })}>Reopen</button>}
            </>
          )}
          <button className="btn btn-sm btn-primary" disabled={!draft.trim() || reply.isPending || comment.isPending} onClick={send}>Reply</button>
        </div>
      </div>
    </article>
  );
}

function NewComment({ pid, number }: { pid: string; number: number }) {
  const [text, setText] = useState("");
  const comment = useAction("prs.comment", { invalidate: [["pr", pid, number]] });
  return (
    <div className="col" style={{ marginTop: 10 }}>
      <label htmlFor="pr-new-comment" className="sr-only">New comment</label>
      <textarea id="pr-new-comment" className="textarea" rows={3} placeholder="Leave a comment on this pull request…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" disabled={!text.trim() || comment.isPending} onClick={() => comment.mutate({ projectId: pid, number, body: text }, { onSuccess: () => setText("") })}>
          Comment
        </button>
      </div>
    </div>
  );
}
