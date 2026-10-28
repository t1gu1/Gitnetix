// The commit graph's model: what the engine sent turned into a repo state, what an action would make of
// that state (a preview), and how a state lays out in lanes and rows. Pure and quick: it runs on every hover.

import type { GraphView } from "../api/types";
import { plural } from "./format";
import type { GraphIntent } from "./graphPreview";

/** A commit as the graph holds it. A preview's made-up ones have `sim`; a run of history left out, `gap` (how many commits). */
export type Node = {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  date: string;
  tags: string[];
  sim?: boolean;
  gap?: number;
};

/** What the graph draws: commits, branch tips, HEAD and the uncommitted work on it. */
export type Repo = {
  nodes: Map<string, Node>;
  /** Branch → commit of its local copy, and of its origin copy. */
  local: Map<string, string>;
  remote: Map<string, string>;
  /** Checked-out branch; null when HEAD is detached. */
  head: string | null;
  headSha: string | null;
  /** Files with uncommitted changes in the main checkout; -1: some, how many unknown (a preview). */
  wip: number;
  /** Commit a preview's stash was made on. */
  stash: string | null;
  /** Branches (`l:<name>`) and tags (`t:<name>`) a preview made up: shown dashed. */
  made: Set<string>;
};

/** Name a preview gives the branch it creates: no real branch can be called that (spaces). */
export const NEW_BRANCH = "new branch";
const NEW_TAG = "new tag";

export function repoOf(view: GraphView, wip: number): Repo {
  const nodes = new Map<string, Node>();
  for (const c of view.commits) nodes.set(c.sha, c);
  // A gap stands in for the parent left out and the run under it, down to the shown commit it leads to.
  for (const g of view.gaps) {
    if (!nodes.has(g.parent)) nodes.set(g.parent, { sha: g.parent, parents: g.join ? [g.join] : [], subject: "", author: "", email: "", date: "", tags: [], gap: g.count });
  }
  const local = new Map<string, string>();
  const remote = new Map<string, string>();
  for (const r of view.refs) (r.remote ? remote : local).set(r.name, r.sha);
  return { nodes, local, remote, head: view.head ?? null, headSha: view.headSha ?? null, wip, stash: null, made: new Set() };
}

// ---------- previews ----------

/** What an action would leave: the repo after it, and how to say it. `noop`: nothing would change. */
export type Preview = { repo: Repo; title: string; note?: string; noop?: boolean; warn?: boolean };

const clone = (r: Repo): Repo => ({ ...r, nodes: new Map(r.nodes), local: new Map(r.local), remote: new Map(r.remote), made: new Set(r.made) });
const tipOf = (r: Repo, b: string) => r.local.get(b) ?? r.remote.get(b);

/** Every commit `from` reaches, itself included, as far as the graph knows. */
function reach(r: Repo, from: string | null | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = from ? [from] : [];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    const n = r.nodes.get(s);
    if (n) for (let i = n.parents.length - 1; i >= 0; i--) stack.push(n.parents[i]);
  }
  return seen;
}

const isAncestor = (r: Repo, a: string, b: string) => reach(r, b).has(a);

/** Commits `tip` has that `base` doesn't, oldest first (parents before children, first parents first): the order a rebase replays them in. */
function own(r: Repo, tip: string, base: string | null | undefined): Node[] {
  const skip = reach(r, base);
  const out: Node[] = [];
  const done = new Set<string>();
  const visit = (s: string) => {
    // Iterative post-order: a long branch would overflow a recursive walk.
    const stack: [string, number][] = [[s, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const n = r.nodes.get(top[0]);
      if (!n || skip.has(top[0]) || (done.has(top[0]) && top[1] === 0)) {
        stack.pop();
        continue;
      }
      if (top[1] < n.parents.length) {
        const p = n.parents[top[1]++];
        if (!done.has(p) && !skip.has(p)) stack.push([p, 0]);
        continue;
      }
      stack.pop();
      if (!done.has(n.sha)) {
        done.add(n.sha);
        out.push(n);
      }
    }
  };
  visit(tip);
  return out;
}

/** Closest commit both reach, by fewest steps from `b`. */
function mergeBase(r: Repo, a: string, b: string): string | null {
  const theirs = reach(r, a);
  const queue = [b];
  const seen = new Set(queue);
  while (queue.length) {
    const s = queue.shift()!;
    if (theirs.has(s)) return s;
    for (const p of r.nodes.get(s)?.parents ?? []) if (!seen.has(p)) seen.add(p), queue.push(p);
  }
  return null;
}

/** Commits counted in `list`, a gap counting for the run it stands for. */
const count = (list: Node[]) => list.reduce((n, c) => n + (c.gap ?? 1), 0);

function add(r: Repo, sha: string, parents: string[], subject: string, like?: Node): string {
  r.nodes.set(sha, { sha, parents, subject, author: like?.author ?? "", email: like?.email ?? "", date: like?.date ?? "", tags: [], sim: true, gap: like?.gap });
  return sha;
}

/** Copies of `list` one on top of the other from `onto`, merges left out (as git rebase does); returns the last one. `key` keeps their names the same from one hover to the next. */
function replay(r: Repo, list: Node[], onto: string, key: string): string {
  let parent = onto;
  for (const c of list) if (c.parents.length < 2) parent = add(r, `sim:${key}:${c.sha}`, [parent], c.subject, c);
  return parent;
}

/** Moves branch `b` to `sha`, HEAD with it when it's the checked-out one. */
function move(r: Repo, b: string, sha: string) {
  r.local.set(b, sha);
  if (r.head === b) r.headSha = sha;
}

function setTag(r: Repo, sha: string, name: string, on: boolean) {
  const n = r.nodes.get(sha);
  if (!n) return;
  r.nodes.set(sha, { ...n, tags: on ? [...n.tags.filter((t) => t !== name), name] : n.tags.filter((t) => t !== name) });
}

const short = (sha: string) => (sha.startsWith("sim:") ? "" : sha.slice(0, 7));

/**
 * The repo once `i` is done, as far as the graph can tell; null when it can't (a branch it needs isn't in the graph).
 * `label` names a branch the way the app shows it (a release by its version).
 */
export function simulate(r: Repo, i: GraphIntent, label: (b: string) => string = (b) => b): Preview | null {
  const out = clone(r);
  const L = label;
  switch (i.kind) {
    case "rebase": {
      const tip = r.local.get(i.branch);
      const onto = tipOf(r, i.onto);
      if (!tip || !onto) return null;
      const title = `Rebase ${L(i.branch)} onto ${L(i.onto)}`;
      if (isAncestor(r, onto, tip)) return { repo: r, title, note: `Already on top of ${L(i.onto)}: nothing to replay`, noop: true };
      const list = own(r, tip, onto).filter((c) => c.parents.length < 2);
      move(out, i.branch, replay(out, list, onto, "rebase"));
      const up = r.remote.get(i.branch);
      const force = up && !isAncestor(out, up, out.local.get(i.branch)!);
      return { repo: out, title, note: `${plural(count(list), "commit")} replayed on top${force ? `; origin keeps the old ones until a force push` : ""}` };
    }
    case "merge": {
      let into = r.local.get(i.into);
      let tip = tipOf(r, i.branch);
      if (!into || !tip) return null;
      const title = `Merge ${L(i.branch)} into ${L(i.into)}`;
      const notes: string[] = [];
      // The engine catches up with origin first, so the merge lands on top of origin's commits.
      const up = r.remote.get(i.into);
      if (up && up !== into && isAncestor(r, into, up)) {
        into = up;
        move(out, i.into, up);
        notes.push(`${L(i.into)} pulled first`);
      }
      if (isAncestor(out, tip, into)) {
        if (!i.deleteBranch) return { repo: r, title, note: `${L(i.into)} already has everything in ${L(i.branch)}`, noop: true };
      } else {
        if (i.squash) {
          const base = mergeBase(out, into, tip);
          const list = own(out, tip, base);
          if (base && count(list) >= 2) {
            tip = add(out, `sim:squash:${i.branch}`, [base], `squash | ${i.branch.replace(/-/g, " ")}`, list[list.length - 1]);
            out.local.set(i.branch, tip);
            notes.push(`${plural(count(list), "commit")} squashed into one`);
          }
        }
        if (i.rebase) {
          const list = own(out, tip, into).filter((c) => c.parents.length < 2);
          const top = isAncestor(out, into, tip) ? tip : replay(out, list, into, "merge");
          out.local.set(i.branch, top);
          move(out, i.into, top);
          notes.push("rebased, then fast-forwarded");
        } else {
          move(out, i.into, add(out, `sim:merge:${i.branch}`, [into, tip], `Merge branch '${i.branch}' into ${i.into}`));
        }
      }
      if (!i.stay && out.head !== i.into) {
        out.head = i.into;
        out.headSha = out.local.get(i.into) ?? out.headSha;
        notes.push(`checks out ${L(i.into)}`);
      }
      if (i.push) {
        out.remote.set(i.into, out.local.get(i.into)!);
        notes.push("pushed");
      }
      if (i.deleteBranch) {
        out.local.delete(i.branch);
        out.remote.delete(i.branch);
        notes.push(`${L(i.branch)} deleted`);
      }
      return { repo: out, title, note: notes.join(", ") || undefined };
    }
    case "sync": {
      const tip = r.local.get(i.branch);
      const from = tipOf(r, i.from);
      if (!tip || !from) return null;
      const title = `Merge ${L(i.from)} into ${L(i.branch)}`;
      if (isAncestor(r, from, tip)) return { repo: r, title, note: `${L(i.branch)} already has everything in ${L(i.from)}`, noop: true };
      move(out, i.branch, add(out, `sim:sync:${i.branch}`, [tip, from], `Merge branch '${i.from}' into ${i.branch}`));
      return { repo: out, title, note: `${plural(count(own(r, from, tip)), "commit")} brought in` };
    }
    case "pull": {
      const tip = r.local.get(i.branch);
      const up = r.remote.get(i.branch);
      const title = `Pull ${L(i.branch)}`;
      if (!up) return null;
      if (tip === up || (tip && isAncestor(r, up, tip))) return { repo: r, title, note: "Nothing new on origin", noop: true };
      if (tip && !isAncestor(r, tip, up)) return { repo: r, title, note: "It and origin both have commits the other lacks: a fast-forward can't take origin's", noop: true, warn: true };
      move(out, i.branch, up);
      return { repo: out, title, note: tip ? `${plural(count(own(r, up, tip)), "commit")} from origin` : undefined };
    }
    case "push": {
      const tip = r.local.get(i.branch);
      if (!tip) return null;
      const up = r.remote.get(i.branch);
      const title = i.force ? `Force push ${L(i.branch)}` : up ? `Push ${L(i.branch)}` : `Publish ${L(i.branch)}`;
      if (up === tip) return { repo: r, title, note: "Origin is up to date", noop: true };
      out.remote.set(i.branch, tip);
      const dropped = up && !isAncestor(r, up, tip) ? count(own(r, up, tip)) : 0;
      if (i.home) {
        out.head = i.home;
        out.headSha = tipOf(out, i.home) ?? out.headSha;
      }
      const sent = up ? count(own(r, tip, up)) : 0;
      return {
        repo: out,
        title,
        note: [sent ? `${plural(sent, "commit")} sent` : "", dropped ? `${plural(dropped, "commit")} only on origin dropped` : "", i.home ? `then checks out ${L(i.home)}` : ""].filter(Boolean).join(", ") || undefined,
        warn: dropped > 0,
      };
    }
    case "reset": {
      const tip = r.local.get(i.branch);
      const up = r.remote.get(i.branch);
      if (!tip || !up) return null;
      move(out, i.branch, up);
      if (r.head === i.branch) out.wip = 0;
      const lost = count(own(r, tip, up));
      return { repo: out, title: `Reset ${L(i.branch)} to origin`, note: lost ? `${plural(lost, "local commit")} dropped` : undefined, warn: lost > 0 };
    }
    case "resetTo": {
      const tip = r.local.get(i.branch);
      if (!tip || !r.nodes.has(i.sha)) return null;
      move(out, i.branch, i.sha);
      const left = count(own(r, tip, i.sha));
      if (r.head === i.branch) out.wip = i.mode === "hard" ? 0 : r.wip || -1;
      const kept = i.mode === "soft" ? "their changes staged" : i.mode === "mixed" ? "their changes in your files" : "their changes thrown away";
      return { repo: out, title: `Reset ${L(i.branch)} to ${short(i.sha)} · ${i.mode}`, note: left ? `${plural(left, "commit")} leave the branch, ${kept}` : undefined, warn: i.mode === "hard" };
    }
    case "tag": {
      const at = i.sha ?? (i.branch ? tipOf(r, i.branch) : undefined);
      if (!at) return null;
      const name = i.name?.trim() || NEW_TAG;
      setTag(out, at, name, true);
      out.made.add(`t:${name}`);
      return { repo: out, title: `Tag ${i.branch ? L(i.branch) : short(at)}`, note: "and push it to origin" };
    }
    case "deleteTag": {
      const at = [...r.nodes.values()].find((n) => n.tags.includes(i.tag));
      if (!at) return null;
      setTag(out, at.sha, i.tag, false);
      return { repo: out, title: `Delete tag ${i.tag}`, note: "here and on origin; its commits stay", warn: true };
    }
    case "create": {
      const at = tipOf(r, i.from);
      if (!at) return null;
      out.local.set(NEW_BRANCH, at);
      out.made.add(`l:${NEW_BRANCH}`);
      return { repo: out, title: `New branch from ${L(i.from)}` };
    }
    case "switch": {
      const at = tipOf(r, i.branch);
      if (!at) return null;
      if (!r.local.has(i.branch)) out.local.set(i.branch, at);
      out.head = i.branch;
      out.headSha = at;
      return { repo: out, title: `Check out ${L(i.branch)}`, note: r.wip ? "uncommitted changes come along" : undefined };
    }
    case "delete": {
      if (!tipOf(r, i.branch)) return null;
      const local = i.local !== false;
      if (local) out.local.delete(i.branch);
      if (i.remote) out.remote.delete(i.branch);
      const where = local && i.remote ? "here and on origin" : i.remote ? "on origin" : "here";
      return { repo: out, title: `Delete ${L(i.branch)}`, note: where, warn: true };
    }
    case "stash": {
      if (!r.wip || !r.headSha) return { repo: r, title: "Stash changes", note: "No uncommitted changes", noop: true };
      out.wip = 0;
      out.stash = r.headSha;
      return { repo: out, title: "Stash changes", note: r.wip > 0 ? `${plural(r.wip, "file")} set aside` : undefined };
    }
    case "unstash": {
      out.wip = r.wip || -1;
      return { repo: out, title: "Pop latest stash", note: "its changes come back as uncommitted work" };
    }
    case "commit": {
      const tip = r.local.get(i.branch);
      if (!tip) return null;
      const c = add(out, `sim:commit:${i.branch}`, [tip], i.message?.split("\n")[0] || "AI writes the message");
      move(out, i.branch, c);
      if (r.head === i.branch) out.wip = i.all ? 0 : r.wip;
      if (i.push) out.remote.set(i.branch, c);
      return { repo: out, title: `Commit on ${L(i.branch)}`, note: i.push ? "then pushed" : undefined };
    }
    case "revert": {
      const tip = r.local.get(i.branch);
      const n = r.nodes.get(i.sha);
      if (!tip || !n) return null;
      move(out, i.branch, add(out, `sim:revert:${i.sha}`, [tip], `Revert "${n.subject}"`));
      return { repo: out, title: `Revert ${short(i.sha)}`, note: `a new commit on ${L(i.branch)} undoes it` };
    }
    case "cherryPick": {
      const tip = r.local.get(i.onto);
      const n = r.nodes.get(i.sha);
      if (!tip || !n) return null;
      move(out, i.onto, add(out, `sim:pick:${i.sha}`, [tip], n.subject, n));
      return { repo: out, title: `Cherry-pick ${short(i.sha)} onto ${L(i.onto)}` };
    }
    case "ship": {
      let tip = r.local.get(i.release);
      if (!tip || !r.local.get(i.into)) return null;
      if (i.changelog) {
        tip = add(out, `sim:ship:${i.release}`, [tip], `docs(changelog): release ${i.version}`);
        out.local.set(i.release, tip);
      }
      move(out, i.into, tip);
      const tag = `v${i.version}`;
      setTag(out, tip, tag, true);
      out.made.add(`t:${tag}`);
      if (i.push) out.remote.set(i.into, tip);
      return { repo: out, title: `Ship v${i.version}`, note: `${L(i.into)} fast-forwarded and tagged${i.push ? ", then pushed" : ""}` };
    }
    case "changelog": {
      const tip = r.local.get(i.branch);
      if (!tip) return null;
      move(out, i.branch, add(out, `sim:changelog:${i.branch}`, [tip], i.what));
      return { repo: out, title: i.what, note: `committed on ${L(i.branch)}` };
    }
  }
}

// ---------- layout ----------

/** Who comes first and where: branches by lane (left to right), the ones whose rows go first, folds opened, colors. */
export type Focus = {
  /** Branches in lane order, left to right: trunks first. */
  lanes: string[];
  /** Branches whose commits are listed first, in order: the selected one first. */
  first: string[];
  /** Folded runs the user opened, by fold key. */
  open: Set<string>;
  /** Commit kept out of folds (the one picked). */
  keep?: string;
  /** Lane color of a branch's line, a CSS color. */
  color: (branch: string) => string;
  label: (branch: string) => string;
};

export type GLabel = {
  key: string;
  text: string;
  branch?: string;
  tag?: string;
  /** A branch label: the local copy is here, origin's copy is here. */
  local?: boolean;
  remote?: boolean;
  /** The checked-out branch, or HEAD itself when detached. */
  head?: boolean;
  /** Made up by a preview. */
  made?: boolean;
  /** Its branch's lane color. */
  color?: string;
};

export type GRow = {
  key: string;
  kind: "commit" | "gap" | "fold" | "wip" | "stash";
  node?: Node;
  row: number;
  lane: number;
  color: string;
  labels: GLabel[];
  /** Branch whose line it is on (undefined: a line no shown branch starts). */
  branch?: string;
  line: number;
  /** A fold: the commits it hides. */
  hidden?: Node[];
  merge?: boolean;
  /** The commit HEAD is on. */
  head?: boolean;
};

/** A piece of line: a rail runs down one lane, an elbow bends from one lane to another over one row; units are lanes and rows. */
export type GPiece =
  | { key: string; kind: "rail"; x: number; y1: number; y2: number; color: string; line: number; dashed?: boolean }
  | { key: string; kind: "elbow"; x: number; y: number; dx: number; color: string; line: number; dashed?: boolean }
  | { key: string; kind: "stub"; x: number; y: number; dx: number; color: string; line: number };

export type Layout = { rows: GRow[]; pieces: GPiece[]; lanes: number; lineBranch: (string | undefined)[] };

/** A run of plain commits on one line longer than this folds, keeping its first FOLD_KEEP_TOP and last FOLD_KEEP_BOTTOM. */
const FOLD_OVER = 5;
const FOLD_KEEP_TOP = 2;
const FOLD_KEEP_BOTTOM = 1;
/** Line colors for lines no shown branch starts (merged side branches). */
const SIDE_COLORS = ["var(--mod-fg)", "var(--prop-fg)", "var(--add-fg)", "var(--del-fg)", "var(--warn-fg)"];

type Line = { id: number; branch?: string; remote?: boolean; rank: number; members: string[]; color: string };

export function layout(repo: Repo, focus: Focus): Layout {
  const { nodes } = repo;
  // What shows: everything a tip, HEAD or a preview's stash reaches.
  const tips = [...repo.local.values(), ...repo.remote.values(), ...(repo.headSha ? [repo.headSha] : []), ...(repo.stash ? [repo.stash] : [])];
  const vis = new Set<string>();
  for (const t of tips) for (const s of reach(repo, t)) if (nodes.has(s)) vis.add(s);
  const shown = (s: string) => vis.has(s);

  // Lines: first-parent runs from each tip, in lane order, each taking the commits no earlier line took.
  const lineOf = new Map<string, number>();
  const lines: Line[] = [];
  const firstRank = (b: string) => {
    const i = focus.first.indexOf(b);
    return i >= 0 ? i : focus.first.length + 1 + Math.max(0, focus.lanes.indexOf(b));
  };
  const start = (tip: string | undefined, meta: Omit<Line, "id" | "members">) => {
    if (!tip || !shown(tip) || lineOf.has(tip)) return;
    const l: Line = { id: lines.length, members: [], ...meta };
    for (let s: string | undefined = tip; s && shown(s) && !lineOf.has(s); s = nodes.get(s)?.parents[0]) {
      lineOf.set(s, l.id);
      l.members.push(s);
    }
    lines.push(l);
  };
  const named = [...focus.lanes, ...[...repo.local.keys(), ...repo.remote.keys()].filter((b) => !focus.lanes.includes(b))];
  for (const b of named) {
    const color = focus.color(b);
    start(repo.local.get(b), { branch: b, rank: firstRank(b), color });
    start(repo.remote.get(b), { branch: b, remote: true, rank: firstRank(b) + 0.5, color });
  }
  start(repo.headSha ?? undefined, { rank: firstRank(repo.head ?? ""), color: "var(--fg)" });
  start(repo.stash ?? undefined, { rank: -1, color: "var(--muted)" });
  // Side branches merged in: newest first, each line from its newest commit down.
  const rest = [...vis].filter((s) => !lineOf.has(s)).sort((a, b) => (nodes.get(b)!.date || "").localeCompare(nodes.get(a)!.date || ""));
  // Their color comes from their newest commit, so it stays the same from one preview to the next.
  for (const s of rest) start(s, { rank: -0.5, color: SIDE_COLORS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % SIDE_COLORS.length] });

  // Rows: children before parents; among the commits ready, the earliest-ranked line goes first, then the newest.
  const kids = new Map<string, number>();
  for (const s of vis) for (const p of nodes.get(s)!.parents) if (shown(p)) kids.set(p, (kids.get(p) ?? 0) + 1);
  const ready = [...vis].filter((s) => !kids.get(s));
  const rank = (s: string) => lines[lineOf.get(s)!].rank;
  const before = (a: string, b: string) => rank(a) - rank(b) || (nodes.get(b)!.date || "").localeCompare(nodes.get(a)!.date || "") || (a < b ? -1 : 1);
  const order: string[] = [];
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (before(ready[i], ready[best]) < 0) best = i;
    const s = ready.splice(best, 1)[0];
    order.push(s);
    for (const p of nodes.get(s)!.parents) {
      if (!shown(p)) continue;
      const k = kids.get(p)! - 1;
      kids.set(p, k);
      if (k === 0) ready.push(p);
    }
  }

  // Labels: branch tips (one label when the local and origin copies agree), HEAD when detached, tags.
  const labels = new Map<string, GLabel[]>();
  const put = (sha: string, l: GLabel) => labels.set(sha, [...(labels.get(sha) ?? []), l]);
  for (const [b, sha] of repo.local) put(sha, { key: `l:${b}`, text: focus.label(b), branch: b, local: true, remote: repo.remote.get(b) === sha, head: repo.head === b, made: repo.made.has(`l:${b}`), color: focus.color(b) });
  for (const [b, sha] of repo.remote) if (repo.local.get(b) !== sha) put(sha, { key: `r:${b}`, text: focus.label(b), branch: b, remote: true, color: focus.color(b) });
  if (!repo.head && repo.headSha) put(repo.headSha, { key: "HEAD", text: "HEAD", head: true });
  const tagLabels = (n: Node): GLabel[] => n.tags.map((t) => ({ key: `t:${t}`, text: t, tag: t, made: repo.made.has(`t:${t}`) }));

  // Folds: a long run of plain commits on one line, one after the other, shows its ends and a count.
  const childCount = new Map<string, number>();
  for (const s of vis) for (const p of nodes.get(s)!.parents) if (shown(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  const plain = (s: string) => {
    const n = nodes.get(s)!;
    return !n.gap && n.parents.length === 1 && (childCount.get(s) ?? 0) <= 1 && !labels.has(s) && !n.tags.length && s !== focus.keep && s !== repo.headSha && s !== repo.stash;
  };
  type Item = { kind: GRow["kind"]; sha?: string; key: string; hidden?: Node[] };
  const items: Item[] = [];
  if (repo.wip && repo.headSha && shown(repo.headSha)) items.push({ kind: "wip", key: "wip" });
  if (repo.stash && shown(repo.stash)) items.push({ kind: "stash", key: "stash" });
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && plain(order[j]) && lineOf.get(order[j]) === lineOf.get(order[i]) && (j === i || nodes.get(order[j - 1])!.parents[0] === order[j])) j++;
    if (j === i) {
      const s = order[i++];
      items.push({ kind: nodes.get(s)!.gap ? "gap" : "commit", sha: s, key: s });
      continue;
    }
    const run = order.slice(i, j);
    i = j;
    if (run.length <= FOLD_OVER || focus.open.has(`fold:${run[FOLD_KEEP_TOP]}`)) {
      for (const s of run) items.push({ kind: "commit", sha: s, key: s });
      continue;
    }
    for (const s of run.slice(0, FOLD_KEEP_TOP)) items.push({ kind: "commit", sha: s, key: s });
    const hid = run.slice(FOLD_KEEP_TOP, run.length - FOLD_KEEP_BOTTOM);
    items.push({ kind: "fold", key: `fold:${hid[0]}`, sha: hid[0], hidden: hid.map((s) => nodes.get(s)!) });
    for (const s of run.slice(run.length - FOLD_KEEP_BOTTOM)) items.push({ kind: "commit", sha: s, key: s });
  }

  // Each shown commit's row; a folded one's is its fold's.
  const rowOf = new Map<string, number>();
  items.forEach((it, row) => {
    if (it.sha) rowOf.set(it.sha, row);
    for (const n of it.hidden ?? []) rowOf.set(n.sha, row);
  });
  const lineOfItem = (it: Item) => (it.kind === "wip" ? lineOf.get(repo.headSha!) : it.kind === "stash" ? lineOf.get(repo.stash!) : lineOf.get(it.sha!))!;
  // Edges as rows show them: a fold stands for its commits, WIP and the stash hang off their commit.
  type Edge = { from: number; to: number; first: boolean; sha?: string; dashed?: boolean };
  const edges: Edge[] = [];
  items.forEach((it, row) => {
    if (it.kind === "wip") return edges.push({ from: row, to: rowOf.get(repo.headSha!)!, first: true, dashed: true });
    if (it.kind === "stash") return edges.push({ from: row, to: rowOf.get(repo.stash!)!, first: true, dashed: true });
    const n = it.kind === "fold" ? it.hidden![it.hidden!.length - 1] : nodes.get(it.sha!)!;
    // A gap's edge stands for the history left out: dashed.
    n.parents.forEach((p, k) => edges.push({ from: row, to: shown(p) ? rowOf.get(p)! : -1, first: k === 0, sha: p, dashed: !!n.gap }));
  });
  // The rows' own line; WIP and the stash take their commit's line when they can sit on top of it.
  const itemLine = items.map(lineOfItem);

  // Lanes: each line holds one from its first commit's row to its last's, and further where its edges run in it: down to
  // halfway into the bend into its parent's lane, up to halfway out of the bend a merge into it starts with. In half rows,
  // so a line forking off just above a merge's bend can share the lane with the side branch that bend leads to.
  const span = lines.map(() => ({ top: Infinity, bottom: -Infinity }));
  items.forEach((_, row) => {
    const s = span[itemLine[row]];
    s.top = Math.min(s.top, row);
    s.bottom = Math.max(s.bottom, row);
  });
  for (const e of edges) {
    if (e.to < 0) continue;
    const a = itemLine[e.from];
    const b = itemLine[e.to];
    if (a === b) continue;
    if (e.first) span[a].bottom = Math.max(span[a].bottom, e.to - 0.5);
    else span[b].top = Math.min(span[b].top, e.from + 0.5);
  }
  // Each shown branch keeps a lane of its own, in lane order, so it stays put whatever a preview does around it; its origin
  // copy shares it where they don't meet. Side branches merged in go right of those, each in the first lane free where it runs.
  const taken: { top: number; bottom: number }[][] = [];
  const laneOf = new Map<number, number>();
  const free = (lane: number, s: { top: number; bottom: number }) => !taken[lane]?.some((t) => t.top <= s.bottom && s.top <= t.bottom);
  const hold = (l: Line, lane: number) => {
    (taken[lane] ??= []).push(span[l.id]);
    laneOf.set(l.id, lane);
  };
  const laid = lines.filter((l) => span[l.id].top !== Infinity);
  const branchLane = new Map<string, number>();
  for (const l of laid.filter((l) => l.branch !== undefined)) {
    const own = branchLane.get(l.branch!);
    const lane = own !== undefined && free(own, span[l.id]) ? own : taken.length;
    if (own === undefined) branchLane.set(l.branch!, lane);
    hold(l, lane);
  }
  const sides = taken.length;
  for (const l of laid.filter((l) => l.branch === undefined).sort((a, b) => span[a.id].top - span[b.id].top)) {
    let lane = sides;
    while (!free(lane, span[l.id])) lane++;
    hold(l, lane);
  }

  // Pieces: a rail down a lane; a fork runs down its own lane and bends into its parent's at the end, a merge bends out at the start.
  const pieces: GPiece[] = [];
  for (const e of edges) {
    const a = itemLine[e.from];
    const xa = laneOf.get(a)!;
    const from = items[e.from].key;
    const key = `${from}>${e.to < 0 ? e.sha : items[e.to].key}`;
    if (e.to < 0) {
      pieces.push({ key: `${key}:s`, kind: "stub", x: xa, y: e.from, dx: e.first ? 0 : 1, color: lines[a].color, line: a });
      continue;
    }
    const b = itemLine[e.to];
    const xb = laneOf.get(b)!;
    if (a === b || xa === xb) {
      pieces.push({ key: `${key}:r`, kind: "rail", x: xa, y1: e.from, y2: e.to, color: lines[a].color, line: a, dashed: e.dashed });
    } else if (e.first) {
      if (e.to - e.from > 1) pieces.push({ key: `${key}:r`, kind: "rail", x: xa, y1: e.from, y2: e.to - 1, color: lines[a].color, line: a, dashed: e.dashed });
      pieces.push({ key: `${key}:b${xb - xa}`, kind: "elbow", x: xa, y: e.to - 1, dx: xb - xa, color: lines[a].color, line: a, dashed: e.dashed });
    } else {
      pieces.push({ key: `${key}:a${xb - xa}`, kind: "elbow", x: xa, y: e.from, dx: xb - xa, color: lines[b].color, line: b });
      if (e.to - e.from > 1) pieces.push({ key: `${key}:r`, kind: "rail", x: xb, y1: e.from + 1, y2: e.to, color: lines[b].color, line: b });
    }
  }

  const rows: GRow[] = items.map((it, row) => {
    const line = itemLine[row];
    const node = it.kind === "fold" ? undefined : it.sha ? nodes.get(it.sha) : undefined;
    return {
      key: it.key,
      kind: it.kind,
      node,
      row,
      lane: laneOf.get(line) ?? 0,
      color: lines[line].color,
      labels: node ? [...(labels.get(node.sha) ?? []), ...tagLabels(node)] : [],
      branch: lines[line].branch,
      line,
      hidden: it.hidden,
      merge: (node?.parents.length ?? 0) > 1,
      head: !!node && node.sha === repo.headSha,
    };
  });
  return { rows, pieces, lanes: Math.max(1, taken.length), lineBranch: lines.map((l) => l.branch) };
}

/** Whether branch `b`, its local copy or its origin one, holds `sha`. */
export const holds = (repo: Repo, b: string, sha: string) => [repo.local.get(b), repo.remote.get(b)].some((t) => !!t && reach(repo, t).has(sha));

/** Which branch a commit is best opened in: the first of `branches` holding it that its base doesn't (its commit list lists it). */
export function ownerOf(repo: Repo, sha: string, branches: string[], baseOf: (b: string) => string): string | undefined {
  for (const b of branches) {
    if (!holds(repo, b, sha)) continue;
    const base = baseOf(b);
    if (!base || base === b || !holds(repo, base, sha)) return b;
  }
  return branches.find((b) => holds(repo, b, sha));
}

/** Commits `tip` has past `sha` (newer), and the ones of those on no origin copy: what a reset to `sha` drops and could lose. */
export function above(repo: Repo, tip: string, sha: string): { dropped: Node[]; unpushed: Node[] } {
  const dropped = own(repo, tip, sha).reverse();
  const onOrigin = new Set<string>();
  for (const r of repo.remote.values()) for (const s of reach(repo, r)) onOrigin.add(s);
  return { dropped, unpushed: dropped.filter((n) => !onOrigin.has(n.sha)) };
}

export { reach as reachable, tipOf };
