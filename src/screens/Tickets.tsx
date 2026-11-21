import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAction, useFixVersions, useOverview, useProjectPrefs, useProjects, useTagV, useTicketActivity, useTicketAssignees, useTicketComments, useTicketFields, useTicketStatuses, useTickets } from "../api/hooks";
import { openExternal, rpc } from "../api/transport";
import type { BranchView, FieldOption, PrSummary, Suggestion, Ticket, TicketComment } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Adf, type AdfNode } from "../components/Adf";
import { Avatar } from "../components/Avatar";
import { ContextMenu, SEARCH_ABOVE } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { PictureSource } from "../components/Picture";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { TicketFiles } from "../components/TicketFiles";
import { ago, Busy, EmptyState, ErrorBox, Header, Markdown, MEDIA, MediaAsk, PICTURES, releaseTagLabel, Seg, swipeProps } from "../components/ui";
import { lasted, plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { toast } from "../lib/toast";

/** Each status's name, in the list's order: the work under way first, then what waits, then what's done. */
const STATUS: Record<Ticket["status"], string> = {
  progress: "In progress",
  review: "In review",
  ready: "Ready to merge",
  todo: "To do",
  done: "Done",
};
const SRC = { jira: "Jira", trello: "Trello", asana: "Asana", linear: "Linear", github: "GitHub" };
const PR_STATE = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const ADD = "\0add";
const NOBODY = "Unassigned";
/** A status as a station ring: empty to do, filling up through review, green once ready or done. `tip`: its name on hover. */
const Ring = ({ status, tip }: { status?: Ticket["status"]; tip?: string }) => <span className="tk-ring" data-status={status ?? "todo"} data-tip={tip} aria-hidden="true" />;
const TicketRing = ({ t }: { t: Ticket }) => <Ring status={t.status} tip={t.statusLabel || STATUS[t.status]} />;
/** How urgent a priority name is, as the engine ranks it (priority_rank in tickets/mod.rs): 0 the most, 4 the least, 5 none. */
function rankOf(name: string) {
  const n = name.trim().toLowerCase();
  if (!n || n === "none" || n === "no priority") return 5;
  const p = /(?:^|[^\p{L}\p{N}])p(\d+)(?=$|[^\p{L}\p{N}])/u.exec(n);
  if (p) return Math.min(4, Number(p[1]));
  const has = (words: string[]) => words.some((w) => n.includes(w));
  if (has(["urgent", "blocker", "critical", "highest", "critique", "bloquant", "très haute", "très élevée"])) return 0;
  if (has(["lowest", "trivial", "très basse", "très faible"])) return 4;
  if (has(["high", "major", "haute", "élevée"])) return 1;
  return has(["low", "minor", "basse", "faible", "mineur"]) ? 3 : 2;
}
/** A priority's mark: the alert icon when urgent, else bars filled by how urgent it is (none lit without one). */
const PrioMark = ({ rank }: { rank: number }) =>
  rank === 0 ? <Icon name="alert" size={11} /> : <span className="tk-bars" aria-hidden="true">{[1, 2, 3].map((b) => <i key={b} data-on={b <= 4 - rank || undefined} />)}</span>;
// Urgent red, high orange, medium a faint touch of yellow, the rest faint.
const prioClass = (rank: number) => `tk-prio ${["c-del", "tk-prio-high", "tk-prio-medium"][rank] ?? "faint"}`;
/** A ticket's priority: its mark and name; `bare` leaves the name to the tooltip. */
const Prio = ({ t, bare }: { t: Ticket; bare?: boolean }) =>
  t.priority ? (
    <span className={prioClass(t.priorityRank)} data-tip={`Priority · ${t.priority}`}>
      <PrioMark rank={t.priorityRank} />
      {bare ? <span className="sr-only">{t.priority}</span> : t.priority}
    </span>
  ) : null;
/** A priority option's mark in its menu, coloured as in the list. */
const PrioOption = ({ name }: { name: string }) => (
  <span className={prioClass(rankOf(name))} aria-hidden="true">
    <PrioMark rank={rankOf(name)} />
  </span>
);
/** Who has the ticket: their avatar, the full name in its tooltip; a dashed empty ring for nobody. `decorative`: the name
 * shows beside it, so no tooltip. */
const Assignee = ({ name, decorative }: { name: string; decorative?: boolean }) =>
  name && name !== NOBODY ? (
    <Avatar name={name} size={18} decorative={decorative} />
  ) : (
    <span className="tk-nobody" {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": NOBODY, "data-tip": NOBODY })} />
  );
/** The assignee menu's option that leaves the ticket with nobody. */
const UNASSIGN = "\0nobody";
/** An agent on the ticket's branch: the working rainbow, or the warning dot while it waits. */
const AgentDot = ({ b }: { b?: BranchView }) =>
  b?.running ? <span className="pulse glow-dot" data-tip="An agent is working on its branch" /> : b?.waiting ? <span className="pulse map-wait" data-tip="An agent waits for you on its branch" /> : null;

export function Tickets({ initial }: { initial?: string }) {
  const nav = useNav();
  const qc = useQueryClient();
  const pid = nav.projectId!;
  const [mine, setMine] = useStored("gnx.tickets.mine", true);
  const [sprint, setSprint] = useStored("gnx.tickets.sprint", true);
  const q = useTickets(pid, mine, sprint);
  const ov = useOverview(pid).data;
  const { label } = useTagV(pid);
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
  // The trackers menu counts before the search, so a search finding nothing doesn't read as empty trackers.
  const counted = all.filter((t) => !mine || t.mine);
  const shown = places.includes(place) ? place : "all";
  const visible = base.filter((t) => shown === "all" || t.place === shown);
  const groups =
    group === "release"
      ? [...open.map((r) => ({ id: r.version, label: `${releaseTagLabel(r.tag)} · ${label(r.version)}` })), { id: "", label: "Unplanned" }]
      : (Object.keys(STATUS) as Ticket["status"][]).map((s) => ({ id: s, label: STATUS[s] }));
  const grouped = groups
    .map((g) => ({ ...g, items: visible.filter((t) => (group === "release" ? (open.some((r) => r.version === t.release) ? t.release : "") === g.id : t.status === g.id)) }))
    .filter((g) => g.items.length);
  const t = all.find((x) => x.key === sel) ?? visible[0];
  const unplanned = visible.filter((x) => !x.release && x.status !== "done").length;
  // Linear calls its sprints cycles; a Linear team with cycles off has none, so no toggle for it.
  const jira = q.data?.sources.includes("jira");
  const cycles = q.data?.cycles;
  // Titles start at the same place on every row: the longest key sets the column, and a long Asana gid gives up its end.
  // One character over, as WebKitGTK sets a key a hair wider than its count of `ch`.
  const keyW = Math.min(14, Math.max(4, ...visible.map((x) => x.key.length))) + 1;
  // A ticket's branch in this project, for its agent, commits and changes.
  const here = (x: Ticket) => !!x.branch && (!x.branchProject || x.branchProject === pid);
  const branchOf = (x: Ticket) => (here(x) ? ov?.branches.find((b) => b.name === x.branch) : undefined);
  // Its pull request, from the list the Pull requests screen has loaded: asking the host from here could ask to sign in to it.
  const prs = qc.getQueryData<{ items: PrSummary[] }>(["prs", pid])?.items ?? [];
  const prOf = (x: Ticket) => {
    const found = here(x) ? prs.filter((p) => p.head === x.branch && !p.fork) : [];
    return found.find((p) => p.state === "open" || p.state === "draft") ?? found[0];
  };
  const settings = () => nav.go({ name: "menu", section: "tools" });

  if (q.isLoading)
    return (
      <>
        <Header title="Tickets" hideWide />
        <div className="map-bar tk-bar">
          <h2 className="map-title hide-narrow">Tickets</h2>
        </div>
        <div className="body split">
          <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active aria-label="Ticket list" aria-busy="true">
            <p className="tk-sync"><span className="spinner" />Syncing tickets…</p>
            {[78, 64, 70, 82, 58, 74, 66].map((w, i) => (
              <span key={i} className="tk-skel" aria-hidden="true"><i /><i /><i style={{ width: `${w}%` }} /></span>
            ))}
          </section>
          <main className="detail" data-pane />
        </div>
      </>
    );
  if (q.data && q.data.sources.length === 0)
    return (
      <>
        <Header title="Tickets" sub={ov?.project.name} hideWide />
        <div className="map-bar tk-bar">
          <h2 className="map-title hide-narrow">Tickets</h2>
          {ov && <span className="pr-where mono ellipsis hide-narrow">{ov.project.name}</span>}
        </div>
        <div className="empty-state">
          <span className="tk-mini" aria-hidden="true">
            {["Ticket", "Branch", "Pull request", "Release"].map((s) => (
              <span key={s}><span className="tk-stop" data-big={s === "Release" || undefined} />{s}</span>
            ))}
          </span>
          <h2>No ticket tracker connected</h2>
          <p>Connect Jira, Trello, Asana or Linear, or sign in to GitHub under Git providers for the issues of a GitHub repository, to see tickets here, plan them into releases and start a branch from one.</p>
          <button className="btn btn-primary btn-md" onClick={settings}>Connect a tracker</button>
        </div>
      </>
    );

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
              <button className="btn btn-primary" onClick={settings}>Open settings</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* The branch map's toolbar: the title, the filters, then search, sync and triage. The narrow detail pane goes without it. */}
          <div className="map-bar tk-bar" data-detail={pane === "detail" || undefined}>
            <h2 className="map-title hide-narrow">Tickets</h2>
            <MenuChoice
              className="select menu-select tk-trackers"
              label="Tracker"
              value={shown}
              options={[
                { value: "all", label: `All trackers · ${counted.length}` },
                ...places.map((p) => ({ value: p, label: `${p} · ${counted.filter((x) => x.place === p).length}` })),
                { value: ADD, label: "Connect another tracker…" },
              ]}
              onChange={(v) => (v === ADD ? settings() : setPlace(v))}
            />
            <Seg<"mine" | "all">
              label="Whose tickets"
              value={mine ? "mine" : "all"}
              onChange={(v) => setMine(v === "mine")}
              options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]}
            />
            {(jira || cycles) && (
              <button
                className="map-toggle"
                aria-pressed={sprint}
                data-tip={`${jira && cycles ? "Jira tickets in an open sprint and Linear issues in the active cycle" : jira ? "Jira tickets in an open sprint" : "Linear issues in the active cycle"}; hides the other trackers`}
                onClick={() => setSprint(!sprint)}
              >
                <span className="map-box" aria-hidden><Icon name="check" size={10} stroke={2.4} /></span>
                <span>{jira && cycles ? "Active sprint or cycle" : jira ? "Active sprint" : "Active cycle"}</span>
              </button>
            )}
            <Seg label="Group by" value={group} onChange={setGroup} options={[{ value: "status", label: "By status" }, { value: "release", label: "By release" }]} />
            <span className="grow" />
            <div className="pr-search">
              <Icon name="search" size={13} className="faint" />
              <label htmlFor="tk-q" className="sr-only">Search tickets</label>
              <input id="tk-q" className="input" placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value, false)} onBlur={() => setSearch(search)} />
            </div>
            <button className="btn btn-sm btn-icon" aria-label="Sync now" data-tip={q.data?.syncedAt ? `Sync now · synced ${ago(q.data.syncedAt)}` : "Sync now"} onClick={() => q.refetch()}>
              <Busy on={q.isFetching}><Icon name="refresh" size={14} /></Busy>
            </button>
            {unplanned > 0 && open.length > 0 && (
              <button
                className="btn btn-sm tk-triage"
                aria-label={`Triage ${unplanned} unplanned with AI`}
                data-tip={`Ask AI which release each of the ${plural(unplanned, "unplanned ticket")} belongs in`}
                disabled={triage.isPending}
                onClick={() => triage.mutate({ projectId: pid }, { onSuccess: (r) => setSuggestions(Object.fromEntries(r.map((s) => [s.key, s]))) })}
              >
                <Busy on={triage.isPending}><Icon name="sparkle" size={12} /></Busy>
                <span>
                  Triage {unplanned}
                  <span className="hide-narrow"> unplanned</span>
                </span>
              </button>
            )}
          </div>
          <div className="body split">
            <section className="master" style={{ "--master-w": `${listW.width}px`, "--key-w": `${keyW}ch` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Ticket list">
              <div className="scroll tk-list">
                {grouped.map((g) => (
                  <div key={g.id || "none"}>
                    <div className="group-head">
                      <span>{g.label}</span>
                      <span className="mono">{g.items.length}</span>
                    </div>
                    <div className="col" style={{ gap: 1 }}>
                      {g.items.map((x) => (
                        <TicketRow
                          key={x.key}
                          x={x}
                          active={x.key === t?.key}
                          everyone={!mine}
                          branch={branchOf(x)}
                          suggested={!!suggestions[x.key] && !x.release}
                          onPick={() => {
                            setSel(x.key);
                            setPane("detail");
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {grouped.length === 0 &&
                  (all.length ? (
                    <div className="tk-none">
                      <strong>{term ? `No tickets match “${search.trim()}”.` : "No tickets match these filters."}</strong>
                      <p className="hint">
                        {term ? "Search reads keys and titles" : "Nothing left"}
                        {mine ? " of your tickets" : ""}
                        {sprint && (jira || cycles) ? " in the active sprint or cycle" : ""}
                        {shown !== "all" ? ` in ${shown}` : ""}.
                      </p>
                      <div className="row wrap">
                        {term && <button className="btn btn-sm" onClick={() => setSearch("")}>Clear search</button>}
                        {mine && <button className="btn btn-sm" onClick={() => setMine(false)}>{term ? "Search everyone's tickets" : "Show everyone's tickets"}</button>}
                        {shown !== "all" && <button className="btn btn-sm" onClick={() => setPlace("all")}>Show all trackers</button>}
                      </div>
                    </div>
                  ) : (
                    <div className="tk-none">
                      <p>No open tickets from {(q.data?.sources ?? []).map((s) => SRC[s as keyof typeof SRC]).join(", ")}. Check the query in its settings.</p>
                      <div className="row">
                        <button className="btn btn-sm" onClick={settings}>Open settings</button>
                      </div>
                    </div>
                  ))}
              </div>
            </section>
            <Resizer pane={listW} label="Resize ticket list" />
            <main className="detail tk-detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
              {t ? (
                <TicketDetail
                  t={t}
                  home={home(t)}
                  branch={branchOf(t)}
                  pr={prOf(t)}
                  releases={open.map((r) => ({ version: r.version, label: `${label(r.version)} · ${releaseTagLabel(r.tag)}`, branch: r.branch, tag: r.tag }))}
                  shipped={ov?.releases.find((r) => r.version === t.release && !r.open)?.version}
                  suggestion={!t.release ? suggestions[t.key] : undefined}
                  onRelease={(v) => setRel.mutate({ projectId: pid, key: t.key, release: v })}
                  onDismiss={() => {
                    const n = { ...suggestions };
                    delete n[t.key];
                    setSuggestions(n);
                  }}
                />
              ) : visible.length ? (
                <EmptyState icon="ticket" title="No ticket selected">Pick one from the list to see its details and start a branch from it.</EmptyState>
              ) : null}
            </main>
          </div>
        </>
      )}
    </>
  );
}

/** A row of the list: status ring, key, title, then priority and, with Everyone, who has it: their avatar, and on a phone,
 * which has no hover for the avatar's tooltip, their first name beside it. */
function TicketRow({ x, active, everyone, branch, suggested, onPick }: { x: Ticket; active: boolean; everyone: boolean; branch?: BranchView; suggested: boolean; onPick: () => void }) {
  return (
    <button className="item-btn tk-row" aria-pressed={active} onClick={onPick}>
      <TicketRing t={x} />
      <span className="mono tk-row-key">{x.key}</span>
      <span className="tk-row-title">
        <AgentDot b={branch} />
        {x.title}
      </span>
      <span className="sr-only">{x.statusLabel || STATUS[x.status]}</span>
      {suggested && <Icon name="sparkle" size={11} className="c-acc" />}
      <Prio t={x} bare />
      {everyone && (
        <span className="tk-row-who">
          <Assignee name={x.assignee} />
          <span className="tk-row-name" aria-hidden="true">{x.assignee.split(/\s+/)[0]}</span>
        </span>
      )}
    </button>
  );
}

type Rel = { version: string; label: string; branch: string; tag: string };

/** The ticket as a page: its title and fields, then what it says, its files and comments; beside it, its way to a release. */
function TicketDetail({
  t,
  home,
  branch,
  pr,
  releases,
  shipped,
  suggestion,
  onRelease,
  onDismiss,
}: {
  t: Ticket;
  home?: string;
  branch?: BranchView;
  pr?: PrSummary;
  releases: Rel[];
  shipped?: string;
  suggestion?: Suggestion;
  onRelease: (v: string) => void;
  onDismiss: () => void;
}) {
  const nav = useNav();
  const prefs = useProjectPrefs(nav.projectId);
  // Only GitHub's Markdown holds HTML; the other trackers' show their pictures, and any tag stays text.
  const github = t.source === "github";
  const media = prefs.dialogs.prMedia;
  const comments = useTicketComments(t);
  // Pictures behind the tracker's sign-in load through the app, once the project allows pictures.
  const pictures = useMemo(
    () => ({ key: `${t.source}:${t.conn}:${t.id}`, load: (url: string) => rpc<string>("tickets.picture", { source: t.source, conn: t.conn, id: t.id, url }) }),
    [t.source, t.conn, t.id],
  );
  const hasPictures = (text: string, doc?: AdfNode) => (doc ? JSON.stringify(doc).includes('"type":"media') : (github ? MEDIA : PICTURES).test(text));
  const ask = <MediaAsk html={github} onShow={() => prefs.setDialogs({ prMedia: true })} />;
  const descHidden = !media && hasPictures(t.description, t.doc);
  const commentsHidden = !media && !descHidden && (comments.data ?? []).some((c) => [c, ...c.replies].some((r) => hasPictures(r.body, r.doc)));
  const statuses = useTicketStatuses(t);
  const setStatus = useAction<unknown, { source: string; conn: string; id: string; to: string; name: string }>("tickets.setStatus", {
    invalidate: [["tickets", nav.projectId]],
    success: "Status changed",
  });
  const fields = useTicketFields(t);
  const f = fields.data;
  const nameOf = (list: FieldOption[] = [], id?: string) => list.find((o) => o.id === id)?.name;
  const setFields = useAction<unknown, Edit & { source: string; conn: string; id: string }>("tickets.setFields", {
    invalidate: [["tickets", nav.projectId]],
    success: `Saved in ${SRC[t.source]}`,
    // The new values show until the list comes back from the tracker.
    patch: (qc, v) =>
      qc.setQueriesData<{ tickets: Ticket[] }>({ queryKey: ["tickets", nav.projectId] }, (d) =>
        d && {
          ...d,
          tickets: d.tickets.map((x) =>
            x.source === v.source && x.id === v.id
              ? {
                  ...x,
                  priority: v.priority ? nameOf(f?.priorities, v.priority) ?? x.priority : x.priority,
                  kind: v.kind ? nameOf(f?.types, v.kind) ?? x.kind : x.kind,
                  labels: v.labels ? v.labels.map((id) => nameOf(f?.labels, id) ?? id) : x.labels,
                }
              : x,
          ),
        },
      ),
  });
  const assignees = useTicketAssignees(t);
  const setAssignee = useAction<unknown, { source: string; conn: string; id: string; to: string; name: string }>("tickets.setAssignee", {
    invalidate: [["tickets", nav.projectId]],
    success: "Assignee changed",
    patch: (qc, v) =>
      qc.setQueriesData<{ tickets: Ticket[] }>({ queryKey: ["tickets", nav.projectId] }, (d) =>
        d && { ...d, tickets: d.tickets.map((x) => (x.source === v.source && x.id === v.id ? { ...x, assignee: v.name } : x)) },
      ),
  });
  const edit = (e: Edit) => setFields.mutate({ source: t.source, conn: t.conn, id: t.id, ...e });
  const busy = (k: keyof Edit) => (setFields.isPending && setFields.variables?.[k] !== undefined ? "Saving…" : undefined);
  const rel = releases.find((r) => r.version === t.release);
  const done = t.criteria.filter((c) => c.done).length;
  const source = media ? pictures : null;
  const tracked = t.source === "jira" || t.source === "linear";
  const link = (href: string | undefined, title: string, text: ReactNode) =>
    href ? (
      <a className="ellipsis" href={href} title={title} onClick={(e) => { e.preventDefault(); openExternal(href); }}>{text}</a>
    ) : (
      <span className="faint">None</span>
    );
  return (
    <div className="tk-page">
      <div className="tk-read">
        <div className="tk-col">
          <header className="tk-head">
            <h1>{t.title}</h1>
            {t.url && (
              <button className="btn btn-sm tk-open" onClick={() => openExternal(t.url)}>
                <Icon name="external" size={11} />
                Open in {SRC[t.source]}
              </button>
            )}
            <div className="tk-props">
              <span className="mono faint tk-key">{t.key}</span>
              <FieldMenu
                id="tk-status"
                label="Status"
                lead={<TicketRing t={t} />}
                mark={(o) => <Ring status={o.status} />}
                current={t.statusLabel || STATUS[t.status]}
                options={statuses.data ?? []}
                busy={setStatus.isPending ? `Moving to ${setStatus.variables?.name}…` : undefined}
                onPick={(to) => setStatus.mutate({ source: t.source, conn: t.conn, id: t.id, to, name: statuses.data?.find((o) => o.id === to)?.name ?? "" })}
              />
              {tracked && f?.priorities.length ? (
                <FieldMenu id="tk-priority" label="Priority" lead={<Prio t={t} bare />} mark={(o) => <PrioOption name={o.name} />} current={t.priority || "No priority"} options={f.priorities} busy={busy("priority")} onPick={(priority) => edit({ priority })} />
              ) : (
                <Prio t={t} />
              )}
              {t.source === "jira" && f?.types.length ? (
                <FieldMenu id="tk-type" label="Type" current={t.kind} options={f.types} busy={busy("kind")} onPick={(kind) => edit({ kind })} />
              ) : (
                <span className="tk-kind">{t.kind}</span>
              )}
              {t.source === "linear" && (
                <PickMany
                  id="tk-labels"
                  label="Labels"
                  value={t.labels ?? []}
                  options={f?.labels ?? []}
                  loading={fields.isLoading}
                  saving={!!busy("labels")}
                  empty="No labels in this team"
                  search="Filter labels"
                  missing="Couldn't find every label in Linear, nothing changed"
                  onSave={(labels) => edit({ labels })}
                />
              )}
              <FieldMenu
                id="tk-assignee"
                label="Assignee"
                lead={<Assignee name={t.assignee} decorative />}
                mark={(o) => <Assignee name={o.name} decorative />}
                current={t.assignee || NOBODY}
                options={[...(assignees.data ?? []), { id: UNASSIGN, name: NOBODY }]}
                busy={setAssignee.isPending ? `Assigning to ${setAssignee.variables?.name}…` : undefined}
                onPick={(id) => setAssignee.mutate({ source: t.source, conn: t.conn, id: t.id, to: id === UNASSIGN ? "" : id, name: assignees.data?.find((o) => o.id === id)?.name ?? NOBODY })}
              />
            </div>
          </header>
          <div className="tk-body">
            <section className="section tk-desc">
              <h2 className="sr-only">Description</h2>
              {descHidden && ask}
              <PictureSource.Provider value={source}>
                {t.doc ? (
                  <Adf doc={t.doc} />
                ) : t.description ? (
                  <Markdown text={t.description} html={media && (github || "pictures")} breaks={github} />
                ) : (
                  <p className="muted" style={{ margin: 0 }}>No description.</p>
                )}
              </PictureSource.Provider>
            </section>
            {t.criteria.length > 0 && !t.doc && (
              <section className="section">
                <h2>Acceptance criteria <span className="mono">{done} of {t.criteria.length}</span></h2>
                <ul className="tk-criteria">
                  {t.criteria.map((c, i) => (
                    <li key={i}>
                      <span className="tk-ring" data-status={c.done ? "done" : "todo"} aria-hidden="true" />
                      <span className={c.done ? "muted" : ""}>{c.text}</span>
                      <span className="sr-only">{c.done ? "(done)" : "(not done)"}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <TicketFiles key={`${t.source}:${t.id}`} t={t} pictures={media} />
            <PictureSource.Provider value={source}>
              <Comments t={t} html={media && (github || "pictures")} ask={commentsHidden && ask} />
            </PictureSource.Provider>
          </div>
        </div>
      </div>
      <aside className="tk-side" aria-label="Work">
        <h2 className="label">Work</h2>
        <WorkLine t={t} home={home} branch={branch} pr={pr} rel={rel} shipped={shipped} suggestion={suggestion} onRelease={onRelease} onDismiss={onDismiss} />
        <dl className="tk-kvs">
          <div>
            <dt><label htmlFor="tk-rel">Release</label></dt>
            <dd>
              <MenuChoice id="tk-rel" className="select menu-select" label="Release" value={rel ? t.release : ""} options={[...releases.map((r) => ({ value: r.version, label: r.label })), { value: "", label: "Unplanned" }]} onChange={onRelease} />
            </dd>
          </div>
          {t.source === "jira" && (
            <div>
              <dt><label htmlFor="tk-fix">Fix versions</label></dt>
              <dd><FixVersions t={t} /></dd>
            </div>
          )}
          {tracked && (
            <div>
              <dt>Parent</dt>
              <dd>{link(t.parentKey && t.parentUrl, `Open ${t.parentKey} in ${SRC[t.source]}`, <><span className="mono faint">{t.parentKey}</span> {t.parentTitle}</>)}</dd>
            </div>
          )}
          {t.source === "linear" && (
            <div>
              <dt>Project</dt>
              <dd>{link(t.projectName && t.projectUrl, `Open ${t.projectName} in Linear`, t.projectName)}</dd>
            </div>
          )}
          {t.source === "jira" && (
            <div>
              <dt>Time left</dt>
              <dd className={t.timeRemaining || t.timeEstimate ? "" : "faint"}>
                {t.timeRemaining && t.timeEstimate ? `${t.timeRemaining} of ${t.timeEstimate}` : t.timeRemaining || (t.timeEstimate ? `? of ${t.timeEstimate}` : "Not estimated")}
              </dd>
            </div>
          )}
          <div>
            <dt>Tracker</dt>
            <dd className="muted">{t.whereLabel}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

/**
 * The ticket's way to a release, as stations down a line: the ticket, its branch, pull request, release and shipping.
 * White up to where it stands, the next station outlined, the ones after dashed; each holds what can be done there.
 */
function WorkLine({
  t,
  home,
  branch,
  pr,
  rel,
  shipped,
  suggestion,
  onRelease,
  onDismiss,
}: {
  t: Ticket;
  home?: string;
  branch?: BranchView;
  pr?: PrSummary;
  rel?: Rel;
  shipped?: string;
  suggestion?: Suggestion;
  onRelease: (v: string) => void;
  onDismiss: () => void;
}) {
  const nav = useNav();
  const { label } = useTagV(nav.projectId);
  const activity = useTicketActivity(t).data;
  const go = (then: () => void) => () => {
    if (t.branchProject) nav.setProject(t.branchProject);
    then();
  };
  const reached = [true, !!t.branch, !!pr && pr.state !== "closed", !!shipped, !!shipped];
  const next = reached.indexOf(false);
  const stop = (i: number) => (next === -1 || i < next ? { "data-on": true } : i === next ? { "data-next": true } : { "data-later": true });
  const line = (i: number) => (next === -1 || i + 1 < next ? "on" : i + 1 > next ? "later" : undefined);
  const station = (i: number, name: string, body: ReactNode, big?: boolean) => (
    <li className="tk-stn" data-link={i < 4 ? line(i) : undefined}>
      <span className="tk-stop" {...stop(i)} data-big={big || undefined} />
      <div className="tk-stn-body">
        <span className="label" data-on={reached[i] || undefined}>{name}</span>
        {body}
      </div>
    </li>
  );
  const kind = /bug|fix/i.test(t.kind) ? "fix" : "feat";
  return (
    <ol className="tk-work">
      {station(
        0,
        "Ticket",
        <>
          <span className="tk-stn-text">
            {t.statusLabel || STATUS[t.status]}
            {activity?.statusAt && ` ${lasted(activity.statusAt)}`}
          </span>
          {activity?.createdAt && (
            <span className="tk-stn-meta">
              Opened {ago(activity.createdAt)}
              {activity.createdBy && ` by ${activity.createdBy}`}
            </span>
          )}
        </>,
      )}
      {station(
        1,
        "Branch",
        t.branch ? (
          <>
            <span className="mono tk-stn-name">
              {t.branch}
              {home && <span className="faint"> in {home}</span>}
            </span>
            {branch && (
              <span className="tk-stn-meta">
                {[plural(branch.ahead, "commit"), branch.wip > 0 && `WIP ${plural(branch.wip, "file")}`, branch.parent && `off ${branch.parent}`].filter(Boolean).join(" · ")}
              </span>
            )}
            {branch?.running ? (
              <span className="tk-stn-meta">
                <span className="pulse glow-dot" />
                <span className="glow-working"><span>An agent is working on it</span></span>
              </span>
            ) : branch?.waiting ? (
              <span className="tk-stn-meta c-warn"><span className="pulse map-wait" />An agent waits for you</span>
            ) : null}
            <span className="tk-stn-acts">
              <button className="btn btn-sm btn-primary" onClick={go(() => { nav.selectBranch(t.branch!); nav.go({ name: "workspace" }); })}>Go to branch</button>
            </span>
          </>
        ) : (
          <>
            <span className="tk-stn-text">No branch yet</span>
            <span className="tk-stn-meta">{rel ? `Branches off ${rel.branch}. AI names the branch from this ticket.` : "Pick a release first, or choose one when you start. AI names the branch from this ticket."}</span>
            <span className="tk-stn-acts">
              <button className="btn btn-sm btn-primary" onClick={() => nav.openNewItem({ release: rel?.version, ticket: t.key, description: t.title, kind })}>
                <Icon name="plus" size={11} />
                Start a branch
              </button>
            </span>
          </>
        ),
      )}
      {station(
        2,
        "Pull request",
        !t.branch ? (
          <span className="tk-stn-meta faint">Opens from the branch</span>
        ) : pr ? (
          <>
            <span className="tk-stn-text"><span className="mono">#{pr.number}</span> · {PR_STATE[pr.state]}</span>
            <span className="tk-stn-acts">
              <button className="btn btn-sm" onClick={go(() => nav.go({ name: "prs", number: pr.number }))}>Open pull request</button>
            </span>
          </>
        ) : (
          <span className="tk-stn-acts">
            <button className="btn btn-sm" onClick={go(() => nav.go({ name: "prs" }))}>Pull requests</button>
          </span>
        ),
      )}
      {station(
        3,
        "Release",
        shipped ? (
          <span className="tk-stn-text">{label(shipped)}</span>
        ) : rel ? (
          <>
            <span className="tk-stn-num">
              {rel.version}
              <span className="tag">{releaseTagLabel(rel.tag)}</span>
            </span>
            <span className="tk-stn-meta mono">{rel.branch}</span>
          </>
        ) : suggestion ? (
          <div className="col note-box tk-suggest">
            <span className="row" style={{ gap: 6, fontWeight: 500 }}>
              <Icon name="sparkle" size={12} className="c-acc" />
              Suggested: {suggestion.kind === "fix" ? "a fix" : "a feature"} in {label(suggestion.release)}
            </span>
            <span className="muted">{suggestion.reason}</span>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-sm" onClick={onDismiss}>Dismiss</button>
              <button className="btn btn-sm btn-primary" onClick={() => onRelease(suggestion.release)}>Accept</button>
            </div>
          </div>
        ) : (
          <span className="tk-stn-meta">Unplanned · pick one below</span>
        ),
        true,
      )}
      {station(4, "Shipped", <span className={shipped ? "tk-stn-meta" : "tk-stn-meta faint"}>{shipped ? `In ${label(shipped)}` : "Not yet"}</span>)}
    </ol>
  );
}

/**
 * The ticket's comment threads, each first comment with its replies under it.
 * Linear's also get a box to reply in each thread, then a box for a new comment.
 */
function Comments({ t, html, ask }: { t: Ticket; html: boolean | "pictures"; ask?: ReactNode }) {
  const q = useTicketComments(t);
  const threads = q.data ?? [];
  const count = threads.reduce((n, c) => n + 1 + c.replies.length, 0);
  const linear = t.source === "linear";
  return (
    <section className="section">
      <h2>Comments {count > 0 && <span className="mono">{count}</span>}</h2>
      {ask}
      {q.isLoading ? (
        <span className="muted">Loading comments…</span>
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : threads.length === 0 ? (
        <span className="muted">No comments in {SRC[t.source]}.</span>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {threads.map((c) => (
            <article key={c.id} className="thread">
              {[c, ...c.replies].map((r, i) => (
                // Replies line up under the first comment's text, as in Linear.
                <Comment key={r.id} c={r} html={html} style={i ? { paddingLeft: 54 } : undefined} />
              ))}
              {linear && <CommentBox t={t} parent={c.id} />}
            </article>
          ))}
        </div>
      )}
      {linear && !q.isLoading && <CommentBox key={t.id} t={t} />}
    </section>
  );
}

/** Posts to the ticket in Linear: a reply in the thread that starts with `parent`, else a new comment. */
function CommentBox({ t, parent }: { t: Ticket; parent?: string }) {
  const [text, setText] = useState("");
  const post = useAction<unknown, { source: string; conn: string; id: string; body: string; parentId?: string }>("tickets.comment", {
    invalidate: [["ticketComments", t.source, t.conn, t.id]],
  });
  const id = parent ? `tk-reply-${parent}` : "tk-new-comment";
  const send = () => post.mutate({ source: t.source, conn: t.conn, id: t.id, body: text, parentId: parent }, { onSuccess: () => setText("") });
  return (
    <div className="col" style={parent ? { padding: "10px 14px 14px", borderTop: "1px solid var(--line)" } : { marginTop: 10 }}>
      <label htmlFor={id} className="sr-only">{parent ? "Reply" : "New comment"}</label>
      <textarea id={id} className="textarea" rows={parent ? 2 : 3} placeholder={parent ? "Reply…" : "Leave a comment in Linear…"} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className={parent ? "btn btn-sm btn-primary" : "btn btn-primary"} disabled={!text.trim() || post.isPending} onClick={send}>
          <Busy on={post.isPending}>{null}</Busy>
          {parent ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}

/** One comment: Jira's in its own format, the others' as Markdown (HTML only from GitHub). */
function Comment({ c, html, style }: { c: TicketComment; html: boolean | "pictures"; style?: CSSProperties }) {
  return (
    <div className="comment" style={style}>
      <Avatar name={c.author} size={28} decorative />
      <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{c.author}</span>
          <span className="faint" style={{ fontSize: 12 }}>{ago(c.createdAt)}</span>
        </div>
        <div className="comment-body">{c.doc ? <Adf doc={c.doc} /> : <Markdown text={c.body} html={html} breaks />}</div>
      </div>
    </div>
  );
}

type Edit = { priority?: string; kind?: string; labels?: string[] };

/** A field's menu: its current value, then the others to switch to; `busy` stands in for the value while it saves. `lead`: its
 * mark (status ring, priority bars) inside the menu, before the value. */
type FieldOpt = { id: string; name: string; status?: Ticket["status"] };
/** `mark`: each other option's mark in the menu, as `lead` is the current value's. */
function FieldMenu({ id, label, lead, mark, current, options, busy, onPick }: { id: string; label: string; lead?: ReactNode; mark?: (o: FieldOpt) => ReactNode; current: string; options: FieldOpt[]; busy?: string; onPick: (id: string) => void }) {
  return (
    <MenuChoice
      id={id}
      lead={lead}
      className="select menu-select"
      label={label}
      value=""
      options={[{ value: "", label: busy ?? current, lead }, ...options.filter((o) => o.name !== current).map((o) => ({ value: o.id, label: o.name, lead: mark?.(o) }))]}
      onChange={(v) => v && onPick(v)}
    />
  );
}

type Pick = { id: string; name: string; label?: ReactNode; group?: string };

/**
 * Several of `options` toggled in a menu that stays open, saved when it closes; one per `group`, as Linear label groups allow.
 * `value`: the names the ticket lists.
 */
function PickMany(p: { id: string; label: string; value: string[]; options: Pick[]; loading: boolean; saving: boolean; empty: string; search: string; missing: string; onSave: (ids: string[]) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const groupOf = (n: string) => p.options.find((o) => o.name === n)?.group;

  const close = () => {
    setMenu(null);
    if (draft.length === p.value.length && draft.every((n) => p.value.includes(n))) return;
    const ids = draft.map((n) => p.options.find((o) => o.name === n)?.id);
    // One missing from the list would be dropped from the ticket.
    if (ids.some((id) => !id)) return toast(p.missing, "error");
    p.onSave(ids as string[]);
  };
  const toggle = (o: Pick) => setDraft((d) => (d.includes(o.name) ? d.filter((n) => n !== o.name) : [...d.filter((n) => !o.group || groupOf(n) !== o.group), o.name]));

  return (
    <>
      <button
        id={p.id}
        className="select menu-select"
        aria-haspopup="menu"
        aria-label={p.label}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setDraft(p.value);
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <span className="ellipsis">{p.saving ? "Saving…" : (menu ? draft : p.value).join(", ") || `No ${p.label.toLowerCase()}`}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={p.label}
          search={p.options.length > SEARCH_ABOVE ? p.search : undefined}
          onClose={close}
          items={
            p.loading
              ? [{ id: "loading", label: "Loading…", icon: null, disabled: true, run: () => {} }]
              : p.options.length === 0
                ? [{ id: "none", label: p.empty, icon: null, disabled: true, run: () => {} }]
                : p.options.flatMap((o, i) => [
                    ...(o.group && o.group !== p.options[i - 1]?.group ? [{ heading: o.group }] : []),
                    { id: o.id, label: o.label ?? o.name, text: o.name, icon: null, keep: true, hint: draft.includes(o.name) && <Icon name="check" size={13} />, run: () => toggle(o) },
                  ])
          }
        />
      )}
    </>
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
  const fix = t.fixVersions ?? [];
  // Archived versions only when the ticket still has them, as in Jira.
  const offered = (versions.data ?? []).filter((v) => !v.archived || fix.includes(v.name));
  return (
    <PickMany
      id="tk-fix"
      label="Fix versions"
      value={fix}
      options={offered.map((v) => ({ id: v.id, name: v.name, label: v.released ? `${v.name} (released)` : v.name }))}
      loading={versions.isLoading}
      saving={save.isPending}
      empty="No versions in this project"
      search="Filter versions"
      missing="Couldn't find every fix version in the project, nothing changed"
      onSave={(ids) => save.mutate({ id: t.conn, key: t.key, versions: ids })}
    />
  );
}
