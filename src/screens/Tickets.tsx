import { useState, type CSSProperties } from "react";

import { useAction, useFixVersions, useOverview, useProjects, useTicketStatuses, useTickets } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { Suggestion, Ticket } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Adf } from "../components/Adf";
import { Avatar } from "../components/Avatar";
import { ContextMenu, SEARCH_ABOVE } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, Empty, EmptyState, ErrorBox, Header, Loading, Markdown, releaseTagLabel, Seg, swipeProps } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { toast } from "../lib/toast";

const STATUS: Record<Ticket["status"], [string, string]> = {
  todo: ["To do", "muted"],
  progress: ["In progress", "c-mod"],
  review: ["In review", "c-acc"],
  ready: ["Ready to merge", "c-add"],
  done: ["Done", "c-add"],
};
const SRC = { jira: "Jira", trello: "Trello", asana: "Asana" };
const ADD = "\0add";

export function Tickets({ initial }: { initial?: string }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const [mine, setMine] = useStored("gnx.tickets.mine", true);
  const [sprint, setSprint] = useStored("gnx.tickets.sprint", true);
  const q = useTickets(pid, mine, sprint);
  const ov = useOverview(pid).data;
  const projects = useProjects().data ?? [];
  const home = (x: Ticket) => projects.find((p) => p.id === x.branchProject)?.name;
  const [place, setPlace] = useStored("gnx.tickets.place", "all");
  const [group, setGroup] = useStored<"release" | "status">("gnx.tickets.group", "status");
  const [search, setSearch] = useStored("gnx.tickets.search", "");
  const [sel, setSel] = useState<string | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.tickets", 400, 280, 720);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const setRel = useAction("tickets.setRelease", { invalidate: [["tickets", pid], ["overview", pid]] });
  const triage = useAction<Suggestion[]>("tickets.triage", {
    success: (r) => (r.length ? `AI suggested a release for ${plural(r.length, "ticket")}` : "Nothing to triage"),
  });

  const open = (ov?.releases ?? []).filter((r) => r.open);
  const all = q.data?.tickets ?? [];
  const term = search.trim().toLowerCase();
  const base = all.filter((t) => (!mine || t.mine) && (!term || `${t.key} ${t.title}`.toLowerCase().includes(term)));
  const places = [...new Set(all.map((x) => x.place))].sort();
  const shown = places.includes(place) ? place : "all";
  const visible = base.filter((t) => shown === "all" || t.place === shown);
  const groups =
    group === "release"
      ? [...open.map((r) => ({ id: r.version, label: `${releaseTagLabel(r.tag)} · v${r.version}` })), { id: "", label: "Unplanned" }]
      : (Object.keys(STATUS) as Ticket["status"][]).map((s) => ({ id: s, label: STATUS[s][0] }));
  const grouped = groups
    .map((g) => ({ ...g, items: visible.filter((t) => (group === "release" ? (open.some((r) => r.version === t.release) ? t.release : "") === g.id : t.status === g.id)) }))
    .filter((g) => g.items.length);
  const t = all.find((x) => x.key === sel) ?? visible[0];
  const unplanned = visible.filter((x) => !x.release && x.status !== "done").length;

  if (q.isLoading) return (<><Header title="Tickets" hideWide /><Loading /></>);
  if (q.data && q.data.sources.length === 0) {
    return (
      <>
        <Header title="Tickets" sub={ov?.project.name} hideWide />
        <EmptyState
          icon="ticket"
          title="No ticket tracker connected"
          action={<button className="btn btn-primary btn-md" onClick={() => nav.go({ name: "settings", section: "tools" })}>Connect a tracker</button>}
        >
          Connect Jira, Trello or Asana to see tickets here, plan them into releases and start a branch from one.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <Header
        title="Tickets"
        sub={[ov?.project.name, shown === "all" ? "" : shown].filter(Boolean).join(" · ")}
        hideWide
        onBack={pane === "detail" ? () => setPane("list") : undefined}
      />
      {q.error ? (
        <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <ErrorBox error={q.error} />
            <div className="row" style={{ marginTop: 14, justifyContent: "center" }}>
              <button className="btn" onClick={() => q.refetch()}><Busy on={q.isFetching}>Retry</Busy></button>
              <button className="btn btn-primary" onClick={() => nav.go({ name: "settings", section: "tools" })}>Open settings</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="body split">
          <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Ticket list">
            <div className="master-tools">
              <label htmlFor="tk-q" className="sr-only">Search tickets</label>
              <div className="row" style={{ gap: 6, margin: 0 }}>
                <input id="tk-q" className="input grow" placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value, false)} onBlur={() => setSearch(search)} />
                <button className="btn btn-icon" aria-label="Sync now" data-tip={q.data?.syncedAt ? `Sync now · synced ${ago(q.data.syncedAt)}` : "Sync now"} onClick={() => q.refetch()}>
                  <Busy on={q.isFetching}><Icon name="refresh" size={13} /></Busy>
                </button>
              </div>
              <MenuChoice
                className="select menu-select"
                style={{ height: 30, width: "100%" }}
                label="Tracker"
                value={shown}
                options={[
                  { value: "all", label: `All trackers · ${base.length}` },
                  ...places.map((p) => ({ value: p, label: `${p} · ${base.filter((x) => x.place === p).length}` })),
                  { value: ADD, label: "Connect another tracker…" },
                ]}
                onChange={(v) => (v === ADD ? nav.go({ name: "settings", section: "tools" }) : setPlace(v))}
              />
              <div className="row wrap">
                <Seg label="Group by" value={group} onChange={setGroup} options={[{ value: "release", label: "By release" }, { value: "status", label: "By status" }]} />
                <label className="check" style={{ minHeight: 28 }}>
                  <input type="checkbox" checked={mine} onChange={() => setMine(!mine)} />
                  <span>Assigned to me</span>
                </label>
                {q.data?.sources.includes("jira") && (
                  <label className="check" style={{ minHeight: 28 }} data-tip="Jira tickets in an open sprint; hides Trello and Asana">
                    <input type="checkbox" checked={sprint} onChange={() => setSprint(!sprint)} />
                    <span>Active sprint</span>
                  </label>
                )}
              </div>
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
              {grouped.map((g) => (
                <div key={g.id || "none"}>
                  <div className="group-head" style={{ fontSize: 13, fontWeight: 700 }}>
                    <span className={group === "status" ? STATUS[g.id as Ticket["status"]][1] : undefined}>{g.label}</span>
                    <span>{g.items.length}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    {g.items.map((x) => (
                      <button key={x.key} className="item-btn" style={{ gap: 1, padding: "7px 12px" }} aria-pressed={x.key === t?.key} onClick={() => { setSel(x.key); setPane("detail"); }}>
                        <span className="row" style={{ gap: 8, margin: "0 0 2px", fontSize: 11.5 }}>
                          <Avatar name={x.assignee} />
                          <span className="mono faint">{x.key}</span>
                          <span className={STATUS[x.status][1]} style={{ fontSize: 13 }}>{x.statusLabel || STATUS[x.status][0]}</span>
                          <span className="faint ellipsis grow">{x.kind}</span>
                          {suggestions[x.key] && !x.release && <Icon name="sparkle" size={11} className="c-acc" />}
                          <span className="faint">{SRC[x.source]}</span>
                        </span>
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{x.title}</span>
                        <span className="mono faint ellipsis" style={{ fontSize: 11.5, marginTop: 8 }}>{x.branch ? [home(x), x.branch].filter(Boolean).join(" · ") : "No branch"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {grouped.length === 0 &&
                (all.length ? (
                  <Empty>No tickets match these filters.</Empty>
                ) : (
                  <Empty>
                    No open tickets from {(q.data?.sources ?? []).map((s) => SRC[s as keyof typeof SRC]).join(", ")}. Check the query in Settings.
                    <div style={{ marginTop: 14 }}>
                      <button className="btn" onClick={() => nav.go({ name: "settings", section: "tools" })}>Open settings</button>
                    </div>
                  </Empty>
                ))}
            </div>
            {unplanned > 0 && open.length > 0 && (
              <div className="master-tools" style={{ borderBottom: 0, borderTop: "1px solid var(--line)" }}>
                <button
                  className="btn btn-primary"
                  style={{ height: 48, fontSize: 13.5 }}
                  disabled={triage.isPending}
                  onClick={() => triage.mutate({ projectId: pid }, { onSuccess: (r) => setSuggestions(Object.fromEntries(r.map((s) => [s.key, s]))) })}
                >
                  <Busy on={triage.isPending}><Icon name="sparkle" size={13} /></Busy>
                  Triage {unplanned} unplanned with AI
                </button>
              </div>
            )}
          </section>
          <Resizer pane={listW} label="Resize ticket list" />
          <main className="detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
            {t ? (
              <TicketDetail
                t={t}
                home={home(t)}
                releases={open.map((r) => ({ version: r.version, label: `v${r.version} · ${releaseTagLabel(r.tag)}`, branch: r.branch }))}
                suggestion={!t.release ? suggestions[t.key] : undefined}
                onRelease={(v) => setRel.mutate({ projectId: pid, key: t.key, release: v })}
                onDismiss={() => {
                  const n = { ...suggestions };
                  delete n[t.key];
                  setSuggestions(n);
                }}
              />
            ) : (
              <EmptyState icon="ticket" title="No ticket selected">Pick one from the list to see its details and start a branch from it.</EmptyState>
            )}
          </main>
        </div>
      )}
    </>
  );
}

function TicketDetail({
  t,
  home,
  releases,
  suggestion,
  onRelease,
  onDismiss,
}: {
  t: Ticket;
  home?: string;
  releases: { version: string; label: string; branch: string }[];
  suggestion?: Suggestion;
  onRelease: (v: string) => void;
  onDismiss: () => void;
}) {
  const nav = useNav();
  const statuses = useTicketStatuses(t);
  const setStatus = useAction<unknown, { source: string; conn: string; id: string; to: string; name: string }>("tickets.setStatus", {
    invalidate: [["tickets", nav.projectId]],
    success: "Status changed",
  });
  const kind = /bug|fix/i.test(t.kind) ? "fix" : "feat";
  const rel = releases.find((r) => r.version === t.release);
  const done = t.criteria.filter((c) => c.done).length;
  return (
    <div className="detail-inner">
      <div className="col" style={{ gap: 8 }}>
        <div className="row wrap muted" style={{ fontSize: 12.5 }}>
          <span className="row" style={{ gap: 6, color: "var(--fg)" }} title="Assignee"><Avatar name={t.assignee} />{t.assignee}</span>
          <span className="faint">·</span>
          <span className="mono">{t.key}</span>
          <span className="faint">·</span>
          <span>{t.kind}</span>
          <span className="faint">·</span>
          <span>{t.whereLabel}</span>
          <span className="grow" />
          {t.url && (
            <button className="btn btn-sm" onClick={() => openExternal(t.url)}>
              <Icon name="external" size={11} />
              Open in {SRC[t.source]}
            </button>
          )}
        </div>
        <h1>{t.title}</h1>
      </div>
      <div className="kv tk-kv">
        {t.source === "jira" && (
          <>
            <div>
              <span>Parent</span>
              {t.parentKey ? (
                <a className="ellipsis" href={t.parentUrl} title={`Open ${t.parentKey} in Jira`} onClick={(e) => { e.preventDefault(); openExternal(t.parentUrl!); }}>
                  <span className="mono">{t.parentKey}</span> {t.parentTitle}
                </a>
              ) : (
                <span className="faint">None</span>
              )}
            </div>
            <div><span>Priority</span><span className={t.priority ? "" : "faint"}>{t.priority || "None"}</span></div>
            <div>
              <span>Time left</span>
              <span className={t.timeRemaining || t.timeEstimate ? "" : "faint"}>
                {t.timeRemaining && t.timeEstimate ? `${t.timeRemaining} of ${t.timeEstimate}` : t.timeRemaining || (t.timeEstimate ? `? of ${t.timeEstimate}` : "Not estimated")}
              </span>
            </div>
          </>
        )}
        {t.source === "jira" && (
          <div>
            <label htmlFor="tk-fix">Fix versions</label>
            <FixVersions t={t} />
          </div>
        )}
        <div>
          <label htmlFor="tk-rel">Release</label>
          <MenuChoice id="tk-rel" className="select menu-select" style={{ height: 30, width: "100%" }} label="Release" value={rel ? t.release : ""} options={[...releases.map((r) => ({ value: r.version, label: r.label })), { value: "", label: "Unplanned" }]} onChange={onRelease} />
        </div>
        <div>
          <label htmlFor="tk-status">Status</label>
          <MenuChoice
            id="tk-status"
            className="select menu-select"
            style={{ height: 30, width: "100%" }}
            label="Status"
            value=""
            options={[
              { value: "", label: setStatus.isPending ? `Moving to ${setStatus.variables?.name}…` : t.statusLabel || STATUS[t.status][0] },
              ...(statuses.data ?? []).filter((o) => o.name !== t.statusLabel).map((o) => ({ value: o.id, label: o.name })),
            ]}
            onChange={(to) => to && setStatus.mutate({ source: t.source, conn: t.conn, id: t.id, to, name: statuses.data?.find((o) => o.id === to)?.name ?? "" })}
          />
        </div>
      </div>
      {suggestion && (
        <div className="col note-box" style={{ gap: 8, borderColor: "var(--accent)" }}>
          <span className="row" style={{ gap: 6, fontWeight: 500 }}>
            <Icon name="sparkle" size={12} className="c-acc" />
            AI suggests: {suggestion.kind === "fix" ? "a fix" : "a feature"} in v{suggestion.release}
          </span>
          <span className="muted">{suggestion.reason}</span>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={onDismiss}>Dismiss</button>
            <button className="btn btn-sm btn-primary" onClick={() => onRelease(suggestion.release)}>Accept</button>
          </div>
        </div>
      )}
      <section className="section">
        <h2>Work</h2>
        {t.branch ? (
          <div className="row wrap card" style={{ padding: 14 }}>
            <Icon name="branch" />
            <span className="mono grow">{t.branch}{home && <span className="faint"> in {home}</span>}</span>
            <button
              className="btn btn-sm"
              onClick={() => {
                if (t.branchProject) nav.setProject(t.branchProject);
                nav.go({ name: "prs" });
              }}
            >
              Pull requests
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                if (t.branchProject) nav.setProject(t.branchProject);
                nav.selectBranch(t.branch!);
                nav.go({ name: "workspace" });
              }}
            >
              Go to branch
            </button>
          </div>
        ) : (
          <div className="row wrap card" style={{ padding: 14 }}>
            <span className="col grow" style={{ gap: 2 }}>
              <span>No branch yet</span>
              <span className="hint">{rel ? `Branches off ${rel.branch}. AI names the branch from this ticket.` : "Pick a release first, or choose one when you start."}</span>
            </span>
            <button className="btn btn-primary" onClick={() => nav.openNewItem({ release: rel?.version, ticket: t.key, description: t.title, kind })}>
              <Icon name="plus" size={12} />
              Start {kind === "fix" ? "fix" : "feature"}
            </button>
          </div>
        )}
      </section>
      <section className="section">
        <h2>Description</h2>
        {t.doc ? (
          <Adf doc={t.doc} />
        ) : t.description ? (
          <Markdown text={t.description} />
        ) : (
          <p style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }} className={t.description ? "" : "muted"}>{t.description || "No description."}</p>
        )}
      </section>
      {t.criteria.length > 0 && !t.doc && (
        <section className="section">
          <h2>Acceptance criteria <span className="faint" style={{ fontWeight: 400 }}>{done} of {t.criteria.length}</span></h2>
          <ul className="list">
            {t.criteria.map((c, i) => (
              <li key={i} className="list-row" style={{ minHeight: 40 }}>
                <span className={c.done ? "c-add" : "faint"} aria-hidden="true"><Icon name={c.done ? "check" : "stop"} size={12} /></span>
                <span className={c.done ? "muted" : ""}>{c.text}</span>
                <span className="sr-only">{c.done ? "(done)" : "(not done)"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="hint">{t.comments === 0 ? `No comments in ${SRC[t.source]}.` : `${plural(t.comments, "comment")} in ${SRC[t.source]}.`}</div>
    </div>
  );
}

/** Jira fix versions, toggled in a menu that stays open and saved when it closes. */
function FixVersions({ t }: { t: Ticket }) {
  const nav = useNav();
  const versions = useFixVersions(t);
  const save = useAction<unknown, { id: string; key: string; versions: string[] }>("jira.setFixVersions", {
    invalidate: [["tickets", nav.projectId], ["overview", nav.projectId]],
    success: "Fix versions changed",
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Names, as the ticket lists them.
  const [draft, setDraft] = useState<string[]>([]);
  const fix = t.fixVersions ?? [];
  const all = versions.data ?? [];
  // Archived versions only when the ticket still has them, as in Jira.
  const offered = all.filter((v) => !v.archived || fix.includes(v.name));

  const close = () => {
    setMenu(null);
    if (draft.length === fix.length && draft.every((n) => fix.includes(n))) return;
    const ids = draft.map((n) => all.find((v) => v.name === n)?.id);
    // A version missing from the list would be dropped from the ticket.
    if (ids.some((id) => !id)) return toast("Couldn't find every fix version in the project, nothing changed", "error");
    save.mutate({ id: t.conn, key: t.key, versions: ids as string[] });
  };

  return (
    <>
      <button
        id="tk-fix"
        className="select menu-select"
        style={{ height: 30, width: "100%" }}
        aria-haspopup="menu"
        aria-label="Fix versions"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setDraft(fix);
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <span className="ellipsis">{save.isPending ? "Saving…" : (menu ? draft : fix).join(", ") || "None"}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Fix versions"
          search={offered.length > SEARCH_ABOVE ? "Filter versions" : undefined}
          onClose={close}
          items={
            versions.isLoading
              ? [{ id: "loading", label: "Loading versions…", icon: null, disabled: true, run: () => {} }]
              : offered.length === 0
                ? [{ id: "none", label: "No versions in this project", icon: null, disabled: true, run: () => {} }]
                : offered.map((v) => ({
                    id: v.id,
                    label: v.released ? `${v.name} (released)` : v.name,
                    icon: null,
                    keep: true,
                    hint: draft.includes(v.name) && <Icon name="check" size={13} />,
                    run: () => setDraft((d) => (d.includes(v.name) ? d.filter((n) => n !== v.name) : [...d, v.name])),
                  }))
          }
        />
      )}
    </>
  );
}
