import { type CSSProperties, type ReactNode, useState } from "react";

import { useAnalytics, useAnalyticsDay, useConfig, useProjects } from "../api/hooks";
import type { Analytics as A, Config, DayCommit } from "../api/types";
import { Avatar } from "../components/Avatar";
import { type Cell, DataTable, FigStrip, NoteLayout, PageNote, RailSkeleton } from "../components/Charts";
import { CheckPicker, keepAbsent } from "../components/CheckPicker";
import { Icon } from "../components/Icon";
import { ErrorBox, Header, Seg } from "../components/ui";
import { downloadCsv, plural } from "../lib/format";
import { kindOf, kindOfBranch } from "../lib/kinds";
import { useNav } from "../lib/nav";
import { useStored, useStoredList } from "../lib/stored";
import { Sprints } from "./Sprints";
import { Weekly } from "./Weekly";

const RANGES = ["7", "14", "21", "30", "90", "365"];
/** The list pane or the picked item's pane, on a phone where only one shows. */
export type Pane = "rail" | "detail";

function niceMax(v: number) {
  for (const s of [4, 8, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100]) if (v <= s) return s;
  return Math.ceil(v / 20) * 20;
}
const lead = (h: number) => {
  if (h < 1) return "Less than 1 h";
  const d = Math.floor(h / 24), r = h % 24;
  return d === 0 ? `${r} h` : r === 0 ? `${d} d` : `${d} d ${r} h`;
};
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", opts);
/** The backend's release date ("Nov 19, 2026") of day `iso`. */
const shippedOn = (iso: string) => fmt(iso, { month: "short", day: "numeric", year: "numeric" });
const GROUPS = [["feat", "Feature"], ["fix", "Fix"], ["other", "Other"]] as const;
/** `feat(ui): x` → feat; titles without a feat or fix prefix are other. */
const groupOf = (subject: string) => {
  const k = kindOf(subject.match(/^(\w+)[(!:]/)?.[1] ?? "");
  return k === "feat" || k === "fix" ? k : "other";
};

/** The trackers the chosen projects show tickets from, which name the tickets tab: Jira first, the one with sprints. */
function trackersOf(cfg: Config | undefined, ids: string[]) {
  const on = (repos: string[]) => repos.length === 0 || ids.some((id) => repos.includes(id));
  const i = cfg?.integrations;
  // shortcut: GitHub as soon as it is signed in, whether the chosen projects are on GitHub or not; ask the backend if it misleads.
  return [i?.jira.some((j) => on(j.repos)) && "Jira", i?.trello.some((t) => on(t.repos)) && "Trello", i?.asana.some((a) => on(a.repos)) && "Asana", i?.linear.some((l) => on(l.repos)) && "Linear", i?.githubConnected && "GitHub"].filter((x): x is string => !!x);
}

/** Words shaped like ticket keys that are not (as the backend's `extract_keys` skips them). */
const NOT_TICKETS = ["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "AES", "CVE", "MD", "X"];
/** Ticket keys in a commit's subject, written in capitals there, or in the branch it was made on, in any case. */
function keysIn(subject: string, branch: string) {
  const found = [...(subject.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? []), ...(branch.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d+/g) ?? [])];
  return [...new Set(found)].filter((k) => !NOT_TICKETS.includes(k.split("-")[0]));
}

type Release = A["releases"][number];
/** What the commits tab shows on the right: a day, or a release from the rail. */
type Pick = { day: string } | { release: Release };
const relKey = (r: Release) => `${r.project}:${r.version}`;

export function Analytics() {
  const nav = useNav();
  const projects = useProjects().data ?? [];
  const cfg = useConfig().data;
  const [days, setDays] = useStored("gnx.analytics.days", "14", (s) => (RANGES.includes(s) ? s : "14"), String);
  const [tab, setTab] = useStored<"commits" | "tickets">("gnx.analytics.tab", "commits", (s) => (s === "tickets" ? "tickets" : "commits"), String);
  const [view, setView] = useStored<"sprints" | "weekly">("gnx.analytics.ticketView", "sprints", (s) => (s === "weekly" ? "weekly" : "sprints"), String);
  // The day or release shown, picked in the rail, on the chart or from a ticket's code; a ticket key to open on the tickets tab.
  const [pick, setPick] = useState<Pick | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("rail");
  // Empty means every project.
  const [ids, setIds] = useState<string[]>(nav.projectId ? [nav.projectId] : []);
  // Emails of the people counted; empty means everyone. Kept when they commit in none of the days shown.
  const [who, setWho] = useStoredList("gnx.analytics.people");
  const q = useAnalytics(ids, Number(days), who);
  const people = q.data?.people ?? [];
  const picked = people.filter((p) => p.emails.some((e) => who.includes(e)));
  const by = who.length === 0 ? null : picked.length === 0 ? "the people picked" : picked.length === 1 ? picked[0].name : `${picked.length} people`;
  const multi = projects.length > 1 && ids.length !== 1;
  const trackers = trackersOf(cfg, ids.length ? ids : projects.map((p) => p.id));
  const tracker = trackers.join(" · ") || "Tickets";
  const jira = trackers.includes("Jira");
  const switchTab = (t: typeof tab) => { setTab(t); setPane("rail"); };
  const views = (
    <Seg
      label="View"
      value={tab}
      onChange={switchTab}
      options={[
        { value: "commits", label: <span className="row" style={{ gap: 6, margin: 0 }}><Icon name="commit" size={12} />Commits</span> },
        { value: "tickets", label: <span className="row" style={{ gap: 6, margin: 0 }}><Icon name="ticket" size={12} />{tracker}</span> },
      ]}
    />
  );
  const chosen = projects.filter((p) => ids.includes(p.id));
  const picker = projects.length > 1 && (
    <CheckPicker
      what="projects"
      items={projects.map((p) => ({ id: p.id, name: p.name }))}
      all={chosen.length === 0 || chosen.length === projects.length}
      picked={chosen.map((p) => p.id)}
      onChange={(v) => setIds(!v || v.length === projects.length ? [] : v)}
    />
  );
  const whoPicker = (people.length > 1 || who.length > 0) && (
    <CheckPicker
      what="people"
      items={people.map((p) => ({ id: p.emails[0], name: p.name, sub: p.emails.join(", "), avatar: p.emails[0] }))}
      all={who.length === 0}
      picked={picked.map((p) => p.emails[0])}
      onChange={(v) => setWho(keepAbsent(who, people.flatMap((p) => p.emails), v))}
    />
  );
  const title = <h2 className="map-title hide-narrow">Analytics</h2>;
  const sub = jira && <Seg label="Tickets view" value={view} onChange={(v) => { setView(v); setPane("rail"); }} options={[{ value: "sprints", label: "Sprints" }, { value: "weekly", label: "Weekly" }]} />;
  const leadBar = <>{title}{views}{picker}{sub}</>;
  const openTicket = jira ? (key: string) => { setView("sprints"); switchTab("tickets"); setFocus(key); } : undefined;
  const openDay = (d: string) => { setPick({ day: d }); setPane("detail"); };
  // The phone's header row: the page, or the pick once its pane is open.
  const header = (crumb?: string) => <Header title="Analytics" sub={pane === "detail" && crumb ? crumb : tab === "commits" ? "Commits" : tracker} hideWide onBack={pane === "detail" ? () => setPane("rail") : undefined} />;

  let body: ReactNode;
  if (tab === "tickets") {
    body =
      trackers.length === 0 ? (
        <>
          {header()}
          <div className="map-bar ana-bar">{leadBar}</div>
          <NoteLayout>
            <PageNote
              title="Connect a ticket tracker to see the work done"
              facts={[
                ["Weeks", "Tickets done each week, per person and per label, from every tracker the project uses"],
                ["Sprints (Jira)", "Velocity, burndown, hours left over, completion per person and the tickets at risk in the running sprint"],
                ["Links to commits", "Ticket keys in commit messages and branch names open the ticket's sprint from the Commits tab"],
              ]}
              actions={
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => nav.go({ name: "menu", section: "tools" })}>Connect a tracker</button>
                  {!cfg?.integrations.githubConnected && <button className="btn btn-sm" onClick={() => nav.go({ name: "menu", section: "git" })}>Sign in to GitHub</button>}
                </>
              }
            >
              <p>Jira, Trello, Asana or Linear, or GitHub for the issues of GitHub repositories. Once one is connected, this tab shows:</p>
            </PageNote>
          </NoteLayout>
        </>
      ) : jira && view === "sprints" ? (
        <Sprints ids={ids} lead={leadBar} header={header} focus={focus} onFocused={() => setFocus(null)} onDay={(d) => { switchTab("commits"); openDay(d); }} onWeekly={() => setView("weekly")} pane={pane} onPicked={() => setPane("detail")} />
      ) : (
        <Weekly ids={ids} lead={leadBar} header={header} trackers={tracker} pane={pane} onPicked={() => setPane("detail")} />
      );
  } else {
    body = (
      <>
        {header(pick ? ("day" in pick ? fmt(pick.day, { weekday: "short", month: "short", day: "numeric" }) : pick.release.version) : undefined)}
        <div className="map-bar ana-bar" data-detail={pane === "detail" || undefined}>
          {title}
          {views}
          {picker}
          <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((d) => ({ value: d, label: d === "365" ? "1 y" : `${d} d` }))} />
          {whoPicker}
          <span className="grow" />
          <button className="btn btn-sm hide-narrow" disabled={!q.data} onClick={() => q.data && downloadCsv(`gitnetix-activity-${days}d.csv`, [["date", "commits"], ...q.data.days.map((d) => [d.date, d.total])])}>
            <Icon name="download" size={12} />
            Export CSV
          </button>
        </div>
        {q.isLoading ? (
          <RailSkeleton />
        ) : q.data ? (
          <Commits
            a={q.data}
            multi={multi}
            by={by}
            busy={q.isPlaceholderData}
            ids={ids}
            who={who}
            pick={pick}
            onPick={(p) => { setPick(p); setPane("detail"); }}
            pane={pane}
            onTicket={openTicket}
            onLonger={Number(days) < 30 ? () => setDays("30") : undefined}
            onEveryone={who.length ? () => setWho([]) : undefined}
          />
        ) : (
          <NoteLayout rail="Days">
            <PageNote title="The commits could not load" error actions={<button className="btn btn-sm btn-primary" onClick={() => q.refetch()}>Retry</button>}>
              <p>Gitnetix reads them from the chosen projects' Git history. Retry, or check that the projects still open in the workspace.</p>
              {q.error && <code className="ana-err">{q.error.message}</code>}
            </PageNote>
          </NoteLayout>
        )}
      </>
    );
  }

  return body;
}

/** Days grouped by week (by month past a month), newest first: each its label, the rows inside and their commits. */
function groupDays(days: A["days"]) {
  const long = days.length > 31;
  const groups: { key: string; label: string; total: number; rows: { d: A["days"][number]; i: number }[] }[] = [];
  days.forEach((d, i) => {
    const t = new Date(`${d.date}T12:00:00`);
    const monday = new Date(t);
    monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const key = long ? d.date.slice(0, 7) : monday.toISOString().slice(0, 10);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const label = long ? t.toLocaleDateString("en-US", { month: "long", year: "numeric" }) : `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${sunday.toLocaleDateString("en-US", sunday.getMonth() === monday.getMonth() ? { day: "numeric" } : { month: "short", day: "numeric" })}`;
      g = { key, label, total: 0, rows: [] };
      groups.push(g);
    }
    g.total += d.total;
    g.rows.unshift({ d, i });
  });
  if (!long && groups.length) {
    groups[groups.length - 1].label = `This week · ${groups[groups.length - 1].label}`;
    if (groups.length > 1) groups[groups.length - 2].label = `Last week · ${groups[groups.length - 2].label}`;
  }
  return groups.reverse();
}

/** The commits tab: days and releases in the rail, the figures, the chart and the picked day or release beside it. */
function Commits({ a, multi, by, busy, ids, who, pick, onPick, pane, onTicket, onLonger, onEveryone }: {
  a: A; multi: boolean; by: string | null; busy: boolean; ids: string[]; who: string[]; pick: Pick | null; onPick: (p: Pick) => void; pane: Pane;
  onTicket?: (key: string) => void; onLonger?: () => void; onEveryone?: () => void;
}) {
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const work = a.days.filter((d) => !d.weekend).length || 1;
  // Nothing picked yet: the latest day with a commit.
  const shown: Pick | null = pick ?? (total ? { day: [...a.days].reverse().find((d) => d.total > 0)!.date } : null);
  const day = shown && "day" in shown ? shown.day : null;
  const rel = shown && "release" in shown ? shown.release : null;
  const dayMax = Math.max(1, ...a.days.map((d) => d.total));
  const leadMax = Math.max(1, ...a.releases.map((r) => r.leadHours));
  const tagsOn = (iso: string) => a.releases.filter((r) => r.shipped === shippedOn(iso));
  const kpis = [...a.kpis].sort((x, y) => Number(y.label === "Total commits") - Number(x.label === "Total commits"));
  const figs = [
    ...kpis.slice(0, 1).map((k) => ({ label: "Commits", value: k.value, sub: k.delta })),
    { label: "Per working day", value: String(Math.round((total / work) * 10) / 10), sub: `${plural(work, "working day")} shown` },
    ...kpis.slice(1).map((k) => ({ label: k.label, value: k.value, sub: k.delta })),
  ];
  const groups = groupDays(a.days);
  const inRange = a.releases.filter((r) => a.days.some((d) => r.shipped === shippedOn(d.date)));

  return (
    <div className="body split ana" data-busy={busy || undefined}>
      <section className="master ana-rail" data-pane data-active={pane === "rail"} aria-label="Days and releases">
        {total > 0 && (
          <div className="show-narrow ana-rail-head">
            <FigStrip items={figs.slice(0, 4)} />
            <Activity a={a} by={by} day={day} onDay={(d) => onPick({ day: d })} compact />
          </div>
        )}
        <div className="ana-rh">
          <h3>Days</h3>
          <span className="hint">{plural(total, "commit")}</span>
        </div>
        {groups.map((g) => (
          <div key={g.key}>
            <div className="ana-wk">
              <span>{g.label}</span>
              {a.days.length > 31 && <span className="mono">{g.total}</span>}
            </div>
            {g.rows.map(({ d }) => (
              <button key={d.date} className="ana-row" data-soft={d.weekend || undefined} aria-pressed={d.date === day} aria-label={`${fmt(d.date, { weekday: "long", month: "short", day: "numeric" })}: ${plural(d.total, "commit")}`} onClick={() => onPick({ day: d.date })}>
                <span className="ana-row-l">{fmt(d.date, { weekday: "short" })} <b>{d.date.slice(8).replace(/^0/, "")}</b></span>
                <span className="ana-track">
                  <span className="ana-fill" style={{ "--w": d.total / dayMax } as CSSProperties} />
                  {tagsOn(d.date).map((r) => (
                    <span key={relKey(r)} className="ana-tag mono"><Icon name="tag" size={11} />{r.version}</span>
                  ))}
                </span>
                <span className="ana-n">{d.total}</span>
              </button>
            ))}
          </div>
        ))}
        {a.releases.length > 0 && (
          <>
            <div className="ana-rh ana-sep">
              <h3>Lead time per release</h3>
              <span className="hint">first commit to tag</span>
            </div>
            {[...a.releases].reverse().map((r) => (
              <button key={relKey(r)} className="ana-row" aria-pressed={rel ? relKey(rel) === relKey(r) : false} title={multi ? r.project : undefined} onClick={() => onPick({ release: r })}>
                <span className="ana-row-l mono">{r.version}</span>
                <span className="ana-track">
                  <span className="ana-fill" style={{ "--w": r.leadHours / leadMax } as CSSProperties} />
                </span>
                <span className="ana-n">{lead(r.leadHours)}</span>
              </button>
            ))}
          </>
        )}
      </section>
      <main className="detail ana-det" data-pane data-active={pane === "detail"}>
        {total > 0 && (
          <div className="hide-narrow ana-stack">
            <FigStrip items={figs} />
            <Activity a={a} by={by} day={day} onDay={(d) => onPick({ day: d })} />
          </div>
        )}
        {total === 0 && !pick ? (
          <PageNote
            title={`No commits${by ? ` by ${by}` : ""} in the last ${plural(a.days.length, "day")}`}
            facts={[
              ["Days shown", `${fmt(a.days[0].date, { month: "short", day: "numeric" })} – ${fmt(a.days[a.days.length - 1].date, { month: "short", day: "numeric" })}`],
              ["Counted", by ?? "Everyone, on every branch of the chosen projects"],
              ["Releases in these days", inRange.length ? inRange.map((r) => `${r.version} on ${r.shipped.replace(/, \d{4}$/, "")}`).join(", ") : "None"],
            ]}
            actions={
              (onLonger || onEveryone) && (
                <>
                  {onLonger && <button className="btn btn-sm btn-primary" onClick={onLonger}>Show 30 days</button>}
                  {onEveryone && <button className="btn btn-sm" onClick={onEveryone}>Show everyone</button>}
                </>
              )
            }
          >
            <p>The days stay in the list at zero, so a quiet stretch shows as one.</p>
          </PageNote>
        ) : day ? (
          <DayDetail date={day} ids={ids} who={who} multi={multi} tags={tagsOn(day)} onTicket={onTicket} />
        ) : rel ? (
          <ReleaseDetail r={rel} multi={multi} />
        ) : null}
      </main>
    </div>
  );
}

/** Commits per day, the picked day in ink, release tags as stations on their day. */
function Activity({ a, by, day, onDay, compact }: { a: A; by: string | null; day: string | null; onDay: (date: string) => void; compact?: boolean }) {
  const [hd, setHd] = useState(-1);
  const [asTable, setAsTable] = useState(false);
  const n = a.days.length;
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const max = niceMax(Math.max(1, ...a.days.map((d) => d.total)));
  const busiest = a.days.reduce((b, d) => (d.total > b.total ? d : b), a.days[0]);
  const labels = compact ? 5 : n <= 30 ? 6 : n <= 90 ? 7 : 12;
  // Up to a month, every day has its label and the picked one is in ink.
  const daily = !compact && n <= 31;
  const hover = hd >= 0 ? a.days[hd] : null;
  const ticks = [0, 1, 2, 3, 4].map((i) => ({ v: Math.round((max * i) / 4), top: 100 - i * 25 }));
  const stations = a.days.flatMap((d, i) => a.releases.filter((r) => r.shipped === shippedOn(d.date)).map((r) => ({ r, i })));
  return (
    <section className="ana-sec">
      {!compact && (
        <div className="ana-sh">
          <div>
            <h2>Commits per day</h2>
            <span className="hint">{by ? `By ${by}` : "Everyone"}, last {plural(n, "day")}. Pick a day for its commits.</span>
          </div>
          <span className="ana-key"><i />Working day</span>
          <span className="ana-key"><i data-soft />Weekend</span>
          {stations.length > 0 && <span className="ana-key"><Icon name="tag" size={11} />Release tagged</span>}
          <button className="btn btn-ghost btn-icon btn-sm" aria-pressed={asTable} aria-label={asTable ? "Show the chart" : "Show as a table"} data-tip={asTable ? "Show the chart" : "Show as a table"} onClick={() => setAsTable(!asTable)}>
            <Icon name={asTable ? "chart" : "table"} size={13} />
          </button>
        </div>
      )}
      {asTable ? (
        <DataTable rows={[["Date", "Commits", "By"], ...a.days.map((d): Cell[] => [d.date, d.total, d.authors.map(([name, c]) => `${name} (${c})`).join("; ")])]} />
      ) : (
      <div className="chart ana-chart" role="group" aria-label={`${total} commits over the last ${n} days. Busiest day ${busiest ? fmt(busiest.date, { month: "short", day: "numeric" }) : ""} with ${busiest?.total ?? 0} commits.`}>
        <div className="chart-y">{ticks.map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
        <div className="chart-plot" style={{ gap: n <= 30 ? 6 : n <= 90 ? 2 : 0 }} onMouseLeave={() => setHd(-1)}>
          {ticks.map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
          {stations.map(({ r, i }) => (
            <span key={relKey(r)} className="ana-station" style={{ left: `${((i + 1) / n) * 100}%` }}>
              <b className="mono">{r.version}</b>
            </span>
          ))}
          {a.days.map((d, i) => (
            <button
              key={d.date}
              className={`chart-bar ana-col${d.weekend ? " weekend" : ""}${d.date === day ? " on" : ""}`}
              aria-pressed={d.date === day}
              aria-label={`${fmt(d.date, { weekday: "short", month: "short", day: "numeric" })}: ${plural(d.total, "commit")}`}
              data-tip-off
              onMouseEnter={() => setHd(i)}
              onFocus={() => setHd(i)}
              onBlur={() => setHd(-1)}
              onClick={() => onDay(d.date)}
            >
              <span style={{ height: `${(d.total / max) * 100}%` }} />
              {d.date === day && d.total > 0 && <b className="ana-col-v mono" style={{ bottom: `calc(${(d.total / max) * 100}% + 4px)` }}>{d.total}</b>}
            </button>
          ))}
          {hover && (
            <div className="chart-tip" style={{ left: `${((hd + 0.5) / n) * 100}%`, transform: `translateX(${hd / n < 0.2 ? "0" : hd / n > 0.8 ? "-100%" : "-50%"})` }}>
              <div className="row">
                <strong className="grow">{fmt(hover.date, { weekday: "short", month: "short", day: "numeric" })}</strong>
                <span>{plural(hover.total, "commit")}</span>
              </div>
              {hover.authors.map(([name, c]) => (
                <div key={name} className="row">
                  <Avatar name={name} size={20} decorative />
                  <span className="grow">{name}</span>
                  <span className="mono">{c}</span>
                </div>
              ))}
              {hover.subjects.map((s, i) => <span key={i} className="mono faint ellipsis" style={{ fontSize: 11 }}>{s}</span>)}
              {hover.total > hover.subjects.length && <span className="faint">+ {hover.total - hover.subjects.length} more</span>}
            </div>
          )}
        </div>
        <div className="chart-x">
          {daily && a.days.map((d, i) => (
            <span key={d.date} className={d.date === day ? "ana-x-on" : undefined} style={{ left: `${((i + 0.5) / n) * 100}%`, transform: "translateX(-50%)" }}>
              {i === 0 || d.date.endsWith("-01") ? fmt(d.date, { month: "short", day: "numeric" }) : Number(d.date.slice(8))}
            </span>
          ))}
          {!daily && Array.from({ length: labels }, (_, j) => {
            const idx = Math.round((j * (n - 1)) / (labels - 1));
            const d = a.days[idx];
            if (!d) return null;
            return (
              <span key={j} style={{ left: `${((idx + 0.5) / n) * 100}%`, transform: `translateX(${j === 0 ? "0" : j === labels - 1 ? "-100%" : "-50%"})` }}>
                {fmt(d.date, n > 90 ? { month: "short" } : { month: "short", day: "numeric" })}
              </span>
            );
          })}
        </div>
      </div>
      )}
    </section>
  );
}

/** Who did what on `date`: each person's commits by type, with the branch each was made on. */
function DayDetail({ date, ids, who, multi, tags, onTicket }: { date: string; ids: string[]; who: string[]; multi: boolean; tags: Release[]; onTicket?: (key: string) => void }) {
  const q = useAnalyticsDay(ids, date, who);
  const nav = useNav();
  const projects = useProjects().data ?? [];
  const workspace = (c: DayCommit) => {
    const p = projects.find((x) => x.name === c.project);
    if (!p || !c.branch) return;
    nav.setProject(p.id);
    nav.selectBranch(c.branch);
    nav.go({ name: "workspace" });
  };
  const people = new Map<string, DayCommit[]>();
  for (const c of q.data ?? []) people.set(c.author, [...(people.get(c.author) ?? []), c]);
  // The day in the workspace: the release branch of a version tagged that day, else the branch with the most commits.
  const open = (q.data ?? []).filter((c) => c.branch && projects.some((x) => x.name === c.project));
  const busiest = [...open.reduce((m, c) => m.set(`${c.project}\n${c.branch}`, (m.get(`${c.project}\n${c.branch}`) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
  const target = open.find((c) => tags.some((r) => c.project === r.project && /^release[/-]/.test(c.branch) && c.branch.endsWith(r.version.replace(/^v/, "")))) ?? open.find((c) => `${c.project}\n${c.branch}` === busiest);
  return (
    <section className="ana-sec" aria-label="Commits of the day">
      <div className="ana-dh">
        <h3>{fmt(date, { weekday: "long", month: "long", day: "numeric" })}</h3>
        {q.data && <span className="muted">{plural(q.data.length, "commit")}{people.size > 1 ? ` · ${people.size} people` : ""}</span>}
        {tags.map((r) => <span key={relKey(r)} className="ana-pill"><Icon name="tag" size={12} /><span className="mono">{r.version}</span> tagged</span>)}
        {target && (
          <>
            <span className="grow" />
            <button className="btn btn-sm" data-tip={`Opens ${target.branch}${multi ? ` in ${target.project}` : ""}`} onClick={() => workspace(target)}>
              <Icon name="branch" size={12} />
              Open in the workspace
            </button>
          </>
        )}
      </div>
      {q.isLoading && <div className="ana-lines" aria-busy="true">{[70, 55, 80].map((w) => <span key={w} className="ana-sk" style={{ width: `${w}%` }} />)}</div>}
      {q.error && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && <p className="muted">{who.length ? "No commits by the people picked this day." : "No commits this day."}</p>}
      <div className="ana-day">
        {[...people].sort((x, y) => y[1].length - x[1].length).map(([name, list]) => (
          <div key={name} className="ana-person">
            <div className="ana-person-h">
              <Avatar name={name} size={22} decorative />
              <strong className="grow">{name}</strong>
              <span className="hint">{plural(list.length, "commit")}</span>
            </div>
            {[...list].sort((x, y) => GROUPS.findIndex(([k]) => k === groupOf(x.subject)) - GROUPS.findIndex(([k]) => k === groupOf(y.subject))).map((c) => (
              <div key={`${c.project}:${c.sha}`} className="ana-cm">
                <span className="faint">{GROUPS.find(([k]) => k === groupOf(c.subject))![1]}</span>
                <span className="mono ellipsis ana-cm-s" title={c.subject}>{c.subject}</span>
                <span className="ana-cm-t">
                  {onTicket && keysIn(c.subject, c.branch).map((k) => (
                    <button key={k} className="spr-chip" data-tip={`See ${k} on the tickets tab`} onClick={() => onTicket(k)}>{k}</button>
                  ))}
                </span>
                {c.branch && projects.some((x) => x.name === c.project) ? (
                  <button className="mono ellipsis ana-cm-b ana-link" data-tip={`Open ${c.branch} in the workspace`} onClick={() => workspace(c)}><Icon name="branch" size={11} /><span className="ellipsis">{multi ? `${c.project} · ` : ""}{c.branch}</span></button>
                ) : (
                  <span className="mono faint ellipsis ana-cm-b" title={c.branch}>{multi ? `${c.project} · ` : ""}{c.branch || "no branch"}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What a release shipped: its features, its fixes and the branches merged in. */
function ReleaseDetail({ r, multi }: { r: Release; multi: boolean }) {
  const lists = [["Features", r.featureTitles], ["Fixes", r.fixTitles], ["Branches merged", r.branches]] as const;
  return (
    <section className="ana-sec" aria-label={`Release ${r.version}`}>
      <div className="ana-dh">
        <h3 className="mono">{r.version}</h3>
        <span className="muted">{multi ? `${r.project} · ` : ""}Shipped {r.shipped} · {lead(r.leadHours)} from its first commit</span>
      </div>
      <div className="ana-day">
        {lists.map(([label, list]) => (
          <div key={label} className="ana-person">
            <div className="ana-person-h">
              <strong className="grow">{label}</strong>
              <span className="hint">{list.length}</span>
            </div>
            {list.length === 0 && <span className="faint">{label === "Branches merged" ? "No merge commit names a branch (rebased or fast-forwarded in)" : "None"}</span>}
            {list.map((t, i) => {
              const k = label === "Branches merged" ? kindOfBranch(t) : null;
              return (
                <div key={i} className="ana-cm" style={{ gridTemplateColumns: k ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
                  {k && <span className="faint">{k}</span>}
                  <span className="mono ellipsis ana-cm-s" title={t}>{t}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
