import { useEffect, useRef, useState } from "react";

import { useAnalytics, useAnalyticsDay, useProjects } from "../api/hooks";
import type { Analytics as A, DayCommit, ProjectSummary } from "../api/types";
import { SEARCH_ABOVE } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Header, initials, Loading, Modal, Seg } from "../components/ui";
import { plural } from "../lib/format";
import { kindOf, kindOfBranch } from "../lib/kinds";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";

const RANGES = ["7", "14", "21", "30", "90", "365"];

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
const GROUPS = [["feat", "Features"], ["fix", "Fixes"], ["other", "Other"]] as const;
/** `feat(ui): x` → feat; titles without a feat or fix prefix are other. */
const groupOf = (subject: string) => {
  const k = kindOf(subject.match(/^(\w+)[(!:]/)?.[1] ?? "");
  return k === "feat" || k === "fix" ? k : "other";
};

export function Analytics() {
  const nav = useNav();
  const projects = useProjects().data ?? [];
  const [days, setDays] = useStored("gnx.analytics.days", "14", (s) => (RANGES.includes(s) ? s : "14"), String);
  // Empty means every project.
  const [ids, setIds] = useState<string[]>(nav.projectId ? [nav.projectId] : []);
  const q = useAnalytics(ids, Number(days));
  const multi = projects.length > 1 && ids.length !== 1;

  const exportCsv = () => {
    if (!q.data) return;
    const rows = [["date", "commits"], ...q.data.days.map((d) => [d.date, String(d.total)])];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gitnetix-activity-${days}d.csv`;
    a.click();
  };

  return (
    <>
      <Header title="Analytics & stats" hideWide />
      <main className="page">
        <div className="col" style={{ gap: 32, maxWidth: 1200, marginInline: "auto" }}>
          <div className="row wrap" style={{ margin: 0, gap: 12 }}>
            <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((d) => ({ value: d, label: `${d} days` }))} />
            <ProjectPicker projects={projects} value={ids} onChange={setIds} />
            <span className="grow" />
            <button className="btn" disabled={!q.data} onClick={exportCsv}>Export CSV</button>
          </div>
          {q.isLoading && <Loading />}
          {q.error && <ErrorBox error={q.error} />}
          {q.data && <Body a={q.data} ids={ids} multi={multi} />}
        </div>
      </main>
    </>
  );
}

/** Dropdown of project checkboxes; nothing checked means all projects. */
function ProjectPicker({ projects, value, onChange }: { projects: ProjectSummary[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  // Ids of removed projects are dropped from the label and the count.
  const chosen = projects.filter((p) => value.includes(p.id));
  const label = chosen.length === 0 || chosen.length === projects.length ? "All projects" : chosen.length === 1 ? chosen[0].name : `${chosen.length} projects`;
  const toggle = (id: string) => {
    const next = chosen.some((p) => p.id === id) ? chosen.filter((p) => p.id !== id) : [...chosen, projects.find((p) => p.id === id)!];
    onChange(next.length === projects.length ? [] : next.map((p) => p.id));
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="select row" style={{ height: 32, gap: 8 }} aria-haspopup="true" aria-expanded={open} onClick={() => { setOpen(!open); setQuery(""); }}>
        <span className="sr-only">Projects: </span>
        <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="ctx-menu" role="group" aria-label="Projects to include" style={{ position: "absolute", top: 36, left: 0, maxHeight: 360, overflowY: "auto" }}>
          {projects.length > SEARCH_ABOVE && (
            <div className="ctx-filter">
              <input className="input" autoFocus aria-label="Filter projects" placeholder="Filter projects" spellCheck={false} autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          {!q && (
            <>
              <label className="check ctx-item">
                <input type="checkbox" checked={chosen.length === 0 || chosen.length === projects.length} onChange={() => onChange([])} />
                <span className="grow ellipsis">All projects</span>
              </label>
              <div className="ctx-sep" role="separator" />
            </>
          )}
          {!shown.length && <button className="ctx-item" disabled>No match for “{query.trim()}”</button>}
          {shown.map((p) => (
            <label key={p.id} className="check ctx-item">
              <input type="checkbox" checked={chosen.some((c) => c.id === p.id)} onChange={() => toggle(p.id)} />
              <span className="grow ellipsis">{p.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Body({ a, ids, multi }: { a: A; ids: string[]; multi: boolean }) {
  const [hd, setHd] = useState(-1);
  const [hb, setHb] = useState(-1);
  const [day, setDay] = useState<string | null>(null);
  const [rel, setRel] = useState<A["releases"][number] | null>(null);
  const n = a.days.length;
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const work = a.days.filter((d) => !d.weekend).length || 1;
  const max = niceMax(Math.max(1, ...a.days.map((d) => d.total)));
  const busiest = a.days.reduce((b, d) => (d.total > b.total ? d : b), a.days[0]);
  const labels = n <= 30 ? 6 : n <= 90 ? 7 : 12;
  const leadMax = niceMax(Math.max(1, ...a.releases.map((r) => r.leadHours / 24)));
  const hover = hd >= 0 ? a.days[hd] : null;
  const ticks = (m: number, unit = "") => [0, 1, 2, 3, 4].map((i) => ({ v: `${Math.round((m * i) / 4)}${unit && i === 4 ? unit : ""}`, top: 100 - i * 25 }));

  return (
    <div className="col" style={{ gap: 32 }}>
      <section aria-label="Key figures" className="kpis">
        {a.kpis.map((k) => (
          <div key={k.label} className="kpi">
            <span className="muted" style={{ fontSize: 12 }}>{k.label}</span>
            <span className="v">{k.value}</span>
            <span className="faint" style={{ fontSize: 12 }}>{k.delta}</span>
          </div>
        ))}
      </section>

      <section className="section card" style={{ padding: 20 }}>
        <div className="row wrap" style={{ alignItems: "baseline" }}>
          <div className="col grow" style={{ gap: 2 }}>
            <h2>Activity, last {n} days</h2>
            <span className="hint">Commits per day, everyone on the project</span>
          </div>
          <span className="muted"><strong style={{ color: "var(--fg)" }}>{total.toLocaleString("en-US")}</strong> commits</span>
          <span className="muted"><strong style={{ color: "var(--fg)" }}>{(Math.round((total / work) * 10) / 10).toString()}</strong> per working day</span>
        </div>
        <div className="chart" role="group" aria-label={`${total} commits over the last ${n} days. Busiest day ${busiest ? fmt(busiest.date, { month: "short", day: "numeric" }) : ""} with ${busiest?.total ?? 0} commits.`}>
          <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
          <div className="chart-plot" style={{ gap: n <= 30 ? 3 : n <= 90 ? 2 : 0 }} onMouseLeave={() => setHd(-1)}>
            {ticks(max).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
            {a.days.map((d, i) => (
              <button key={d.date} className={`chart-bar${d.weekend ? " weekend" : ""}${hd >= 0 && hd !== i ? " dim" : ""}`} aria-label={`${fmt(d.date, { weekday: "short", month: "short", day: "numeric" })}: ${plural(d.total, "commit")}`} onMouseEnter={() => setHd(i)} onClick={() => setDay(d.date)}>
                <span style={{ height: `${(d.total / max) * 100}%` }} />
              </button>
            ))}
            {hover && (
              <div className="chart-tip" style={{ left: `${((hd + 0.5) / n) * 100}%`, transform: `translateX(${hd / n < 0.2 ? "0" : hd / n > 0.8 ? "-100%" : "-50%"})` }}>
                <div className="row">
                  <strong className="grow">{fmt(hover.date, { weekday: "short", month: "short", day: "numeric" })}</strong>
                  <span>{hover.total === 1 ? "1 commit" : `${hover.total} commits`}</span>
                </div>
                {hover.authors.map(([name, c]) => (
                  <div key={name} className="row">
                    <span className="avatar" style={{ width: 20, height: 20, flexBasis: 20, fontSize: 9 }}>{initials(name)}</span>
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
            {Array.from({ length: labels }, (_, j) => {
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
      </section>

      <section className="section card" style={{ padding: 20 }}>
        <div className="col" style={{ gap: 2 }}>
          <h2>Lead time per release</h2>
          <span className="hint">Days from the first commit to the tag · last {a.releases.length} releases</span>
        </div>
        {a.releases.length === 0 ? (
          <span className="muted">No tagged release yet.</span>
        ) : (
          <div className="chart" role="group" aria-label={`Lead time per release: ${a.releases.map((r) => `${r.version} ${lead(r.leadHours)}`).join(", ")}.`}>
            <div className="chart-y">{ticks(leadMax, " d").map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
            <div className="chart-plot" style={{ gap: 16 }} onMouseLeave={() => setHb(-1)}>
              {ticks(leadMax).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
              {a.releases.map((r, i) => (
                <button key={`${r.project}:${r.version}`} className={`chart-bar${hb >= 0 && hb !== i ? " dim" : ""}`} aria-label={`${r.version}: ${lead(r.leadHours)}`} onMouseEnter={() => setHb(i)} onClick={() => setRel(r)}>
                  <span style={{ height: `${(r.leadHours / 24 / leadMax) * 100}%`, maxWidth: 56, borderRadius: "3px 3px 0 0" }} />
                  {hb === i && (
                    <div className="chart-tip" style={{ left: i / a.releases.length < 0.2 ? 0 : i / a.releases.length > 0.8 ? "100%" : "50%", transform: `translateX(${i / a.releases.length < 0.2 ? "0" : i / a.releases.length > 0.8 ? "-100%" : "-50%"})` }}>
                      <div className="row">
                        <strong className="mono grow">{r.version}</strong>
                        <span>{lead(r.leadHours)}</span>
                      </div>
                      {([["Shipped", r.shipped], ["Features", r.features], ["Fixes", r.fixes]] as const).map(([k, v]) => (
                        <div key={k} className="row">
                          <span className="grow muted">{k}</span>
                          <span className="mono">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
            <div className="row" style={{ gridColumn: 2, gap: 16 }}>
              {a.releases.map((r) => <span key={`${r.project}:${r.version}`} className="mono faint" style={{ flex: "1 1 0", textAlign: "center", fontSize: 11 }}>{r.version}</span>)}
            </div>
          </div>
        )}
      </section>
      {day && <DayModal date={day} ids={ids} multi={multi} onClose={() => setDay(null)} />}
      {rel && <ReleaseModal r={rel} multi={multi} onClose={() => setRel(null)} />}
    </div>
  );
}

/** Who did what on `date`: each person's commits by type, with the branch each was made on. */
function DayModal({ date, ids, multi, onClose }: { date: string; ids: string[]; multi: boolean; onClose: () => void }) {
  const q = useAnalyticsDay(ids, date);
  const people = new Map<string, DayCommit[]>();
  for (const c of q.data ?? []) people.set(c.author, [...(people.get(c.author) ?? []), c]);
  return (
    <Modal title={fmt(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} sub={q.data && plural(q.data.length, "commit")} onClose={onClose} width={720}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data?.length === 0 && <Empty>No commits this day.</Empty>}
      {[...people].sort((x, y) => y[1].length - x[1].length).map(([name, list]) => (
        <section key={name} className="col" style={{ gap: 8 }}>
          <div className="row">
            <span className="avatar" style={{ width: 24, height: 24, flexBasis: 24, fontSize: 10 }}>{initials(name)}</span>
            <strong className="grow">{name}</strong>
            <span className="muted">{plural(list.length, "commit")}</span>
          </div>
          {GROUPS.map(([kind, label]) => {
            const of = list.filter((c) => groupOf(c.subject) === kind);
            return of.length > 0 && (
              <div key={kind} className="col" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>{label}</span>
                {of.map((c) => (
                  <div key={`${c.project}:${c.sha}`} className="row" style={{ gap: 8, fontSize: 12 }}>
                    <span className="mono ellipsis grow" title={c.subject}>{c.subject}</span>
                    {multi && <span className="faint">{c.project}</span>}
                    <span className="mono faint ellipsis" style={{ maxWidth: 220 }} title={c.branch}>{c.branch || "no branch"}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      ))}
    </Modal>
  );
}

/** What a release shipped: its features, its fixes and the branches merged in. */
function ReleaseModal({ r, multi, onClose }: { r: A["releases"][number]; multi: boolean; onClose: () => void }) {
  const lists = [["Features", r.featureTitles], ["Fixes", r.fixTitles], ["Branches merged", r.branches]] as const;
  return (
    <Modal title={<span className="mono">{r.version}</span>} sub={`${multi ? `${r.project} · ` : ""}Shipped ${r.shipped} · ${lead(r.leadHours)} from first commit`} onClose={onClose} width={640}>
      {lists.map(([label, list]) => (
        <section key={label} className="col" style={{ gap: 6 }}>
          <div className="row">
            <h2 className="grow">{label}</h2>
            <span className="muted">{list.length}</span>
          </div>
          {list.length === 0 && <span className="faint">{label === "Branches merged" ? "No merge commit names a branch (rebased or fast-forwarded in)" : "None"}</span>}
          {list.map((t, i) => {
            const k = label === "Branches merged" ? kindOfBranch(t) : null;
            return (
              <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
                {k && <span className={`kind-chip ${k === "fix" ? "c-del" : "c-mod"}`}>{k}</span>}
                <span className="mono ellipsis grow" title={t}>{t}</span>
              </div>
            );
          })}
        </section>
      ))}
    </Modal>
  );
}
