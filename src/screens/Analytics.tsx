import { useEffect, useRef, useState } from "react";

import { useAnalytics, useProjects } from "../api/hooks";
import type { Analytics as A, ProjectSummary } from "../api/types";
import { Icon } from "../components/Icon";
import { ErrorBox, Header, initials, Loading, Seg } from "../components/ui";
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

export function Analytics() {
  const nav = useNav();
  const projects = useProjects().data ?? [];
  const [days, setDays] = useStored("gnx.analytics.days", "14", (s) => (RANGES.includes(s) ? s : "14"), String);
  // Empty means every project.
  const [ids, setIds] = useState<string[]>(nav.projectId ? [nav.projectId] : []);
  const q = useAnalytics(ids, Number(days));

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
      <div className="row wrap" style={{ margin: 0, padding: "10px 24px", borderBottom: "1px solid var(--line)", gap: 12 }}>
        <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((d) => ({ value: d, label: `${d} days` }))} />
        <ProjectPicker projects={projects} value={ids} onChange={setIds} />
        <span className="grow" />
        <button className="btn" disabled={!q.data} onClick={exportCsv}>Export CSV</button>
      </div>
      <main className="page">
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {q.data && <Body a={q.data} />}
      </main>
    </>
  );
}

/** Dropdown of project checkboxes; nothing checked means all projects. */
function ProjectPicker({ projects, value, onChange }: { projects: ProjectSummary[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
      <button className="select row" style={{ height: 32, gap: 8 }} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sr-only">Projects: </span>
        <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="ctx-menu" role="group" aria-label="Projects to include" style={{ position: "absolute", top: 36, left: 0, maxHeight: 360, overflowY: "auto" }}>
          <label className="check ctx-item">
            <input type="checkbox" checked={chosen.length === 0 || chosen.length === projects.length} onChange={() => onChange([])} />
            <span className="grow ellipsis">All projects</span>
          </label>
          <div className="ctx-sep" role="separator" />
          {projects.map((p) => (
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

function Body({ a }: { a: A }) {
  const [hd, setHd] = useState(-1);
  const [hb, setHb] = useState(-1);
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
    <div className="col" style={{ gap: 32, maxWidth: 1200, marginInline: "auto" }}>
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
        <div className="chart" role="img" aria-label={`${total} commits over the last ${n} days. Busiest day ${busiest ? fmt(busiest.date, { month: "short", day: "numeric" }) : ""} with ${busiest?.total ?? 0} commits.`}>
          <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
          <div className="chart-plot" style={{ gap: n <= 30 ? 3 : n <= 90 ? 2 : 0 }} onMouseLeave={() => setHd(-1)}>
            {ticks(max).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
            {a.days.map((d, i) => (
              <div key={d.date} className={`chart-bar${d.weekend ? " weekend" : ""}${hd >= 0 && hd !== i ? " dim" : ""}`} onMouseEnter={() => setHd(i)}>
                <span style={{ height: `${(d.total / max) * 100}%` }} />
              </div>
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
          <div className="chart" role="img" aria-label={`Lead time per release: ${a.releases.map((r) => `${r.version} ${lead(r.leadHours)}`).join(", ")}.`}>
            <div className="chart-y">{ticks(leadMax, " d").map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
            <div className="chart-plot" style={{ gap: 16 }} onMouseLeave={() => setHb(-1)}>
              {ticks(leadMax).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
              {a.releases.map((r, i) => (
                <div key={r.version} className={`chart-bar${hb >= 0 && hb !== i ? " dim" : ""}`} onMouseEnter={() => setHb(i)}>
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
                </div>
              ))}
            </div>
            <div className="row" style={{ gridColumn: 2, gap: 16 }}>
              {a.releases.map((r) => <span key={r.version} className="mono faint" style={{ flex: "1 1 0", textAlign: "center", fontSize: 11 }}>{r.version}</span>)}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
