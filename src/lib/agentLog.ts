import type { AgentSession, AgentStatus, LogLine } from "../api/types";

export type Block =
  | { kind: "you"; text: string; files: string[] }
  | { kind: "ai"; text: string }
  | { kind: "steps"; lines: LogLine[] }
  | { kind: "note" | "ok" | "err" | "wait"; text: string };

// "✦ " starts a reply; older logs and plain CLIs continue it line by line.
const REPLY = /^✦ /;
const STATUS = /^\s*[■⏸▶]/;

/** A message of yours: its text, then the files sent with it, which close it, one "- path" per line. */
export function said(msg: string) {
  const [text, list = ""] = msg.split(/\n*Attached files:\n(?=- )/);
  return { text, files: list.split("\n").flatMap((f) => (f.startsWith("- ") ? [f.slice(2)] : [])) };
}

/** Group raw log lines into chat blocks: your messages, replies, tool steps, status. */
export function blocks(lines: LogLine[]): Block[] {
  const out: Block[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    switch (l.kind) {
      case "cmd": {
        // "$ claude · request" opens the session, "› text" follows up.
        out.push({ kind: "you", ...said(l.text.replace(/^(\$ \S+ · |› )/, "")) });
        break;
      }
      case "ai": {
        const text = l.text.replace(/^(✦ | {2})/, "");
        if (last?.kind === "ai") last.text += (REPLY.test(l.text) ? "\n\n" : "\n") + text;
        else out.push({ kind: "ai", text });
        break;
      }
      case "dim":
      case "run":
        if (STATUS.test(l.text)) out.push({ kind: "note", text: l.text.trim() });
        else if (last?.kind === "steps") last.lines.push(l);
        else out.push({ kind: "steps", lines: [l] });
        break;
      case "ok":
      case "err":
      case "wait":
        out.push({ kind: l.kind, text: l.text.replace(/^[✓✕◆] /, "") });
        break;
      default:
        out.push({ kind: "note", text: l.text });
    }
  }
  return out;
}

export type Opt = { n: string; label: string };
/** A question the agent waits on: its letter ("A") when it has one, its text, and its numbered options. */
export type Question = { id: string; text: string; opts: Opt[] };

// The agent may reply in French ("Quelle option ?", "Réponds 1, 2 ou 3").
const PICK = /\b(which|prefer|choose|pick|quel(le)?s?|lequel|laquelle|choisi\w*|choix|préf[éè]r\w*)\b/i;

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

/** A worktree run that ended with its merge options showing (no question, something to merge on its branch `b`) is done. */
export const shownStatus = (s: AgentSession, b?: { ahead: number; wip: number }): AgentStatus =>
  s.status === "waiting" && s.worktree && !!b && (b.ahead > 0 || b.wip > 0) && !questions(s.lines).length ? "done" : s.status;
