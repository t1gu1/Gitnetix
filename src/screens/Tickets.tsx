import { useState, type CSSProperties } from "react";

import { useAction, useOverview, useProjects, useTickets } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { Suggestion, Ticket } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, Empty, ErrorBox, Header, Loading, releaseTagLabel, Seg } from "../components/ui";
import { useNav } from "../lib/nav";

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
  const [mine, setMine] = useState(false);
  const [sprint, setSprint] = useState(false);
  const q = useTickets(pid, mine, sprint);
  const ov = useOverview(pid).data;
  const projects = useProjects().data ?? [];
  const home = (x: Ticket) => projects.find((p) => p.id === x.branchProject)?.name;
  const [place, setPlace] = useState<string>("all");
  const [group, setGroup] = useState<"release" | "status">("release");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<string | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.tickets", 400, 280, 720);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const setRel = useAction("tickets.setRelease", { invalidate: [["tickets", pid], ["overview", pid]] });
  const triage = useAction<Suggestion[]>("tickets.triage", {
    success: (r) => (r.length ? `AI suggested a release for ${r.length} ticket${r.length === 1 ? "" : "s"}` : "Nothing to triage"),
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

  if (q.isLoading) return (<><Header title="Tickets" /><Loading /></>);
  if (q.data && q.data.sources.length === 0) {
    return (
      <>
        <Header title="Tickets" sub={ov?.project.name} />
        <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ maxWidth: 420 }}>
            <Empty>
              Connect Jira, Trello or Asana to see tickets here, plan them into releases and start a branch from one.
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-primary" onClick={() => nav.go({ name: "settings", section: "tools" })}>Connect a tracker</button>
              </div>
            </Empty>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title="Tickets"
        sub={[ov?.project.name, shown === "all" ? "" : shown].filter(Boolean).join(" · ")}
        right={
          <>
            <span className="faint hide-narrow" style={{ fontSize: 12 }}>{q.data?.syncedAt ? `Synced ${ago(q.data.syncedAt)}` : ""}</span>
            <button className="btn btn-icon" style={{ height: 28 }} aria-label="Sync now" onClick={() => q.refetch()}>
              <Busy on={q.isFetching}><Icon name="refresh" size={13} /></Busy>
            </button>
          </>
        }
      />
      {q.error ? (
        <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <ErrorBox error={q.error} />
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => nav.go({ name: "settings", section: "tools" })}>Open settings</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="body split">
          <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Ticket list">
            <div className="master-tools">
              <label htmlFor="tk-q" className="sr-only">Search tickets</label>
              <input id="tk-q" className="input" placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value)} />
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
              {unplanned > 0 && open.length > 0 && (
                <button
                  className="btn"
                  disabled={triage.isPending}
                  onClick={() => triage.mutate({ projectId: pid }, { onSuccess: (r) => setSuggestions(Object.fromEntries(r.map((s) => [s.key, s]))) })}
                >
                  <Busy on={triage.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
                  Triage {unplanned} unplanned with AI
                </button>
              )}
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
              {grouped.map((g) => (
                <div key={g.id || "none"}>
                  <div className="group-head">
                    <span>{g.label}</span>
                    <span>{g.items.length}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    {g.items.map((x) => (
                      <button key={x.key} className="item-btn" style={{ gap: 1, padding: "7px 12px" }} aria-pressed={x.key === t?.key} onClick={() => { setSel(x.key); setPane("detail"); }}>
                        <span className="row" style={{ gap: 8, margin: "0 0 2px", fontSize: 11.5 }}>
                          <Avatar name={x.assignee} />
                          <span className="mono faint">{x.key}</span>
                          <span className={STATUS[x.status][1]}>{x.statusLabel || STATUS[x.status][0]}</span>
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
          </section>
          <Resizer pane={listW} label="Resize ticket list" />
          <main className="detail" data-pane data-active={pane === "detail"}>
            <button className="btn btn-sm show-narrow" style={{ marginBottom: 12 }} onClick={() => setPane("list")}>
              <Icon name="back" size={12} />
              All tickets
            </button>
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
              <Empty>Select a ticket.</Empty>
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
  const kind = /bug|fix/i.test(t.kind) ? "fix" : "feat";
  const rel = releases.find((r) => r.version === t.release);
  const done = t.criteria.filter((c) => c.done).length;
  return (
    <div className="detail-inner">
      <div className="col" style={{ gap: 8 }}>
        <div className="row wrap muted" style={{ fontSize: 12.5 }}>
          <span className="mono">{t.key}</span>
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
      <div className="kv">
        <div><span>Status</span><span className={STATUS[t.status][1]}>{t.statusLabel || STATUS[t.status][0]}</span></div>
        <div><span>Type</span><span>{t.kind}</span></div>
        <div><span>Assignee</span><span>{t.assignee}</span></div>
        {t.fixVersions?.length ? <div><span>Fix versions</span><span>{t.fixVersions.join(", ")}</span></div> : null}
        <div>
          <label htmlFor="tk-rel" style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Release</label>
          <MenuChoice id="tk-rel" className="select menu-select" style={{ height: 30, width: "100%" }} label="Release" value={rel ? t.release : ""} options={[...releases.map((r) => ({ value: r.version, label: r.label })), { value: "", label: "Unplanned" }]} onChange={onRelease} />
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
        <p style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }} className={t.description ? "" : "muted"}>{t.description || "No description."}</p>
      </section>
      {t.criteria.length > 0 && (
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
      <div className="hint">{t.comments === 0 ? `No comments in ${SRC[t.source]}.` : `${t.comments} comment${t.comments === 1 ? "" : "s"} in ${SRC[t.source]}.`}</div>
    </div>
  );
}
