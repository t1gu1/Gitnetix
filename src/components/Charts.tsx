import { type CSSProperties, type Dispatch, type ReactNode, type SetStateAction, useEffect, useRef, useState } from "react";

import { useAction } from "../api/hooks";
import { Icon } from "./Icon";
import { Busy, Markdown, Modal } from "./ui";
import { downloadCsv } from "../lib/format";

/** One cell of a chart's data: what its table view shows and its CSV holds. */
export type Cell = string | number | null;
export type Pt = [number, number];
export type Level = "good" | "warn" | "bad";
export interface Qa {
  question: string;
  answer: string;
}

export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data";
/** A YYYY-MM-DD day, read at noon so no time zone moves it to the day before. */
export const day = (iso: string, o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", o);
export const weekday = (iso: string) => day(iso, { weekday: "short", month: "short", day: "numeric" });
/** "6 h" under a day, "2.5 d" from there. */
export const span = (hours: number) => (hours < 24 ? `${Math.max(0, Math.round(hours))} h` : `${r1(hours / 24)} d`);

/** The value at least `share` of the sorted `v` are at or below (nearest rank), like the backend's. */
export function rank(v: number[], share: number) {
  return v.length ? v[Math.min(v.length, Math.max(1, Math.ceil(v.length * share))) - 1] : null;
}

/** The axis top for `v`: a round number that splits in quarters. */
export function niceMax(v: number) {
  for (const s of [4, 8, 12, 16, 20, 24, 32, 40, 60, 80, 100, 120, 160, 200, 240, 300, 400, 600, 800, 1000]) if (v <= s) return s;
  return Math.ceil(v / 400) * 400;
}
export const ticks = (max: number) => [0, 1, 2, 3, 4].map((i) => ({ v: (max * i) / 4, top: 100 - i * 25 }));
export const path = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");

/** A tooltip over the `i`th of `n` slots, kept inside the plot near its edges. */
export function tipAt(i: number, n: number): CSSProperties {
  const f = (i + 0.5) / n;
  return { left: `${f * 100}%`, transform: `translateX(${f < 0.2 ? "-10%" : f > 0.8 ? "-90%" : "-50%"})` };
}

/** A heat cell at `share` (0 to 1): a step of the series hue, and the ink that reads on it. */
export function heat(share: number): CSSProperties {
  const mix = Math.round(10 + Math.min(1, Math.max(0, share)) * 78);
  return { background: `color-mix(in srgb, var(--s1) ${mix}%, var(--panel))`, color: mix >= 55 ? "#fff" : "var(--fg)" };
}

/** A chart's frame: title, the table view of its data and the CSV of the same rows. */
export function Card({ title, hint, rows, file, right, table = true, children }: { title: string; hint?: ReactNode; rows: Cell[][]; file: string; right?: ReactNode; table?: boolean; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card spr-card" aria-label={title}>
      <div className="row spr-card-head">
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <h2>{title}</h2>
          {hint && <span className="hint">{hint}</span>}
        </div>
        {right}
        {table && (
          <button className="btn btn-ghost btn-icon btn-sm" aria-pressed={asTable} aria-label={asTable ? "Show the chart" : "Show as a table"} data-tip={asTable ? "Show the chart" : "Show as a table"} onClick={() => setAsTable(!asTable)}>
            <Icon name={asTable ? "chart" : "table"} size={13} />
          </button>
        )}
        <button className="btn btn-ghost btn-sm" data-tip="Download these rows as CSV" onClick={() => downloadCsv(file, rows)}>
          <Icon name="download" size={12} />
          CSV
        </button>
      </div>
      {asTable ? <DataTable rows={rows} /> : children}
    </section>
  );
}

export function DataTable({ rows }: { rows: Cell[][] }) {
  const [head, ...body] = rows;
  const numeric = head.map((_, i) => body.some((r) => typeof r[i] === "number"));
  return (
    <div className="spr-table-wrap">
      <table className="table">
        <thead>
          <tr>{head.map((h, i) => <th key={i} className={numeric[i] ? "num" : undefined}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={numeric[j] ? "num" : undefined}>{typeof c === "number" ? r2(c).toLocaleString("en-US") : c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A legend entry; its key mirrors the mark: a stroke for lines, a block for bars and areas. */
export function Key({ kind, label }: { kind: string; label: string }) {
  return (
    <span className="spr-key-l">
      <span className={`spr-key ${kind}`} />
      {label}
    </span>
  );
}

/** A tooltip line: its series' key, the value first, the name after. */
export function TipRow({ kind, value, label }: { kind: string; value: string; label: string }) {
  return (
    <div className="row" style={{ gap: 8, margin: 0 }}>
      <span className={`spr-key ${kind}`} />
      <strong>{value}</strong>
      <span className="muted">{label}</span>
    </div>
  );
}

export function LevelChip({ level, label }: { level: Level; label: string }) {
  return (
    <span className={`spr-level ${level}`}>
      <Icon name={level === "good" ? "check" : "alert"} size={12} />
      {label}
    </span>
  );
}

/** Questions about the data on screen, answered by AI. `data` builds what is sent, as JSON text. */
export function Ask({ title, sub, intro, suggestions, data, chat, setChat, onClose }: { title: string; sub: string; intro: string; suggestions: string[]; data: () => string; chat: Qa[]; setChat: Dispatch<SetStateAction<Qa[]>>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const ask = useAction<{ answer: string }, { question: string; data: string; history: Qa[] }>("analytics.ask");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [chat.length, ask.isPending]);
  const send = (question: string) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setAsked(q);
    setText("");
    ask.mutate({ question: q, data: data(), history: chat.slice(-4) }, { onSuccess: (r) => setChat((c) => [...c, { question: q, answer: r.answer }]), onError: () => setText(q) });
  };
  return (
    <Modal
      title={
        <span className="row" style={{ gap: 8, margin: 0 }}>
          <Icon name="sparkle" size={14} className="c-acc" />
          {title}
        </span>
      }
      sub={sub}
      onClose={onClose}
      width={720}
      actions={chat.length > 0 && <button className="btn btn-ghost btn-sm" disabled={ask.isPending} onClick={() => setChat([])}>Clear</button>}
      footer={
        <div className="row" style={{ gap: 8, margin: 0, alignItems: "flex-end" }}>
          <textarea
            className="textarea grow"
            rows={2}
            autoFocus
            aria-label="Question"
            placeholder="Ask about velocity, workload, risks…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <button className="btn btn-primary btn-md" disabled={!text.trim() || ask.isPending} onClick={() => send(text)}>
            <Busy on={ask.isPending}><Icon name="send" size={13} /></Busy>
            Ask
          </button>
        </div>
      }
    >
      {chat.length === 0 && !ask.isPending && (
        <div className="col" style={{ gap: 8 }}>
          <span className="muted">{intro}</span>
          <div className="row wrap" style={{ gap: 6, margin: 0 }}>
            {suggestions.map((x) => <button key={x} className="btn btn-sm spr-suggest" onClick={() => send(x)}>{x}</button>)}
          </div>
        </div>
      )}
      {chat.map((c, i) => (
        <div key={i} className="spr-qa">
          <div className="spr-q">{c.question}</div>
          <div className="spr-a"><Markdown text={c.answer} /></div>
        </div>
      ))}
      {ask.isPending && (
        <div className="spr-qa">
          <div className="spr-q">{asked}</div>
          <div className="spr-a row muted" style={{ gap: 8, margin: 0 }}><span className="spinner" />Reading the data on screen…</div>
        </div>
      )}
      <div ref={end} />
    </Modal>
  );
}
