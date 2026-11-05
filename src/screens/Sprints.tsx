import { type ReactNode, useEffect, useState } from "react";

import { useSprints } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { SprintBoard, SprintStat, SprintTicket, Stage, Work } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Avatar } from "../components/Avatar";
import { Ask, Card, type Cell, day, heat, Key, type Level, LevelChip, niceMax, path, pct, type Pt, type Qa, r1, r2, rank, slug, span, ticks, tipAt, TipRow, weekday } from "../components/Charts";
import { Icon } from "../components/Icon";
import { ago, Busy, Empty, EmptyState, ErrorBox, Loading, Modal, Seg } from "../components/ui";
import { downloadCsv, plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { toast } from "../lib/toast";

type Unit = keyof Work;

const UNITS: { value: Unit; label: string }[] = [
  { value: "points", label: "Points" },
  { value: "tickets", label: "Tickets" },
  { value: "hours", label: "Hours" },
];
const COUNTS = ["4", "6", "8", "12"];
const STATUS: [SprintTicket["status"], string][] = [["todo", "To do"], ["progress", "In progress"], ["review", "In review"], ["ready", "Ready to merge"], ["done", "Done"]];
/** Status blocks: not started in gray, then the series hue darkening along the workflow to done. */
const STATUS_FILL = ["var(--s-ctx)", "color-mix(in srgb, var(--s1) 45%, var(--panel))", "color-mix(in srgb, var(--s1) 62%, var(--panel))", "color-mix(in srgb, var(--s1) 80%, var(--panel))", "var(--s1)"];
/** Where time after the start goes, in workflow order: the statuses a ticket waits or works in. */
const STAGES: [Stage, string][] = [["progress", "In progress"], ["review", "In review"], ["ready", "Ready to merge"], ["waiting", "Waiting or blocked"], ["todo", "Sent back to do"]];
const SUGGESTIONS = ["Will we finish this sprint on time?", "Why did velocity change since the previous sprint?", "Who has the most work left?", "Which tickets are at risk?", "Where do tickets wait the longest?", "Write a short sprint review."];

const yes = (b: boolean) => (b ? "yes" : "no");
const branches = (n: number) => `${n} ${n === 1 ? "branch" : "branches"}`;
/** Stage colors: the validated series hues in their order, gray for time sent back to do; and the ink on each. */
const STAGE_FILL = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s-ctx)"];
const STAGE_KEY = ["s1", "s2", "s3", "s4", "ctx"];
const STAGE_INK = ["#fff", "#fff", "#fff", "#0b0b0b", "var(--fg)"];

/** "12 pts", "1 ticket", "40 h". */
function amount(v: number, u: Unit) {
  if (u === "tickets") return plural(Math.round(v), "ticket");
  if (u === "hours") return `${Math.round(v).toLocaleString("en-US")} h`;
  const n = r1(v);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "pt" : "pts"}`;
}
/** The bare number, for axes and marks. */
const num = (v: number, u: Unit) => (u === "points" ? r1(v) : Math.round(v)).toLocaleString("en-US");
const unitName = (u: Unit) => (u === "points" ? "pts" : u === "hours" ? "h" : "tickets");

/** A sprint's number, for tight labels: "MNC Sprint 24" → "S24". */
function short(s: SprintStat) {
  const words = s.name.trim().split(/\s+/);
  const n = words.find((w) => /^\d+$/.test(w));
  const last = words[words.length - 1] ?? s.name;
  return n ? `S${n}` : /\d/.test(last) ? last : s.name;
}

/** A running sprint not past its first working day: too soon to say how it goes. */
const early = (s: SprintStat) => s.state === "active" && s.workdaysDone <= 1;

/** How a sprint is going: its burn rate, where that rate takes it by the end, and the rate finishing needs. */
function pace(s: SprintStat, u: Unit) {
  const done = s.completed[u];
  const total = s.committed[u];
  const left = Math.max(0, s.workdays - s.workdaysDone);
  const rate = done / Math.max(1, s.workdaysDone);
  const projected = Math.min(total, done + rate * left);
  const need = left > 0 ? (total - done) / left : 0;
  const share = total > 0 ? (s.state === "closed" ? done : projected) / total : 1;
  // On track only when the pace finishes everything, so it never disagrees with the rate the burn rate tile asks for.
  const level: Level = share >= 0.995 ? "good" : share >= 0.85 ? "warn" : "bad";
  return { done, total, left, rate, projected, need, level };
}

function sprintRows(sprints: SprintStat[]): Cell[][] {
  return [
    ["Sprint", "State", "Start", "End", "Closed", "Committed tickets", "Committed points", "Committed hours", "Completed tickets", "Completed points", "Completed hours", "Completion % (tickets)", "Bugs fixed", "Bugs", "From earlier sprints (tickets)", "Added after the start (tickets)", "Estimate left over (h)", "Remaining estimate left over (h)"],
    ...sprints.map((x) => [x.name, x.state, x.start, x.end, x.complete, x.committed.tickets, r2(x.committed.points), r2(x.committed.hours), x.completed.tickets, r2(x.completed.points), r2(x.completed.hours), pct(x.completed.tickets, x.committed.tickets), x.bugsFixed, x.bugs, x.carried.tickets, x.added.tickets, r2(x.leftEstimate), r2(x.leftRemaining)]),
  ];
}

function ticketRows(sprints: SprintStat[]): Cell[][] {
  return [
    ["Sprint", "Key", "Title", "Type", "Assignee", "Status", "Completed in the sprint", "From an earlier sprint", "Added after the start", "Moved to a later sprint", "Points", "Estimate (h)", "Remaining (h)", "Started", "Done on", "Start to done (h)", "Open for (h)", "In progress (h)", "In review (h)", "Ready to merge (h)", "Waiting or blocked (h)", "Cancelled", "Commits", "Branches", "URL"],
    ...sprints.flatMap((x) =>
      x.tickets.map((t) => [
        x.name, t.key, t.title, t.kind, t.assignee, t.statusLabel, yes(t.completed), yes(t.carried), yes(t.added), yes(t.moved), t.points,
        t.estimate == null ? null : r2(t.estimate), t.remaining == null ? null : r2(t.remaining), t.startedAt?.slice(0, 10) ?? null, t.doneAt,
        t.cycleHours == null ? null : r2(t.cycleHours), t.ageHours == null ? null : r2(t.ageHours),
        r2(t.stages.progress ?? 0), r2(t.stages.review ?? 0), r2(t.stages.ready ?? 0), r2(t.stages.waiting ?? 0), yes(t.cancelled),
        t.code?.commits.length ?? 0, t.code?.branches.map((b) => b.name).join(" ") ?? "", t.url,
      ]),
    ),
  ];
}

/** The sprints of the Jira boards holding the chosen projects' tickets. `focus`: a ticket key to open, from the
 * Commits tab; `onDay` shows a day there; `onWeekly` switches to the weekly view. */
export function Sprints({ ids, lead, focus, onFocused, onDay, onWeekly }: { ids: string[]; lead: ReactNode; focus?: string | null; onFocused: () => void; onDay: (date: string) => void; onWeekly: () => void }) {
  const [count, setCount] = useStored("gnx.sprints.count", "6", (s) => (COUNTS.includes(s) ? s : "6"), String);
  const [boardId, setBoardId] = useStored("gnx.sprints.board", "", String, String);
  const [unitPref, setUnit] = useStored<Unit>("gnx.sprints.unit", "points", (s) => UNITS.find((u) => u.value === s)?.value ?? "points", String);
  const [pick, setPick] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [chat, setChat] = useState<Qa[]>([]);
  const [cell, setCell] = useState<{ name: string; sprint: SprintStat } | null>(null);
  const [opened, setOpened] = useState<{ key: string; sprint: number } | null>(null);
  const q = useSprints(ids, Number(count), true);
  const r = q.data;
  const board = r?.boards.find((b) => b.id === boardId) ?? r?.boards[0];
  const sprints = board?.sprints ?? [];
  const s = sprints.find((x) => x.id === pick) ?? [...sprints].reverse().find((x) => x.state === "active") ?? sprints.at(-1);
  const prev = s && sprints[sprints.indexOf(s) - 1];
  // A unit no ticket has falls back to tickets.
  const has = (u: Unit) => u === "tickets" || !r || (u === "points" ? r.points : r.hours);
  const unit: Unit = has(unitPref) ? unitPref : "tickets";
  const open = (key: string, sprint: number) => setOpened({ key, sprint });
  // How long 85% of the tickets finished in the sprints shown took: an open ticket past it is at risk.
  const p85 = rank(sprints.flatMap((x) => x.tickets.flatMap((t) => (t.completed && t.cycleHours != null ? [t.cycleHours] : []))).sort((a, b) => a - b), 0.85);

  // A key picked on the Commits tab: its latest sprint shown, and the ticket open.
  useEffect(() => {
    if (!focus || !r) return;
    const hit = r.boards.flatMap((b) => b.sprints.map((x) => ({ b, x }))).reverse().find(({ x }) => x.tickets.some((t) => t.key === focus));
    if (hit) {
      setBoardId(hit.b.id);
      setPick(hit.x.id);
      setOpened({ key: focus, sprint: hit.x.id });
    } else {
      toast(`${focus} is in none of the sprints shown`, "error");
    }
    onFocused();
  }, [focus, r]);

  const controls = (
    <div className="row wrap" style={{ margin: 0, gap: 12 }}>
      {lead}
      {r && r.boards.length > 1 && (
        <MenuChoice className="select menu-select" style={{ height: 32 }} label="Board" value={board?.id ?? ""} options={r.boards.map((b) => ({ value: b.id, label: b.name }))} onChange={(v) => { setBoardId(v); setPick(null); }} />
      )}
      {s && (
        <MenuChoice className="select menu-select" style={{ height: 32 }} label="Sprint" value={String(s.id)} options={[...sprints].reverse().map((x) => ({ value: String(x.id), label: `${x.name}${x.state === "active" ? " · active" : ""}` }))} onChange={(v) => setPick(Number(v))} />
      )}
      <Seg label="Count work in" value={unit} onChange={setUnit} options={UNITS.filter((u) => has(u.value))} />
      <MenuChoice className="select menu-select" style={{ height: 32 }} label="Sprints shown" value={count} options={COUNTS.map((c) => ({ value: c, label: `Last ${c} sprints` }))} onChange={(v) => { setCount(v); setPick(null); }} />
      <span className="grow" />
      {r && (
        <button className="btn btn-icon" aria-label="Sync now" data-tip={`Sync now · synced ${ago(r.syncedAt)}`} onClick={() => q.refetch()}>
          <Busy on={q.isFetching}><Icon name="refresh" size={13} /></Busy>
        </button>
      )}
      <button className="btn" disabled={!s} onClick={() => setAsking(true)}>
        <Icon name="sparkle" size={12} className="c-acc" />
        Ask AI
      </button>
      <button className="btn" disabled={!board} onClick={() => board && downloadCsv(`gitnetix-sprint-tickets-${slug(board.name)}.csv`, ticketRows(board.sprints))}>Export CSV</button>
    </div>
  );

  let body: ReactNode;
  if (q.isLoading) {
    body = <Loading />;
  } else if (!r) {
    body = (
      <div className="col" style={{ gap: 12, alignItems: "center" }}>
        <ErrorBox error={q.error} />
        <button className="btn" onClick={() => q.refetch()}><Busy on={q.isFetching}>Retry</Busy></button>
      </div>
    );
  } else if (!board || !s) {
    body = (
      <EmptyState icon="chart" title="No sprint found" action={<button className="btn btn-primary btn-md" onClick={onWeekly}>See tickets done per week</button>}>
        No Jira board holding these projects' tickets ran a sprint lately. Sprints come from Scrum boards in Jira Software; a Kanban team's work shows per week.
      </EmptyState>
    );
  } else {
    const shown = opened && sprints.find((x) => x.id === opened.sprint);
    const ticket = shown && shown.tickets.find((t) => t.key === opened.key);
    body = (
      <div className="col spr" style={{ gap: 16 }} data-busy={q.isPlaceholderData ? "" : undefined}>
        {r.errors.length > 0 && (
          <div className="spr-note"><Icon name="alert" size={13} className="c-warn" />Some Jira sites did not answer: {r.errors.join(" · ")}</div>
        )}
        {q.error && (
          <div className="spr-note"><Icon name="alert" size={13} className="c-warn" />Showing the data from {ago(r.syncedAt)}: {q.error.message}</div>
        )}
        <Hero s={s} u={unit} />
        <Kpis s={s} prev={prev} sprints={sprints} u={unit} />
        <div className="spr-grid2">
          <Burndown s={s} u={unit} />
          <Makeup s={s} u={unit} points={r.points} />
        </div>
        <div className="spr-grid-even">
          <Velocity sprints={sprints} sel={s.id} onPick={setPick} u={unit} />
          <Leftover sprints={sprints} sel={s} onPick={setPick} hasHours={r.hours} onOpen={open} />
        </div>
        <Cycle board={board} s={s} p85={p85} onOpen={open} />
        <People sprints={sprints} sel={s.id} u={unit} onCell={(name, sprint) => setCell({ name, sprint })} />
        <Tickets s={s} u={unit} p85={p85} onOpen={open} />
        {asking && (
          <Ask
            title={`Ask about ${s.name}`}
            sub={`Answers come from the ${board.name} sprints on screen`}
            intro="Ask anything about these sprints, or start with one of these:"
            suggestions={SUGGESTIONS}
            chat={chat}
            setChat={setChat}
            onClose={() => setAsking(false)}
            data={() => {
              // Days and tickets of the sprint on screen and the one before: the others' totals answer the rest.
              const i = board.sprints.indexOf(s);
              const keep = new Set([s.id, board.sprints[i - 1]?.id]);
              const list = board.sprints.map((x) => (keep.has(x.id) ? x : { ...x, burndown: undefined, tickets: undefined }));
              return JSON.stringify({ unit, board: board.name, selected: s.name, sprints: list });
            }}
          />
        )}
        {cell && <PersonSprint name={cell.name} s={cell.sprint} u={unit} onClose={() => setCell(null)} onOpen={open} />}
        {shown && ticket && <TicketModal t={ticket} s={shown} onClose={() => setOpened(null)} onDay={onDay} />}
      </div>
    );
  }
  return (
    <>
      {controls}
      {body}
    </>
  );
}

function Meter({ label, value, detail, kind }: { label: string; value: number; detail: string; kind: "time" | "work" }) {
  return (
    <div className="spr-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${value}%, ${detail}`}>
      <div className="row" style={{ margin: 0, gap: 8 }}>
        <span className="muted grow">{label}</span>
        <strong>{value}%</strong>
        <span className="faint">{detail}</span>
      </div>
      <span className={`spr-track ${kind}`}>
        <span style={{ width: `${Math.min(100, value)}%` }} />
      </span>
    </div>
  );
}

/** The sprint on screen: dates, goal, time gone against work done, and where its pace leads. */
function Hero({ s, u }: { s: SprintStat; u: Unit }) {
  const p = pace(s, u);
  const running = s.state === "active";
  const word = (running ? { good: "On track", warn: "At risk", bad: "Behind" } : { good: "Completed", warn: "Mostly done", bad: "Fell short" })[p.level];
  const left = p.total - p.done;
  const moved = s.tickets.filter((t) => t.moved).length;
  // Not past its first working day yet: no pace to read.
  const waiting = early(s);
  const planned = `${amount(p.total, u)} planned${u !== "hours" && s.committed.hours > 0 ? ` and ${amount(s.committed.hours, "hours")} estimated` : ""}`;
  const text = waiting
    ? s.workdaysDone === 0
      ? `Starts ${weekday(s.start)} with ${planned}.`
      : `First working day, with ${planned}${p.done > 0 ? ` and ${amount(p.done, u)} done already` : ""}.`
    : running
    ? p.left > 0
      ? `At ${num(p.rate, u)} ${unitName(u)} a working day, about ${amount(p.projected, u)} of ${amount(p.total, u)} will be done by ${weekday(s.end)}.${p.need > p.rate + 1e-9 ? ` Finishing everything takes ${num(p.need, u)} a day.` : ""}`
      : `Last working day, with ${amount(left, u)} still to do.`
    : `${pct(p.done, p.total)}% of the committed work was completed${left > 0 ? `, ${amount(left, u)} left over` : ""}${moved ? `, and ${plural(moved, "ticket")} moved on to a later sprint` : ""}.`;
  return (
    <section className="card spr-hero" aria-label="Sprint">
      <div className="row wrap" style={{ alignItems: "flex-start", gap: 16, margin: 0 }}>
        <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
          <div className="row" style={{ gap: 10, margin: 0 }}>
            <h2 className="spr-title">{s.name}</h2>
            <span className={`tag${running ? " accent" : ""}`}>{running ? "Active" : "Closed"}</span>
          </div>
          <span className="muted">
            {day(s.start)} – {day(s.complete ?? s.end)} · {running && s.workdaysDone > 0 ? `working day ${Math.min(s.workdaysDone, s.workdays)} of ${s.workdays}` : plural(s.workdays, "working day")}
          </span>
          {s.goal && (
            <span className="spr-goal">
              <Icon name="flag" size={12} />
              {s.goal}
            </span>
          )}
        </div>
        {waiting ? <span className="spr-level">{s.workdaysDone === 0 ? `Starts ${weekday(s.start)}` : "First working day"}</span> : <LevelChip level={p.level} label={word} />}
      </div>
      <div className="spr-meters">
        <Meter label="Time gone" value={pct(s.workdaysDone, s.workdays)} detail={`${s.workdaysDone} of ${plural(s.workdays, "working day")}`} kind="time" />
        <Meter label="Work done" value={pct(p.done, p.total)} detail={`${amount(p.done, u)} of ${amount(p.total, u)}`} kind="work" />
      </div>
      <p className="spr-say">{text}</p>
    </section>
  );
}

function Spark({ values, at }: { values: number[]; at: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1e-9, ...values);
  const pts = values.map((v, i): Pt => [2 + (i / (values.length - 1)) * 76, 21 - (v / max) * 17]);
  return (
    <svg className="spr-spark" width={64} height={20} viewBox="0 0 80 24" aria-hidden>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} />
      <circle cx={pts[at][0]} cy={pts[at][1]} r={3.5} />
    </svg>
  );
}

interface Delta {
  text: string;
  /** Up, down, or none. */
  dir: number;
  /** Whether the change is good news; undefined when neither. */
  good?: boolean;
}

/** The sprint's figures, each against the sprint before when that comparison is fair. */
function Kpis({ s, prev, sprints, u }: { s: SprintStat; prev?: SprintStat; sprints: SprintStat[]; u: Unit }) {
  const closed = sprints.filter((x) => x.state === "closed");
  const avg = closed.length ? closed.reduce((a, x) => a + x.completed[u], 0) / closed.length : 0;
  const p = pace(s, u);
  const running = s.state === "active";
  const vs = prev ? ` vs ${short(prev)}` : "";
  // A running sprint is still filling up: shown next to the last one's total, not as a change from it.
  const change = (now: number, before: number, fmt: (v: number) => string, upGood = true): Delta => {
    const d = now - before;
    if (running) return { text: `${fmt(before)} in ${short(prev!)}`, dir: 0 };
    if (Math.abs(d) < 0.05) return { text: `Same${vs}`, dir: 0 };
    return { text: `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${vs}`, dir: Math.sign(d), good: d > 0 === upGood };
  };
  const notDone = s.tickets.filter((t) => !t.completed && !t.cancelled).length;
  const tiles: { label: string; value: string; delta: Delta; spark?: boolean }[] = [
    { label: running ? "Velocity so far" : "Velocity", value: amount(s.completed[u], u), delta: prev ? change(s.completed[u], prev.completed[u], (v) => amount(v, u)) : { text: "No earlier sprint shown", dir: 0 }, spark: true },
    { label: "Average velocity", value: amount(avg, u), delta: { text: closed.length ? `Over ${plural(closed.length, "closed sprint")}` : "No closed sprint yet", dir: 0 } },
    {
      label: "Burn rate",
      value: `${num(p.rate, u)} ${unitName(u)}/day`,
      delta: early(s) ? { text: `${num(s.committed[u] / Math.max(1, s.workdays), u)}/day to finish on time`, dir: 0 } : running && p.left > 0 ? { text: `${num(p.need, u)}/day needed to finish`, dir: 0, good: p.rate + 1e-9 >= p.need } : { text: "Per working day", dir: 0 },
    },
    { label: "Bugs fixed", value: String(s.bugsFixed), delta: prev ? change(s.bugsFixed, prev.bugsFixed, String) : { text: `Of ${plural(s.bugs, "bug")} in the sprint`, dir: 0 } },
    {
      label: running ? "Completion so far" : "Completion",
      value: `${pct(s.completed[u], s.committed[u])}%`,
      delta: prev ? change(pct(s.completed[u], s.committed[u]), pct(prev.completed[u], prev.committed[u]), (v) => `${Math.round(v)}%`) : { text: `${amount(s.completed[u], u)} of ${amount(s.committed[u], u)}`, dir: 0 },
    },
    { label: "Estimate left over", value: `${Math.round(s.leftEstimate).toLocaleString("en-US")} h`, delta: { text: `${Math.round(s.leftRemaining)} h remaining on ${plural(notDone, "open ticket")}`, dir: 0 } },
  ];
  return (
    <section aria-label="Key figures" className="kpis spr-kpis">
      {tiles.map((t) => (
        <div key={t.label} className="kpi">
          <div className="row" style={{ margin: 0, gap: 8 }}>
            <span className="muted grow" style={{ fontSize: 12 }}>{t.label}</span>
            {t.spark && <Spark values={sprints.map((x) => x.completed[u])} at={sprints.indexOf(s)} />}
          </div>
          <span className="v">{t.value}</span>
          <span className={`spr-delta ${t.delta.good === undefined ? "faint" : t.delta.good ? "c-add" : "c-del"}`}>
            {t.delta.dir !== 0 && <Icon name={t.delta.dir > 0 ? "chevronUp" : "chevronDown"} size={11} />}
            {t.delta.good === false && t.delta.dir === 0 && <Icon name="alert" size={11} />}
            {t.delta.text}
          </span>
        </div>
      ))}
    </section>
  );
}

/** Work left at the end of each day against the ideal line, with the stretch behind it shaded and the pace carried on to the end. */
function Burndown({ s, u }: { s: SprintStat; u: Unit }) {
  const [hi, setHi] = useState(-1);
  const days = s.burndown;
  const n = Math.max(1, days.length);
  const start = s.scopeStart[u];
  const seen = days.filter((d) => d.remaining);
  const now = seen.length - 1;
  const running = s.state === "active";
  const max = niceMax(Math.max(1e-9, start, ...days.map((d) => Math.max(d.remaining?.[u] ?? 0, d.scope?.[u] ?? 0, d.ideal[u]))));
  const X = (i: number) => ((i + 1) / n) * 100;
  const Y = (v: number) => 100 - (v / max) * 100;
  // A past day's point is its end; today's is what is done so far, so it sits at today's start, where the ideal line also starts the day.
  const XP = (i: number) => (running && i === seen.length - 1 ? (i / n) * 100 : X(i));
  const idealAt = (i: number) => (running && i === seen.length - 1 ? (i === 0 ? start : days[i - 1].ideal[u]) : days[i].ideal[u]);
  const actual: Pt[] = [[0, Y(start)], ...seen.map((d, i): Pt => [XP(i), Y(d.remaining![u])])];
  const ideal: Pt[] = [[0, Y(start)], ...days.map((d, i): Pt => [X(i), Y(d.ideal[u])])];
  const scope: Pt[] = [[0, Y(start)], ...seen.map((d, i): Pt => [X(i), Y(d.scope![u])])];
  const scopeMoved = seen.some((d) => Math.abs(d.scope![u] - start) > 1e-9);
  const p = pace(s, u);
  const last = now >= 0 ? seen[now].remaining![u] : start;
  const forecast: Pt[] | null = running && now >= 0 && now < days.length - 1 && !early(s) ? [[XP(now), Y(last)], [X(days.length - 1), Y(Math.max(0, last - p.rate * p.left))]] : null;
  const gapAt = (i: number) => (days[i].remaining ? days[i].remaining![u] - idealAt(i) : 0);
  const behind = seen.some((_, i) => gapAt(i) > 1e-9);
  const nowGap = now >= 0 ? gapAt(now) : 0;
  const titles = new Map(s.tickets.map((t) => [t.key, t.title]));
  // First and last day, and evenly spaced ones between that keep clear of the last.
  const step = Math.max(1, Math.ceil((days.length - 1) / 6));
  const marks = [...Array.from({ length: days.length }, (_, i) => i).filter((i) => i % step === 0 && i < days.length - 1 - step / 2), days.length - 1].filter((i) => i >= 0);
  const h = hi >= 0 ? days[hi] : null;
  const area = `${path(actual)}L${actual[actual.length - 1][0].toFixed(2)},100L0,100Z`;
  const rows: Cell[][] = [
    ["Date", `Work left (${unitName(u)})`, `Ideal (${unitName(u)})`, `Scope (${unitName(u)})`, "Completed that day"],
    ...days.map((d) => [d.date, d.remaining ? r2(d.remaining[u]) : null, r2(d.ideal[u]), d.scope ? r2(d.scope[u]) : null, d.done.join(" ")]),
  ];
  const status = now < 0 || early(s) ? null : nowGap > 0.05 ? <LevelChip level="warn" label={`${amount(nowGap, u)} behind`} /> : <LevelChip level="good" label={nowGap < -0.05 ? `${amount(-nowGap, u)} ahead` : "On the line"} />;
  return (
    <Card title="Burndown" hint="Work left at the end of each day, against an even burn over the working days" rows={rows} file={`gitnetix-burndown-${slug(s.name)}.csv`} right={status}>
      <div className="spr-legend">
        <Key kind="line" label="Work left" />
        <Key kind="ideal" label="Ideal" />
        {forecast && <Key kind="forecast" label="At this pace" />}
        {scopeMoved && <Key kind="scope" label="Scope" />}
        {behind && <Key kind="behind" label="Behind the ideal" />}
      </div>
      <div className="chart spr-chart tall" role="group" aria-label={`Burndown of ${s.name}: ${amount(last, u)} left of ${amount(start, u)}${behind ? ", behind the ideal line at times" : ""}.`}>
        <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{num(t.v, u)}</span>)}</div>
        <div className="chart-plot spr-plot" onMouseLeave={() => setHi(-1)}>
          {ticks(max).map((t) => <div key={t.top} className="spr-grid" style={{ top: `${t.top}%` }} />)}
          <svg className="spr-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <defs>
              <clipPath id={`spr-above-${s.id}`}>
                <path d={`${path(ideal)}L100,0L0,0Z`} />
              </clipPath>
            </defs>
            {days.map((d, i) => d.weekend && <rect key={d.date} className="spr-weekend" x={(i / n) * 100} y={0} width={100 / n} height={100} />)}
            <path className="spr-area" d={area} />
            <path className="spr-behind" d={area} clipPath={`url(#spr-above-${s.id})`} />
            {scopeMoved && <path className="spr-scope" d={path(scope)} />}
            <path className="spr-ideal" d={path(ideal)} />
            {forecast && <path className="spr-forecast" d={path(forecast)} />}
            <path className="spr-line" d={path(actual)} />
          </svg>
          {running && s.workdaysDone > 0 && now >= 0 && now < days.length - 1 && (
            <div className="spr-today" style={{ left: `${XP(now)}%` }}>
              <span>Today</span>
            </div>
          )}
          {now >= 0 && hi < 0 && <span className="spr-dot" style={{ left: `${XP(now)}%`, top: `${Y(last)}%` }} />}
          {h && (
            <>
              <div className="spr-cross" style={{ left: `${h.remaining ? XP(hi) : X(hi)}%` }} />
              <span className="spr-dot ideal" style={{ left: `${h.remaining ? XP(hi) : X(hi)}%`, top: `${Y(h.remaining ? idealAt(hi) : h.ideal[u])}%` }} />
              {h.remaining && <span className="spr-dot" style={{ left: `${XP(hi)}%`, top: `${Y(h.remaining[u])}%` }} />}
            </>
          )}
          {days.map((d, i) => (
            <button
              key={d.date}
              className="spr-hit"
              style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }}
              aria-label={`${weekday(d.date)}: ${d.remaining ? `${amount(d.remaining[u], u)} left` : "still to come"}, ideal ${amount(d.ideal[u], u)}`}
              onMouseEnter={() => setHi(i)}
              onFocus={() => setHi(i)}
              onBlur={() => setHi(-1)}
            />
          ))}
          {h && (
            <div className="chart-tip" style={tipAt(hi, n)}>
              <strong>{running && hi === now ? `Today so far, ${weekday(h.date)}` : weekday(h.date)}{h.weekend ? " · weekend" : ""}</strong>
              {h.remaining && <TipRow kind="line" value={amount(h.remaining[u], u)} label="left" />}
              <TipRow kind="ideal" value={amount(h.remaining ? idealAt(hi) : h.ideal[u], u)} label={running && hi === now ? "ideal at the start of today" : "ideal"} />
              {h.remaining &&
                (gapAt(hi) > 0.05 ? (
                  <span className="row c-warn" style={{ gap: 6, margin: 0 }}><Icon name="alert" size={11} />Behind the ideal by {amount(gapAt(hi), u)}</span>
                ) : gapAt(hi) < -0.05 ? (
                  <span className="row c-add" style={{ gap: 6, margin: 0 }}><Icon name="check" size={11} />Ahead of the ideal by {amount(-gapAt(hi), u)}</span>
                ) : (
                  <span className="faint">On the ideal line</span>
                ))}
              {!h.remaining && <span className="faint">Still to come</span>}
              {h.done.length > 0 && (
                <div className="col" style={{ gap: 3 }}>
                  <span className="muted">Completed that day</span>
                  {h.done.slice(0, 4).map((k) => (
                    <span key={k} className="ellipsis" style={{ fontSize: 11 }}>
                      <span className="mono">{k}</span> <span className="muted">{titles.get(k)}</span>
                    </span>
                  ))}
                  {h.done.length > 4 && <span className="faint">+ {h.done.length - 4} more</span>}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="chart-x">
          {marks.map((i, j) => (
            <span key={i} style={{ left: `${((i + 0.5) / n) * 100}%`, transform: `translateX(${j === 0 ? "-20%" : j === marks.length - 1 ? "-80%" : "-50%"})` }}>{day(days[i].date)}</span>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Committed and completed work per sprint around the average, and the bugs fixed in each below. */
function Velocity({ sprints, sel, onPick, u }: { sprints: SprintStat[]; sel: number; onPick: (id: number) => void; u: Unit }) {
  const [hi, setHi] = useState(-1);
  const n = sprints.length;
  const closed = sprints.filter((x) => x.state === "closed");
  const avg = closed.length ? closed.reduce((a, x) => a + x.completed[u], 0) / closed.length : null;
  const max = niceMax(Math.max(1e-9, ...sprints.map((x) => Math.max(x.committed[u], x.completed[u]))));
  const bugMax = Math.max(1, ...sprints.map((x) => x.bugsFixed));
  const byDone = [...closed].sort((a, b) => b.completed[u] - a.completed[u]);
  const [best, low] = [byDone[0], byDone.at(-1)];
  const h = hi >= 0 ? sprints[hi] : null;
  const hover = (i: number) => ({ onMouseEnter: () => setHi(i), onFocus: () => setHi(i), onBlur: () => setHi(-1) });
  return (
    <Card title="Velocity and bugs fixed" hint="Work completed per sprint against the work committed. Pick a sprint to look at it." rows={sprintRows(sprints)} file="gitnetix-velocity.csv">
      <div className="spr-legend">
        <Key kind="ctx" label="Committed" />
        <Key kind="s1" label="Completed" />
        {avg != null && <Key kind="avg" label={`Average ${amount(avg, u)}`} />}
        <Key kind="s3" label="Bugs fixed" />
      </div>
      <div className="chart spr-chart tall">
        <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{num(t.v, u)}</span>)}</div>
        <div className="chart-plot spr-plot spr-bars" onMouseLeave={() => setHi(-1)}>
          {ticks(max).map((t) => <div key={t.top} className="spr-grid" style={{ top: `${t.top}%` }} />)}
          {avg != null && <div className="spr-avg" style={{ bottom: `${(avg / max) * 100}%` }} />}
          {sprints.map((x, i) => {
            const low = avg != null && x.state === "closed" && x.completed[u] < avg * 0.8;
            return (
              <button key={x.id} className={`spr-slot${x.id === sel ? " sel" : ""}${hi >= 0 && hi !== i ? " dim" : ""}`} aria-pressed={x.id === sel} aria-label={`${x.name}: ${amount(x.completed[u], u)} completed of ${amount(x.committed[u], u)}, ${plural(x.bugsFixed, "bug")} fixed`} onClick={() => onPick(x.id)} {...hover(i)}>
                <span className="spr-bar ctx" style={{ height: `${(x.committed[u] / max) * 100}%` }} />
                <span className={`spr-bar s1${x.state === "active" ? " running" : ""}`} style={{ height: `${(x.completed[u] / max) * 100}%` }}>
                  {low && <span className="spr-flag"><Icon name="alert" size={11} /></span>}
                </span>
              </button>
            );
          })}
          {h && (
            <div className="chart-tip" style={tipAt(hi, n)}>
              <div className="row" style={{ margin: 0 }}>
                <strong className="grow">{h.name}</strong>
                <span className="faint">{day(h.start)} – {day(h.complete ?? h.end)}</span>
              </div>
              <TipRow kind="s1" value={amount(h.completed[u], u)} label={h.state === "active" ? "completed so far" : "completed"} />
              <TipRow kind="ctx" value={amount(h.committed[u], u)} label={`committed · ${pct(h.completed[u], h.committed[u])}% done`} />
              <TipRow kind="s3" value={String(h.bugsFixed)} label={`of ${plural(h.bugs, "bug")} fixed`} />
              {avg != null && h.state === "closed" && (
                <span className={`row ${h.completed[u] < avg * 0.8 ? "c-warn" : "muted"}`} style={{ gap: 6, margin: 0 }}>
                  {h.completed[u] < avg * 0.8 && <Icon name="alert" size={11} />}
                  {Math.abs(h.completed[u] - avg) < 0.05 ? "On the average" : `${pct(Math.abs(h.completed[u] - avg), avg)}% ${h.completed[u] > avg ? "above" : "below"} the average`}
                </span>
              )}
              {h.carried.tickets > 0 && <span className="faint">{plural(h.carried.tickets, "ticket")} from an earlier sprint</span>}
              {h.added.tickets > 0 && <span className="faint">{plural(h.added.tickets, "ticket")} added after the start</span>}
            </div>
          )}
        </div>
        <span className="spr-mini-y">Bugs</span>
        <div className="spr-mini" onMouseLeave={() => setHi(-1)}>
          {sprints.map((x, i) => (
            <div key={x.id} className={`spr-mini-slot${hi >= 0 && hi !== i ? " dim" : ""}`} onMouseEnter={() => setHi(i)}>
              <span className="spr-mini-v">{x.bugsFixed}</span>
              <span className="spr-bar s3" style={{ height: `calc((100% - 16px) * ${x.bugsFixed / bugMax})` }} />
            </div>
          ))}
        </div>
        <div className="spr-xl">{sprints.map((x) => <span key={x.id} className={x.id === sel ? "sel" : undefined} title={x.name}>{short(x)}</span>)}</div>
      </div>
      {best && low && (
        <dl className="spr-facts three">
          <div>
            <dt><Icon name="chevronUp" size={11} />Best sprint</dt>
            <dd>{short(best)} · {amount(best.completed[u], u)}</dd>
          </div>
          <div>
            <dt><Icon name="chevronDown" size={11} />Lowest sprint</dt>
            <dd>{short(low)} · {amount(low.completed[u], u)}</dd>
          </div>
          <div>
            <dt><Icon name="check" size={11} />Average completion</dt>
            <dd>{pct(closed.reduce((a, x) => a + x.completed[u], 0), closed.reduce((a, x) => a + x.committed[u], 0))}% of the committed work</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

/** Estimated hours of the tickets not completed in each sprint, and the biggest of them in the sprint on screen. */
function Leftover({ sprints, sel, onPick, hasHours, onOpen }: { sprints: SprintStat[]; sel: SprintStat; onPick: (id: number) => void; hasHours: boolean; onOpen: (key: string, sprint: number) => void }) {
  const [hi, setHi] = useState(-1);
  const n = sprints.length;
  const max = niceMax(Math.max(1e-9, ...sprints.map((x) => Math.max(x.leftEstimate, x.leftRemaining))));
  const avg = sprints.reduce((a, x) => a + x.leftEstimate, 0) / Math.max(1, n);
  const open = sel.tickets.filter((t) => !t.completed && !t.cancelled).sort((a, b) => (b.estimate ?? 0) - (a.estimate ?? 0));
  const h = hi >= 0 ? sprints[hi] : null;
  const rows: Cell[][] = [
    ["Sprint", "Tickets not completed", "Estimate left over (h)", "Remaining estimate now (h)", "Moved to a later sprint"],
    ...sprints.map((x) => [x.name, x.tickets.filter((t) => !t.completed && !t.cancelled).length, r2(x.leftEstimate), r2(x.leftRemaining), x.tickets.filter((t) => t.moved).length]),
  ];
  return (
    <Card title="Estimated hours left over" hint="Original estimate of the tickets each sprint did not complete, and what remains of it today" rows={rows} file="gitnetix-hours-left-over.csv">
      {!hasHours ? (
        <Empty>No ticket in these sprints has an original estimate. Fill in Jira's time tracking to see the hours left over here.</Empty>
      ) : (
        <>
          <div className="spr-legend">
            <Key kind="s2" label="Estimate left over" />
            <Key kind="s2 soft" label="Remaining now" />
          </div>
          <div className="chart spr-chart">
            <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{num(t.v, "hours")}</span>)}</div>
            <div className="chart-plot spr-plot spr-bars" onMouseLeave={() => setHi(-1)}>
              {ticks(max).map((t) => <div key={t.top} className="spr-grid" style={{ top: `${t.top}%` }} />)}
              {sprints.map((x, i) => (
                <button key={x.id} className={`spr-slot${x.id === sel.id ? " sel" : ""}${hi >= 0 && hi !== i ? " dim" : ""}`} aria-pressed={x.id === sel.id} aria-label={`${x.name}: ${Math.round(x.leftEstimate)} h estimated and ${Math.round(x.leftRemaining)} h remaining on the tickets not completed`} onClick={() => onPick(x.id)} onMouseEnter={() => setHi(i)} onFocus={() => setHi(i)} onBlur={() => setHi(-1)}>
                  <span className="spr-bar s2" style={{ height: `${(x.leftEstimate / max) * 100}%` }}>
                    {n > 1 && x.leftEstimate > avg * 1.5 && <span className="spr-flag"><Icon name="alert" size={11} /></span>}
                  </span>
                  <span className="spr-bar s2 soft" style={{ height: `${(x.leftRemaining / max) * 100}%` }} />
                </button>
              ))}
              {h && (
                <div className="chart-tip" style={tipAt(hi, n)}>
                  <strong>{h.name}</strong>
                  <TipRow kind="s2" value={`${r1(h.leftEstimate)} h`} label="estimated, not completed" />
                  <TipRow kind="s2 soft" value={`${r1(h.leftRemaining)} h`} label="remaining on them now" />
                  <span className="muted">{plural(h.tickets.filter((t) => !t.completed && !t.cancelled).length, "ticket")} not completed{h.state === "closed" ? `, ${h.tickets.filter((t) => t.moved).length} moved on` : ""}</span>
                  {n > 1 && h.leftEstimate > avg * 1.5 && <span className="row c-warn" style={{ gap: 6, margin: 0 }}><Icon name="alert" size={11} />{pct(h.leftEstimate - avg, avg)}% more than the average</span>}
                </div>
              )}
            </div>
            <div className="spr-xl">{sprints.map((x) => <span key={x.id} className={x.id === sel.id ? "sel" : undefined} title={x.name}>{short(x)}</span>)}</div>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <span className="muted spr-label">Biggest open estimates in {short(sel)}</span>
            {open.length === 0 && <span className="faint">Every ticket was completed.</span>}
            {open.slice(0, 4).map((t) => (
              <div key={t.key} className="spr-left-row">
                <button className="spr-keylink" onClick={() => onOpen(t.key, sel.id)} data-tip="See the ticket">{t.key}</button>
                <span className="ellipsis grow" title={t.title}>{t.title}</span>
                <Avatar name={t.assignee} size={18} />
                <span className="mono faint">{t.estimate == null ? "no estimate" : `${r1(t.estimate)} h`}{t.remaining != null && t.estimate != null ? ` · ${r1(t.remaining)} h left` : ""}</span>
              </div>
            ))}
            {open.length > 4 && <span className="faint">+ {open.length - 4} more in the ticket list below</span>}
          </div>
        </>
      )}
    </Card>
  );
}

/** What each person completed of the work assigned to them, sprint by sprint: darker is more complete. */
function People({ sprints, sel, u, onCell }: { sprints: SprintStat[]; sel: number; u: Unit; onCell: (name: string, s: SprintStat) => void }) {
  const [hi, setHi] = useState<{ name: string; s: SprintStat; box: DOMRect } | null>(null);
  const totals = new Map<string, { done: number; total: number; tickets: number }>();
  for (const x of sprints) {
    for (const p of x.people) {
      const t = totals.get(p.name) ?? { done: 0, total: 0, tickets: 0 };
      t.done += p.completed[u];
      t.total += p.committed[u];
      t.tickets += p.committed.tickets;
      totals.set(p.name, t);
    }
  }
  const order = [...totals].sort((a, b) => b[1].done - a[1].done || b[1].tickets - a[1].tickets || a[0].localeCompare(b[0]));
  const rows: Cell[][] = [
    ["Person", "Sprint", "Committed tickets", "Completed tickets", "Committed points", "Completed points", "Committed hours", "Completed hours", `Completion % (${unitName(u)})`, "Bugs fixed", "Remaining hours not completed"],
    ...order.flatMap(([name]) =>
      sprints.flatMap((x) => {
        const p = x.people.find((y) => y.name === name);
        return p ? [[name, x.name, p.committed.tickets, p.completed.tickets, r2(p.committed.points), r2(p.completed.points), r2(p.committed.hours), r2(p.completed.hours), pct(p.completed[u], p.committed[u]), p.bugsFixed, r2(p.leftHours)]] : [];
      }),
    ),
  ];
  const ratio = (p: SprintStat["people"][number]) => (p.committed[u] > 0 ? p.completed[u] / p.committed[u] : p.completed.tickets / Math.max(1, p.committed.tickets));
  const hp = hi && hi.s.people.find((p) => p.name === hi.name);
  return (
    <Card title="Ticket completion by sprint and person" hint={`Completed of committed, in ${unitName(u)}. Pick a cell to see the tickets.`} rows={rows} file="gitnetix-completion-by-person.csv" table={false}>
      <div className="spr-heat-wrap">
        <table className="spr-heat">
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: "left" }}>Person</th>
              {sprints.map((x) => <th key={x.id} scope="col" className={x.id === sel ? "sel" : undefined} title={x.name}>{short(x)}</th>)}
              <th scope="col" className="spr-total">All shown</th>
            </tr>
          </thead>
          <tbody>
            {order.map(([name, t]) => (
              <tr key={name}>
                <th scope="row">
                  <span className="row" style={{ gap: 8, margin: 0 }}>
                    <Avatar name={name} size={20} />
                    <span className="ellipsis">{name}</span>
                  </span>
                </th>
                {sprints.map((x) => {
                  const p = x.people.find((y) => y.name === name);
                  if (!p) return <td key={x.id} className="spr-none">–</td>;
                  return (
                    <td key={x.id}>
                      <button
                        className="spr-cell"
                        style={heat(ratio(p))}
                        aria-label={`${name}, ${x.name}: ${amount(p.completed[u], u)} completed of ${amount(p.committed[u], u)}`}
                        onClick={() => onCell(name, x)}
                        onMouseEnter={(e) => setHi({ name, s: x, box: e.currentTarget.getBoundingClientRect() })}
                        onMouseLeave={() => setHi(null)}
                        onFocus={(e) => setHi({ name, s: x, box: e.currentTarget.getBoundingClientRect() })}
                        onBlur={() => setHi(null)}
                      >
                        <span>
                          <strong>{num(p.completed[u], u)}</strong>
                          <small>/{num(p.committed[u], u)}</small>
                        </span>
                      </button>
                    </td>
                  );
                })}
                <td className="spr-total">
                  <strong>{pct(t.done, t.total)}%</strong>
                  <span className="faint"> · {num(t.done, u)}/{num(t.total, u)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="spr-scale" aria-hidden>
        <span className="faint">0%</span>
        <span className="spr-ramp" />
        <span className="faint">100% of the committed work completed</span>
      </div>
      {hi && hp && (
        <div className="chart-tip spr-float" style={{ top: hi.box.bottom + 6, left: Math.min(window.innerWidth - 252, Math.max(12, hi.box.left + hi.box.width / 2 - 120)) }}>
          <div className="row" style={{ margin: 0 }}>
            <strong className="grow">{hi.name}</strong>
            <span className="faint">{short(hi.s)}</span>
          </div>
          <TipRow kind="s1" value={`${pct(hp.completed[u], hp.committed[u])}%`} label={`${amount(hp.completed[u], u)} of ${amount(hp.committed[u], u)}`} />
          <span className="muted">{hp.completed.tickets} of {plural(hp.committed.tickets, "ticket")} completed{hp.bugsFixed ? `, ${plural(hp.bugsFixed, "bug")} fixed` : ""}</span>
          {hp.leftHours > 0 && <span className="muted">{r1(hp.leftHours)} h remaining on the rest</span>}
          {ratio(hp) < 0.5 && hi.s.state === "closed" && <span className="row c-warn" style={{ gap: 6, margin: 0 }}><Icon name="alert" size={11} />Less than half completed</span>}
        </div>
      )}
    </Card>
  );
}

/** The tickets of one person in one sprint. */
function PersonSprint({ name, s, u, onClose, onOpen }: { name: string; s: SprintStat; u: Unit; onClose: () => void; onOpen: (key: string, sprint: number) => void }) {
  const list = s.tickets.filter((t) => t.assignee === name).sort((a, b) => Number(b.completed) - Number(a.completed));
  const p = s.people.find((x) => x.name === name);
  return (
    <Modal title={<span className="row" style={{ gap: 10, margin: 0 }}><Avatar name={name} size={24} />{name}</span>} sub={`${s.name} · ${p ? `${amount(p.completed[u], u)} completed of ${amount(p.committed[u], u)}` : ""}`} onClose={onClose} width={680}>
      <TicketList list={list} u={u} onOpen={(key) => { onClose(); onOpen(key, s.id); }} />
    </Modal>
  );
}

function TicketList({ list, u, onOpen }: { list: SprintTicket[]; u: Unit; onOpen: (key: string) => void }) {
  if (!list.length) return <Empty>No ticket here.</Empty>;
  return (
    <div className="col" style={{ gap: 2 }}>
      {list.map((t) => (
        <div key={t.key} className="spr-left-row">
          <span className={`spr-state ${t.completed ? "done" : ""}`} aria-label={t.completed ? "Completed" : "Not completed"}>{t.completed ? <Icon name="check" size={11} /> : null}</span>
          <button className="spr-keylink" onClick={() => onOpen(t.key)} data-tip="See the ticket">{t.key}</button>
          <span className="ellipsis grow" title={t.title}>{t.title}</span>
          <span className="faint">{t.statusLabel}</span>
          <span className="mono faint">{u === "hours" ? (t.estimate == null ? "–" : `${r1(t.estimate)} h`) : u === "points" ? (t.points == null ? "–" : `${t.points} pts`) : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Where the sprint's tickets stand, what kinds they are, and what makes its numbers less sure. */
function Makeup({ s, u, points }: { s: SprintStat; u: Unit; points: boolean }) {
  const total = s.committed.tickets;
  const parts = STATUS.map(([k, label], i) => ({ k, label, n: s.status[k] ?? 0, fill: STATUS_FILL[i], light: i > 1 })).filter((x) => x.n > 0);
  const kmax = Math.max(1e-9, ...s.kinds.map((k) => k.committed[u]));
  const moved = s.tickets.filter((t) => t.moved).length;
  const facts: [string, string, string][] = [
    ["swap", "From earlier sprints", amount(s.carried[u], u)],
    ["plus", "Added after the start", amount(s.added[u], u)],
    ...(s.state === "closed" ? ([["chevronRight", "Moved on after it", plural(moved, "ticket")]] as [string, string, string][]) : []),
    ...(s.cancelled ? ([["close", "Cancelled, left out", plural(s.cancelled, "ticket")]] as [string, string, string][]) : []),
    ["user", "Unassigned", plural(s.unassigned, "ticket")],
    ...(points ? ([["ticket", "No story points", plural(s.noPoints, "ticket")]] as [string, string, string][]) : []),
    ["edit", "No estimate", plural(s.noEstimate, "ticket")],
  ];
  // What the code says, when the chosen projects hold any of its tickets' commits.
  if (s.tickets.some((t) => t.code)) {
    const started = s.tickets.filter((t) => !t.completed && t.status !== "todo");
    facts.push(["commit", "In progress, no commit yet", plural(started.filter((t) => !t.code?.commits.length).length, "ticket")]);
    facts.push(["check", "Done with no commit", plural(s.tickets.filter((t) => t.completed && !t.code?.commits.length).length, "ticket")]);
  }
  const rows: Cell[][] = [
    ["Group", "Name", `Committed (${unitName(u)})`, `Completed (${unitName(u)})`],
    ...parts.map((x): Cell[] => ["Status", x.label, x.n, null]),
    ...s.kinds.map((k): Cell[] => ["Type", k.name, r2(k.committed[u]), r2(k.completed[u])]),
  ];
  return (
    <Card title="Sprint makeup" hint={s.state === "active" ? "Where its tickets stand now and what they are" : "Its tickets' status now and what they were"} rows={rows} file={`gitnetix-makeup-${slug(s.name)}.csv`}>
      <div className="col" style={{ gap: 8 }}>
        <span className="muted spr-label">Status · {plural(total, "ticket")}</span>
        <div className="spr-seg" role="img" aria-label={parts.map((x) => `${x.label}: ${x.n}`).join(", ")}>
          {parts.map((x) => (
            <span key={x.k} style={{ flexGrow: x.n, background: x.fill, color: x.light ? "#fff" : "var(--fg)" }} data-tip={`${x.label}: ${plural(x.n, "ticket")} · ${pct(x.n, total)}%`}>
              {x.n / total >= 0.1 ? x.n : ""}
            </span>
          ))}
        </div>
        <div className="spr-legend">
          {parts.map((x) => (
            <span key={x.k} className="spr-key-l">
              <span className="spr-key" style={{ background: x.fill }} />
              {x.label}
            </span>
          ))}
        </div>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span className="muted spr-label">By type · completed of committed</span>
        {s.kinds.map((k) => (
          <div key={k.name} className="spr-hbar" data-tip={`${k.name}: ${amount(k.completed[u], u)} completed of ${amount(k.committed[u], u)}`}>
            <span className="ellipsis">{k.name}</span>
            <span className="spr-hbar-bar" style={{ width: `${Math.max(2, (k.committed[u] / kmax) * 100)}%` }}>
              {k.completed[u] > 0 && <span className="done" style={{ flexGrow: k.completed[u] }} />}
              {k.committed[u] - k.completed[u] > 1e-9 && <span className="rest" style={{ flexGrow: k.committed[u] - k.completed[u] }} />}
            </span>
            <span className="mono faint">{num(k.completed[u], u)}/{num(k.committed[u], u)}</span>
          </div>
        ))}
      </div>
      <dl className="spr-facts">
        {facts.map(([icon, label, v]) => (
          <div key={label}>
            <dt><Icon name={icon} size={11} />{label}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Whether open ticket `t` has been going longer than `p85`, what 85% of the finished tickets took at most. */
const old = (t: SprintTicket, p85: number | null) => t.ageHours != null && p85 != null && t.ageHours > p85;

/** Every ticket of the sprint on screen, the ones not completed first. */
function Tickets({ s, u, p85, onOpen }: { s: SprintStat; u: Unit; p85: number | null; onOpen: (key: string, sprint: number) => void }) {
  const [show, setShow] = useState<"open" | "done" | "all">("open");
  const isOpen = (t: SprintTicket) => !t.completed && !t.cancelled;
  const open = s.tickets.filter(isOpen).length;
  const list = s.tickets
    .filter((t) => show === "all" || (show === "done" ? t.completed : isOpen(t)))
    .sort((a, b) => Number(a.completed) - Number(b.completed) || (b.remaining ?? b.estimate ?? 0) - (a.remaining ?? a.estimate ?? 0) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  return (
    <Card
      title={`Tickets of ${s.name}`}
      hint={`${s.tickets.filter((t) => t.completed).length} completed, ${open} not completed${s.cancelled ? `, ${s.cancelled} cancelled` : ""}`}
      rows={ticketRows([s])}
      file={`gitnetix-tickets-${slug(s.name)}.csv`}
      table={false}
      right={<Seg label="Tickets shown" value={show} onChange={setShow} options={[{ value: "open", label: "Not completed" }, { value: "done", label: "Completed" }, { value: "all", label: "All" }]} />}
    >
      {list.length === 0 ? (
        <Empty>{show === "open" ? "Every ticket was completed." : "No ticket completed yet."}</Empty>
      ) : (
        <div className="spr-table-wrap">
          <table className="table spr-tickets">
            <thead>
              <tr>
                <th>Key</th>
                <th>Title</th>
                <th>Assignee</th>
                <th>Status</th>
                <th className="num">Points</th>
                <th className="num">Estimate</th>
                <th className="num">Remaining</th>
                <th className="num" data-tip="From its first move to work in progress to done; for an open ticket, since then">Start to done</th>
                <th>Code</th>
                <th>Done</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.key} className={u === "points" && t.points == null ? "spr-unsized" : undefined}>
                  <td><button className="spr-keylink" onClick={() => onOpen(t.key, s.id)} data-tip="See the ticket">{t.key}</button></td>
                  <td>
                    <span className="row" style={{ gap: 6, margin: 0, minWidth: 0 }}>
                      {t.bug && <span className="kind-chip c-del">bug</span>}
                      <span className="ellipsis" title={t.title}>{t.title}</span>
                      {t.carried && <span className="tag" data-tip="It was in an earlier sprint first">carried</span>}
                      {t.added && <span className="tag" data-tip="Created after the sprint started">added</span>}
                      {t.moved && <span className="tag c-warn" data-tip="Not completed, went on to a later sprint">moved on</span>}
                      {t.cancelled && <span className="tag" data-tip="Dropped in this sprint: left out of its numbers">cancelled</span>}
                    </span>
                  </td>
                  <td>
                    <span className="row" style={{ gap: 6, margin: 0 }}>
                      <Avatar name={t.assignee} size={18} />
                      <span className="ellipsis">{t.assignee}</span>
                    </span>
                  </td>
                  <td className="muted">{t.statusLabel}</td>
                  <td className="num">{t.points ?? "–"}</td>
                  <td className="num">{t.estimate == null ? "–" : `${r1(t.estimate)} h`}</td>
                  <td className="num">{t.remaining == null ? "–" : `${r1(t.remaining)} h`}</td>
                  <td className="num">
                    {t.cycleHours != null ? span(t.cycleHours) : t.ageHours != null ? <span className={old(t, p85) ? "c-warn" : "muted"} data-tip={old(t, p85) ? "Open longer than 85% of the finished tickets took" : "Open since it started"}>{old(t, p85) && <Icon name="alert" size={11} />} {span(t.ageHours)} open</span> : "–"}
                  </td>
                  <td>{t.code ? <button className="spr-code" onClick={() => onOpen(t.key, s.id)}>{plural(t.code.commits.length, "commit")}{t.code.branches.length ? ` · ${branches(t.code.branches.length)}` : ""}</button> : <span className="faint">–</span>}</td>
                  <td className="faint">{t.doneAt ? day(t.doneAt) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** How long tickets took from start to done in the sprints shown, and where the time went in the sprint on screen. */
function Cycle({ board, s, p85, onOpen }: { board: SprintBoard; s: SprintStat; p85: number | null; onOpen: (key: string, sprint: number) => void }) {
  const [hi, setHi] = useState<string | null>(null);
  const sprints = board.sprints;
  const done = sprints.flatMap((x) => x.tickets.filter((t) => t.completed && t.cycleHours != null && t.doneAt).map((t) => ({ t, x })));
  const known = sprints.some((x) => x.tickets.some((t) => t.startedAt));
  const sorted = done.map((d) => d.t.cycleHours!).sort((a, b) => a - b);
  const med = rank(sorted, 0.5);
  // A few very slow tickets would squash the rest: the axis stops near twice the 85% mark, and slower ones sit on its top line.
  const max = Math.min(niceMax(Math.max(1, ...sorted.map((h) => h / 24))), niceMax(Math.max(1, ((p85 ?? 0) / 24) * 2)));
  const over = sorted.filter((h) => h / 24 > max).length;
  const from = Date.parse(`${sprints[0].start}T00:00:00Z`);
  const last = sprints[sprints.length - 1];
  const to = Math.max(Date.parse(`${last.complete ?? last.end}T23:59:59Z`), from + 86_400_000);
  const X = (iso: string) => ((Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) - from) / (to - from)) * 100;
  const Y = (hours: number) => 100 - (Math.min(hours / 24, max) / max) * 100;
  // Tickets done the same day spread a little, so none hides another.
  const seen = new Map<string, number>();
  const dots = done.map(({ t, x }) => {
    const j = seen.get(t.doneAt!) ?? 0;
    seen.set(t.doneAt!, j + 1);
    return { t, x, left: Math.min(99.5, Math.max(0.5, X(t.doneAt!) + [0, 0.6, -0.6, 1.2, -1.2][j % 5])), top: Y(t.cycleHours!) };
  });
  const mine = s.tickets.filter((t) => t.completed && t.cycleHours != null);
  const stages = STAGES.map(([k, label], i) => ({ k, label, fill: STAGE_FILL[i], h: mine.length ? mine.reduce((a, t) => a + (t.stages[k] ?? 0), 0) / mine.length : 0 })).filter((x) => x.h > 0);
  const stageMax = Math.max(1e-9, ...stages.map((x) => x.h));
  const risky = s.tickets.filter((t) => old(t, p85)).sort((a, b) => b.ageHours! - a.ageHours!);
  const h = hi ? dots.find((d) => `${d.x.id}:${d.t.key}` === hi) : undefined;
  const rows: Cell[][] = [
    ["Sprint", "Key", "Title", "Type", "Assignee", "Started", "Done on", "Start to done (h)", ...STAGES.map(([, l]) => `${l} (h)`)],
    ...done.map(({ t, x }): Cell[] => [x.name, t.key, t.title, t.kind, t.assignee, t.startedAt?.slice(0, 10) ?? null, t.doneAt, r2(t.cycleHours!), ...STAGES.map(([k]) => r2(t.stages[k] ?? 0))]),
  ];
  return (
    <Card
      title="Time from start to done"
      hint="Each dot is a ticket completed in the sprints shown, placed on the day it was done, as high as the time it took from its first move to work in progress."
      rows={rows}
      file={`gitnetix-start-to-done-${slug(board.name)}.csv`}
      right={med != null && p85 != null && <span className="muted spr-quant">Half within <strong>{span(med)}</strong> · 85% within <strong>{span(p85)}</strong></span>}
    >
      {!known ? (
        <Empty>Jira did not give these tickets' history, so when work on them started is unknown.</Empty>
      ) : (
        <div className="spr-flow">
          <div className="col" style={{ gap: 10, minWidth: 0 }}>
            <div className="spr-legend">
              <Key kind="dot s1" label={`Done in ${short(s)}`} />
              <Key kind="dot ctx" label="Other sprints" />
              {med != null && <Key kind="q50" label="Half took less" />}
              {p85 != null && <Key kind="q85" label="85% took less" />}
              {over > 0 && <Key kind="dot hollow" label={`${over} slower than ${max} d, on the top line`} />}
            </div>
            <div className="chart spr-chart">
              <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{r1(t.v)} d</span>)}</div>
              <div className="chart-plot spr-plot" onMouseLeave={() => setHi(null)}>
                {ticks(max).map((t) => <div key={t.top} className="spr-grid" style={{ top: `${t.top}%` }} />)}
                {sprints.slice(1).map((x) => <div key={x.id} className="spr-band" style={{ left: `${X(x.start)}%` }} />)}
                {med != null && <div className="spr-quantile q50" style={{ top: `${Y(med)}%` }} />}
                {p85 != null && <div className="spr-quantile q85" style={{ top: `${Y(p85)}%` }} />}
                {dots.map((d) => (
                  <button
                    key={`${d.x.id}:${d.t.key}`}
                    className={`spr-pt${d.x.id === s.id ? " sel" : ""}${d.t.cycleHours! / 24 > max ? " over" : ""}${hi === `${d.x.id}:${d.t.key}` ? " on" : ""}`}
                    style={{ left: `${d.left}%`, top: `${d.top}%` }}
                    aria-label={`${d.t.key}, done ${day(d.t.doneAt!)}: ${span(d.t.cycleHours!)} from start to done`}
                    onMouseEnter={() => setHi(`${d.x.id}:${d.t.key}`)}
                    onFocus={() => setHi(`${d.x.id}:${d.t.key}`)}
                    onBlur={() => setHi(null)}
                    onClick={() => onOpen(d.t.key, d.x.id)}
                  />
                ))}
                {h && (
                  <div className="chart-tip spr-pt-tip" style={{ left: `${h.left}%`, top: `${h.top}%`, transform: `translate(${h.left < 20 ? "-10%" : h.left > 80 ? "-90%" : "-50%"}, ${h.top < 45 ? "16px" : "calc(-100% - 16px)"})` }}>
                    <div className="row" style={{ margin: 0 }}>
                      <strong className="mono grow">{h.t.key}</strong>
                      <span className="faint">{short(h.x)} · done {day(h.t.doneAt!)}</span>
                    </div>
                    <span className="ellipsis">{h.t.title}</span>
                    <TipRow kind="dot s1" value={span(h.t.cycleHours!)} label={`from start to done · ${h.t.assignee}`} />
                    {STAGES.map(([k, label], i) => (h.t.stages[k] ?? 0) > 0 && <TipRow key={k} kind={STAGE_KEY[i]} value={span(h.t.stages[k]!)} label={label.toLowerCase()} />)}
                    {p85 != null && h.t.cycleHours! > p85 && <span className="row c-warn" style={{ gap: 6, margin: 0 }}><Icon name="alert" size={11} />Slower than 85% of the tickets</span>}
                  </div>
                )}
              </div>
              <div className="chart-x">
                {sprints.map((x, i) => {
                  const end = sprints[i + 1]?.start ?? x.complete ?? x.end;
                  return <span key={x.id} className={x.id === s.id ? "sel" : undefined} style={{ left: `${(X(x.start) + X(end)) / 2}%`, transform: "translateX(-50%)" }}>{short(x)}</span>;
                })}
              </div>
            </div>
          </div>
          <div className="col spr-flow-side">
            <span className="muted spr-label">Where the time went in {short(s)}, on average</span>
            {stages.length === 0 && <span className="faint">No ticket completed with its history yet.</span>}
            {stages.map((x) => (
              <div key={x.k} className="spr-hbar" data-tip={`${x.label}: ${span(x.h)} on average, over ${plural(mine.length, "completed ticket")}`}>
                <span className="ellipsis">{x.label}</span>
                <span className="spr-hbar-bar" style={{ width: `${Math.max(2, (x.h / stageMax) * 100)}%` }}>
                  <span style={{ flexGrow: 1, background: x.fill }} />
                </span>
                <span className="mono faint">{span(x.h)}</span>
              </div>
            ))}
            <span className="muted spr-label" style={{ marginTop: 10 }}>Open longer than 85% of the finished ones took</span>
            {risky.length === 0 && <span className="faint">None.</span>}
            {risky.slice(0, 5).map((t) => (
              <div key={t.key} className="spr-left-row">
                <Icon name="alert" size={11} className="c-warn" />
                <button className="spr-keylink" onClick={() => onOpen(t.key, s.id)} data-tip="See the ticket">{t.key}</button>
                <span className="ellipsis grow" title={t.title}>{t.title}</span>
                <span className="mono faint">{span(t.ageHours!)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/** One ticket: its figures, how its time went, and its code, linked to the workspace and to the Commits tab. */
function TicketModal({ t, s, onClose, onDay }: { t: SprintTicket; s: SprintStat; onClose: () => void; onDay: (date: string) => void }) {
  const nav = useNav();
  const stages = STAGES.map(([k, label], i) => ({ k, label, fill: STAGE_FILL[i], ink: STAGE_INK[i], h: t.stages[k] ?? 0 })).filter((x) => x.h > 0);
  const total = stages.reduce((a, x) => a + x.h, 0);
  const facts: [string, string][] = [
    ["Points", t.points == null ? "–" : String(t.points)],
    ["Estimate", t.estimate == null ? "–" : `${r1(t.estimate)} h`],
    ["Remaining", t.remaining == null ? "–" : `${r1(t.remaining)} h`],
    ["Started", t.startedAt ? weekday(t.startedAt) : "Not yet"],
    [t.completed ? "Done" : "Status now", t.completed && t.doneAt ? weekday(t.doneAt) : t.statusLabel],
    [t.completed ? "Start to done" : "Open for", t.cycleHours != null ? span(t.cycleHours) : t.ageHours != null ? span(t.ageHours) : "–"],
  ];
  const workspace = (projectId: string, branch: string) => {
    onClose();
    nav.setProject(projectId);
    nav.selectBranch(branch);
    nav.go({ name: "workspace" });
  };
  return (
    <Modal
      title={
        <span className="row" style={{ gap: 10, margin: 0, minWidth: 0 }}>
          <span className="mono">{t.key}</span>
          <span className="ellipsis">{t.title}</span>
        </span>
      }
      sub={[t.kind, t.assignee, t.statusLabel, s.name].join(" · ")}
      onClose={onClose}
      width={760}
      actions={
        <button className="btn btn-sm" onClick={() => openExternal(t.url)}>
          <Icon name="external" size={12} />
          Open in Jira
        </button>
      }
    >
      {/* Portaled out of the board: the series colors come with this class. */}
      <div className="spr col" style={{ gap: 18 }}>
      <dl className="spr-facts three">
        {facts.map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {stages.length > 0 && (
        <section className="col" style={{ gap: 8 }}>
          <span className="muted spr-label">Time in each status after the start</span>
          <div className="spr-seg" role="img" aria-label={stages.map((x) => `${x.label}: ${span(x.h)}`).join(", ")}>
            {stages.map((x) => (
              <span key={x.k} style={{ flexGrow: x.h, background: x.fill, color: x.ink }} data-tip={`${x.label}: ${span(x.h)}`}>
                {x.h / total >= 0.16 ? span(x.h) : ""}
              </span>
            ))}
          </div>
          <div className="spr-legend">
            {stages.map((x) => (
              <span key={x.k} className="spr-key-l">
                <span className="spr-key" style={{ background: x.fill }} />
                {x.label} · {span(x.h)}
              </span>
            ))}
          </div>
        </section>
      )}
      <section className="col" style={{ gap: 4 }}>
        <span className="muted spr-label">Code</span>
        {!t.code && <span className="faint">No commit or branch names {t.key} in the projects linked to Jira.</span>}
        {t.code?.branches.map((b) => (
          <div key={`${b.projectId}:${b.name}`} className="spr-left-row">
            <Icon name="branch" size={12} />
            <span className="mono ellipsis grow">{b.name}</span>
            <span className="faint">{b.project}</span>
            {b.live ? <button className="btn btn-sm" onClick={() => workspace(b.projectId, b.name)}>Open in workspace</button> : <span className="tag" data-tip="Deleted once merged">merged</span>}
          </div>
        ))}
        {t.code?.commits.map((c) => (
          <div key={c.sha} className="spr-left-row">
            <button className="spr-keylink" data-tip="Show this day in Commits" onClick={() => { onClose(); onDay(new Date(c.date).toISOString().slice(0, 10)); }}>{day(c.date)}</button>
            <span className="mono ellipsis grow" title={c.subject}>{c.subject}</span>
            <span className="faint ellipsis" style={{ maxWidth: 180 }} title={c.branch || c.project}>{c.branch || c.project}</span>
            <Avatar name={c.author} size={18} />
          </div>
        ))}
      </section>
      </div>
    </Modal>
  );
}
