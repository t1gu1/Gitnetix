import type { AgentSession, AgentStatus, LogLine } from "../api/types";
import { clock, plural } from "./format";

/** A file a turn changed and its added and removed lines, null for a binary file. */
export type Changed = [path: string, added: number | null, removed: number | null];

/** `at`: when its first line was logged. */
export type Block = { at?: number } & (
  | { kind: "you"; text: string; files: string[] }
  | { kind: "ai"; text: string }
  | { kind: "steps"; lines: LogLine[] }
  | { kind: "files"; from: string; to: string; files: Changed[]; more: number }
  | { kind: "note" | "ok" | "err" | "wait"; text: string }
);

// "✦ " starts a reply; older logs and plain CLIs continue it line by line.
const REPLY = /^✦ /;
const STATUS = /^\s*[■⏸▶]/;

/** A message of yours: its text, then the files sent with it, which close it, one "- path" per line. */
export function said(msg: string) {
  const [text, list = ""] = msg.split(/\n*Attached files:\n(?=- )/);
  return { text, files: list.split("\n").flatMap((f) => (f.startsWith("- ") ? [f.slice(2)] : [])) };
}

// A new line replaces a session's array, never changes it: each array is grouped once, however often it redraws.
const grouped = new WeakMap<LogLine[], Block[]>();

/** Group raw log lines into chat blocks: your messages, replies, tool steps, status. Shared per `lines`: read it, don't change it. */
export function blocks(lines: LogLine[]): Block[] {
  const done = grouped.get(lines);
  if (done) return done;
  const out: Block[] = [];
  grouped.set(lines, out);
  for (const l of lines) {
    const last = out.at(-1);
    switch (l.kind) {
      case "cmd": {
        // "$ claude · request" opens the session, "› text" follows up.
        out.push({ kind: "you", ...said(l.text.replace(/^(\$ \S+ · |› )/, "")), at: l.at });
        break;
      }
      case "ai": {
        const text = l.text.replace(/^(✦ | {2})/, "");
        if (last?.kind === "ai") last.text += (REPLY.test(l.text) ? "\n\n" : "\n") + text;
        else out.push({ kind: "ai", text, at: l.at });
        break;
      }
      case "dim":
      case "run":
        if (STATUS.test(l.text)) out.push({ kind: "note", text: l.text.trim(), at: l.at });
        else if (last?.kind === "steps") last.lines.push(l);
        else out.push({ kind: "steps", lines: [l], at: l.at });
        break;
      case "files":
        try {
          const f = JSON.parse(l.text) as { from: string; to: string; files: Changed[]; more?: number };
          out.push({ kind: "files", from: f.from, to: f.to, files: f.files, more: f.more ?? 0, at: l.at });
        } catch {
          // Not ours to show: a line cut short.
        }
        break;
      case "ok":
      case "err":
      case "wait":
        out.push({ kind: l.kind, text: l.text.replace(/^[✓✕◆] /, ""), at: l.at });
        break;
      default:
        out.push({ kind: "note", text: l.text, at: l.at });
    }
  }
  return out;
}

export type Opt = { n: string; label: string };
/** A question the agent waits on: its letter ("A") when it has one, its text, and its numbered options. */
export type Question = { id: string; text: string; opts: Opt[] };

// The agent may reply in French ("Quelle option ?", "Réponds 1, 2 ou 3").
// Not after a hyphen: "cherry-pick" is not asking you to pick. A hyphen after is fine: "Préfères-tu".
const PICK = /(?<![\w-])(which|prefer|choose|pick|quel(le)?s?|lequel|laquelle|choisi\w*|choix|préf[éè]r\w*)\b/i;

/** Numbered options ("1. **Foo:** bar") in the agent's last reply, when it now waits for you to pick: one entry per question. */
export function questions(lines: LogLine[]): Question[] {
  const b = blocks(lines);
  if (b.at(-1)?.kind !== "wait") return [];
  const reply = [...b].reverse().find((x) => x.kind === "ai" || x.kind === "you");
  if (reply?.kind !== "ai") return [];
  const rows = reply.text.split("\n");
  // A list starts at "1." and runs while the numbers follow; lines between items (sub-bullets) are skipped.
  const lists: { start: number; end: number; opts: Opt[] }[] = [];
  let fence = false;
  rows.forEach((row, i) => {
    if (/^\s*```/.test(row)) fence = !fence;
    // The number may sit inside the bold: "**1. Foo** bar".
    const m = fence ? null : /^\s*(?:\*\*)?(\d+)[.)]\s+(.+)$/.exec(row);
    if (!m) return;
    const opt = { n: m[1], label: m[2].replace(/\*\*|`/g, "") };
    const last = lists.at(-1);
    if (m[1] === "1") lists.push({ start: i, end: i + 1, opts: [opt] });
    else if (last && Number(m[1]) === last.opts.length + 1) {
      last.opts.push(opt);
      last.end = i + 1;
    }
  });
  const found = lists.map((l, k) => {
    const final = k === lists.length - 1;
    // Items that are questions ("What text? …") ask you to answer each one, not to pick one.
    const ask = !l.opts.some((o) => o.label.includes("?"));
    // A plain list (steps, findings, changes) is not a question: only offer it when the text around it asks you to pick.
    // The intro may be bold or a heading: "**A. Which one?**".
    const intro = (rows.slice(0, l.start).filter((r) => r.trim()).at(-1) ?? "").replace(/\*\*|`/g, "").replace(/^\s*#+\s*/, "").trim();
    const after = final ? rows.slice(l.end).join("\n") : "";
    const asks = ask && (/\?$/.test(intro) || PICK.test(intro) || PICK.test(after) || /\b\d+\s+(or|ou)\s+\d+\b/i.test(after));
    return { l, ask, asks, intro, id: /^([A-Z])[.)]\s/.exec(intro)?.[1] ?? "" };
  });
  // "C. If it fails:" next to "A. Which one?" is a question too.
  const lettered = found.some((f) => f.asks && f.id);
  const out: Question[] = [];
  for (const [k, f] of found.entries()) {
    const asks = f.asks || (lettered && f.ask && !!f.id);
    // The questions close the reply: when the last list asks nothing, the earlier ones were not questions either.
    if (k === found.length - 1 && !asks) return [];
    if (asks) out.push({ id: f.id, text: f.intro, opts: f.l.opts });
  }
  return out;
}

/** A worktree run that ended with its close options showing (no question, its branch `b` known) is done, even with nothing to merge. */
export const shownStatus = (s: AgentSession, b?: unknown): AgentStatus =>
  s.status === "waiting" && s.worktree && !!b && !questions(s.lines).length ? "done" : s.status;

// What a tool's calls did, said once for all of them. `files`: calls on the same file count once.
const TOOLS: { names: string[]; say: (n: number) => string; files?: boolean }[] = [
  { names: ["Read"], say: (n) => `read ${plural(n, "file")}`, files: true },
  { names: ["Edit", "MultiEdit", "Write", "NotebookEdit"], say: (n) => `edited ${plural(n, "file")}`, files: true },
  { names: ["Bash"], say: (n) => `ran ${plural(n, "command")}` },
  { names: ["Grep", "Glob", "LS"], say: (n) => `searched ${times(n)}` },
  { names: ["WebSearch"], say: (n) => `searched the web ${times(n)}` },
  { names: ["WebFetch"], say: (n) => `fetched ${plural(n, "page")}` },
  { names: ["Task", "Agent"], say: (n) => `started ${plural(n, "subagent")}` },
  { names: ["TodoWrite"], say: () => "updated its to-do list" },
];
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "Read 3 files, edited 2 files and ran 4 commands". Lines that are no tool the agent names (another CLI's output) are counted by their first word: "output ×3 · done". */
export function stepsLabel(lines: LogLine[]) {
  const seen = TOOLS.map(() => new Set<string>());
  const others = new Map<string, number>();
  lines.forEach((l, i) => {
    const [name = "", ...rest] = l.text.trim().split(/\s+/);
    const t = TOOLS.findIndex((x) => x.names.includes(name));
    if (t >= 0) seen[t].add(TOOLS[t].files ? rest.join(" ") : String(i));
    else others.set(name || "output", (others.get(name || "output") ?? 0) + 1);
  });
  const did = TOOLS.flatMap((t, i) => (seen[i].size ? [t.say(seen[i].size)] : []));
  if (!did.length) return [...others].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  const rest = [...others.values()].reduce((a, b) => a + b, 0);
  if (rest) did.push(plural(rest, "other step"));
  const s = did.length > 1 ? `${did.slice(0, -1).join(", ")} and ${did.at(-1)}` : did[0];
  return s[0].toUpperCase() + s.slice(1);
}

/** "45s", "2m 14s", "1h 5m". */
export function took(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** A finished turn's work in one row: its blocks from where it is keyed up to `end`, how long the turn took, its steps, and whether you stopped it. */
export type Fold = { end: number; ms?: number; steps: number; stopped: boolean };

/** The folds of `list`, keyed by their first block: in each turn that ended, the steps and replies before its last reply.
 * The last turn stays open while the agent works on it (`working`). */
export function folds(list: Block[], working: boolean): Map<number, Fold> {
  const out = new Map<number, Fold>();
  // The turn is the blocks from `start` up to `end`, after your message at `start - 1` (none at the top of an old log).
  const close = (start: number, end: number) => {
    let reply = -1;
    let steps = -1;
    for (let i = start; i < end; i++) {
      if (list[i].kind === "ai") reply = i;
      else if (list[i].kind === "steps") steps = i;
    }
    // The last reply stays out, and what came after it: a CLI's stderr may close the run after its answer.
    const to = reply >= 0 ? reply : steps + 1;
    const inner = list.slice(start, Math.max(start, to));
    if (!inner.some((b) => b.kind === "ai" || b.kind === "steps")) return;
    const from = list[start - 1]?.at ?? list[start].at;
    const last = list[end - 1].at;
    out.set(start, {
      end: to,
      ms: from !== undefined && last !== undefined ? last - from : undefined,
      steps: inner.reduce((n, b) => n + (b.kind === "steps" ? b.lines.length : 0), 0),
      stopped: list.slice(to, end).some((b) => b.kind === "note" && b.text.startsWith("■")),
    });
  };
  let start = 0;
  list.forEach((b, i) => {
    if (b.kind !== "you") return;
    if (i > start) close(start, i);
    start = i + 1;
  });
  if (!working && start < list.length) close(start, list.length);
  return out;
}

/** Claude's "Claude AI usage limit reached|1760000000": the time it resets at, in local time. */
export function errText(text: string) {
  const m = /^(.*usage limit reached)\|(\d{9,})/i.exec(text);
  if (!m) return text;
  return `${m[1]} · resets ${clock(Number(m[2]) * 1000)}`;
}
