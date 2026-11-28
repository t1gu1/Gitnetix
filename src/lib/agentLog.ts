import type { AgentLimit, AgentSession, AgentStatus, AgentTask, LogLine } from "../api/types";
import { clock, plural } from "./format";

/** A file a turn changed and its added and removed lines, null for a binary file. */
export type Changed = [path: string, added: number | null, removed: number | null];

/** What a subagent was started on (its "agent" line, agents.rs `subagent_started`). */
export type SubInfo = { description: string; type?: string; prompt?: string; background?: boolean; worktree?: boolean };

/** `at`: when its first line was logged. A subagent ("agent") is one block where it started, with all its lines and how it ended. */
export type Block = { at?: number } & (
  | { kind: "you"; text: string; files: string[] }
  | { kind: "ai"; text: string }
  | { kind: "steps"; lines: LogLine[] }
  | { kind: "files"; from: string; to: string; files: Changed[]; more: number }
  | { kind: "note" | "ok" | "err" | "wait" | "limit"; text: string }
  | { kind: "agent"; id: string; info: SubInfo; lines: LogLine[]; end?: "done" | "failed" | "stopped" }
);

export type SubBlock = Extract<Block, { kind: "agent" }>;

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
const own = new WeakMap<LogLine[], Block[]>();

/** Group raw log lines into chat blocks: your messages, replies, tool steps, status. A subagent's lines go in its one block. Shared per `lines`: read it, don't change it. */
export const blocks = (lines: LogLine[]) => group(lines, grouped, false);

/** A subagent's lines (`SubBlock.lines`) as its own chat blocks. */
export const subBlocks = (lines: LogLine[]) => group(lines, own, true);

function group(lines: LogLine[], memo: WeakMap<LogLine[], Block[]>, inner: boolean): Block[] {
  const done = memo.get(lines);
  if (done) return done;
  const out: Block[] = [];
  memo.set(lines, out);
  const subs = new Map<string, SubBlock>();
  for (const l of lines) {
    if (l.agent && !inner) {
      let b = subs.get(l.agent);
      if (!b) {
        b = { kind: "agent", id: l.agent, info: { description: "" }, lines: [], at: l.at };
        subs.set(l.agent, b);
        // Its row says it started: the agent's "Agent" step before it would say it twice.
        const steps = lastOwn(out);
        if (steps?.kind === "steps") {
          const call = steps.lines.map((s) => /^\s*(Agent|Task)\b/.test(s.text)).lastIndexOf(true);
          if (call >= 0) steps.lines = steps.lines.filter((_, i) => i !== call);
          if (!steps.lines.length) out.splice(out.indexOf(steps), 1);
        }
        out.push(b);
      }
      if (l.kind === "agent") b.info = subInfo(l.text);
      else if (l.kind === "task") b.end = l.text.startsWith("✓") ? "done" : l.text.startsWith("✕") ? "failed" : "stopped";
      else b.lines.push(l);
      continue;
    }
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
      case "limit":
        out.push({ kind: "limit", text: l.text, at: l.at });
        break;
      default:
        out.push({ kind: "note", text: l.text, at: l.at });
    }
  }
  return out;
}

function subInfo(text: string): SubInfo {
  try {
    const i = JSON.parse(text) as Partial<Record<keyof SubInfo, unknown>>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { description: str(i.description) ?? "", type: str(i.type), prompt: str(i.prompt), background: i.background === true, worktree: i.worktree === true };
  } catch {
    return { description: "" };
  }
}

/** The last block that is the agent's own: subagents' blocks sit where they started, wherever their work is now. */
export function lastOwn(list: Block[]) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].kind !== "agent") return list[i];
}

/** Whether the agent's turn is over: it waits for you, or for you or its background work while that goes on. */
export const yourTurn = (lines: LogLine[]) => lastOwn(blocks(lines))?.kind === "wait";

/** Your message `text` for subagent `id` ("Fix card padding"), as the agent gets it: it passes it on with Claude Code's SendMessage. */
export const toSub = (id: string, name: string, text: string) => `For the subagent "${name}" (SendMessage to: ${id}):\n\n${text}`;
const TO_SUB = /^(› )For the subagent "[^\n]*" \(SendMessage to: ([^)\s]+)\):\n\n/;

/** Subagent `b`'s lines with your messages to it (`toSub`) among them, by time, as yours alone. */
export function withYours(b: SubBlock, lines: LogLine[]): LogLine[] {
  const yours = lines.flatMap((l) => {
    const m = l.kind === "cmd" ? TO_SUB.exec(l.text) : null;
    return m?.[2] === b.id ? [{ ...l, text: l.text.replace(TO_SUB, "$1") }] : [];
  });
  return yours.length ? [...b.lines, ...yours].sort((x, y) => (x.at ?? 0) - (y.at ?? 0)) : b.lines;
}

/** Where subagent `b` is: ended, else still at work while its run is (`working`) and has it going (in `tasks` when it went to the background). */
export function subState(b: SubBlock, working: boolean, tasks: AgentTask[]): "running" | "done" | "failed" | "stopped" {
  if (b.end) return b.end;
  return working && (!b.info.background || tasks.some((t) => t.id === b.id)) ? "running" : "stopped";
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
  if (lastOwn(b)?.kind !== "wait") return [];
  const reply = [...b].reverse().find((x) => x.kind === "ai" || x.kind === "you");
  if (reply?.kind !== "ai") return [];
  const rows = reply.text.split("\n");
  const out = numbered(rows);
  return out.length ? out : bulleted(rows);
}

/** No numbered question: the reply's last bullet list ("- Rename it"), right under a line ending with "?" and followed by no other list, is its options. */
function bulleted(rows: string[]): Question[] {
  let fence = false;
  const items = rows.map((row) => {
    if (/^\s*```/.test(row)) fence = !fence;
    // Top-level bullets only: indented ones are details of something above. `*` needs a space after it, so "**Bold**" is no bullet.
    return fence ? null : (/^[-*•]\s+(.+)$/.exec(row)?.[1] ?? null);
  });
  let end = items.length - 1;
  while (end >= 0 && items[end] === null) end--;
  if (end < 0 || rows.slice(end + 1).some((r) => /^\s*(\d+[.)]|[-*•])\s/.test(r))) return [];
  let start = end;
  while (start > 0 && items[start - 1] !== null) start--;
  const opts = items.slice(start, end + 1).map((x, i) => ({ n: String(i + 1), label: x!.replace(/\*\*|`/g, "") }));
  const intro = (rows.slice(0, start).filter((r) => r.trim()).at(-1) ?? "").replace(/\*\*|`/g, "").replace(/^\s*#+\s*/, "").trim();
  if (!/\?$/.test(intro) || opts.every((o) => o.label.includes("?"))) return [];
  return [{ id: /^([A-Z])[.)]\s/.exec(intro)?.[1] ?? "", text: intro, opts }];
}

function numbered(rows: string[]): Question[] {
  // A list starts at "1." and runs while the numbers follow; lines between items (sub-bullets) are skipped.
  const lists: { start: number; end: number; opts: Opt[] }[] = [];
  let fence = false;
  rows.forEach((row, i) => {
    if (/^\s*```/.test(row)) fence = !fence;
    // The number may sit inside the bold: "**1. Foo** bar", "**1.** Foo".
    const m = fence ? null : /^\s*(?:\*\*)?(\d+)[.)](?:\*\*)?\s+(.+)$/.exec(row);
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
    // Items that are all questions ("What text? …") ask you to answer each one, not to pick one. One option asking
    // something ("Rename it. To what?") is still an option.
    const ask = !l.opts.every((o) => o.label.includes("?"));
    // A plain list (steps, findings, changes) is not a question: only offer it when the text around it asks you to pick.
    // The intro may be bold or a heading: "**A. Which one?**".
    const intro = (rows.slice(0, l.start).filter((r) => r.trim()).at(-1) ?? "").replace(/\*\*|`/g, "").replace(/^\s*#+\s*/, "").trim();
    const after = final ? rows.slice(l.end).join("\n") : "";
    // After the list, only a sentence that asks counts: "…, which makes it stale" in a note is not a question.
    const asking = after
      .split(/(?<=[.!?])\s+|\n/)
      .map((s) => s.replace(/\*\*|`/g, "").replace(/^\s*[-*•]\s+/, "").trim())
      .filter((s) => /\?$/.test(s) || /\b(let me know|tell me|dis-moi)\b/i.test(s) || /^(pick|choose|choisis)/i.test(s))
      .join("\n");
    const asks = ask && (/\?$/.test(intro) || PICK.test(intro) || PICK.test(asking) || /\b\d+\s+(or|ou)\s+\d+\b/i.test(after));
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

/** What a session's status shows as: "limited" while a usage limit holds it. */
export type ShownStatus = AgentStatus | "limited";

/** Each shown status's label and colour class, as on Worktrees & agents. */
export const STATUS_SHOWN: Record<ShownStatus | "idle", [string, string]> = {
  running: ["Running", "c-acc"],
  waiting: ["Waiting for you", "c-warn"],
  // Its label says when it continues (`limitLabel`).
  limited: ["Usage limit", "c-warn"],
  paused: ["Paused", "muted"],
  failed: ["Failed", "c-del"],
  done: ["Done", "c-add"],
  stopped: ["Stopped", "faint"],
  idle: ["No agent", "faint"],
};

/** A session a usage limit holds is "limited". A worktree run that ended with its close options showing (no question, its branch `b` known) is done, even with nothing to merge.
 * A run whose turn ended on questions while its background work goes on waits for you. */
export const shownStatus = (s: AgentSession, b?: unknown): ShownStatus =>
  s.status === "running" && questions(s.lines).length
    ? "waiting"
    : s.status === "waiting" && s.limit
      ? "limited"
      : s.status === "waiting" && s.worktree && !!b && !questions(s.lines).length
        ? "done"
        : s.status;

/** A usage limit in a few words: when the agent continues, or why it waits for you. */
export const limitLabel = (l: AgentLimit) => (l.continueAt ? `Continues at ${clock(l.continueAt)}` : l.credits ? "Out of credits" : "Usage limit reached");

// What a tool's calls did, said once for all of them. `files`: calls on the same file count once.
const TOOLS: { names: string[]; say: (n: number) => string; files?: boolean }[] = [
  { names: ["Read"], say: (n) => `read ${plural(n, "file")}`, files: true },
  { names: ["Edit", "MultiEdit", "Write", "NotebookEdit"], say: (n) => `edited ${plural(n, "file")}`, files: true },
  { names: ["Bash"], say: (n) => `ran ${plural(n, "command")}` },
  { names: ["Grep", "Glob", "LS"], say: (n) => `searched ${times(n)}` },
  { names: ["WebSearch"], say: (n) => `searched the web ${times(n)}` },
  { names: ["WebFetch"], say: (n) => `fetched ${plural(n, "page")}` },
  { names: ["Task", "Agent"], say: (n) => `started ${plural(n, "subagent")}` },
  { names: ["Workflow"], say: (n) => `started ${plural(n, "workflow")}` },
  // What a subagent said as it worked (agents.rs).
  { names: ["Subagent"], say: (n) => `got ${plural(n, "subagent update")}` },
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

const KIND: Record<AgentTask["kind"], string> = { workflow: "workflow", agent: "subagent", shell: "command", other: "task" };

/** "1 workflow and 2 subagents": what a run has going in the background. */
export function tasksLabel(tasks: AgentTask[]) {
  const n = new Map<string, number>();
  for (const t of tasks) n.set(KIND[t.kind], (n.get(KIND[t.kind]) ?? 0) + 1);
  const said = [...n].map(([k, c]) => plural(c, k));
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : (said[0] ?? "");
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
      else if (list[i].kind === "steps" || list[i].kind === "agent") steps = i;
    }
    // The last reply stays out, and what came after it: a CLI's stderr may close the run after its answer.
    const to = reply >= 0 ? reply : steps + 1;
    const inner = list.slice(start, Math.max(start, to));
    if (!inner.some((b) => b.kind === "ai" || b.kind === "steps" || b.kind === "agent")) return;
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
