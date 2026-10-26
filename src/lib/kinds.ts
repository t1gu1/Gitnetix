/** Branch types offered when creating a feature/fix. `id` is the branch prefix (`feat/login`). */
export const KINDS = [
  { id: "feat", label: "Feature", noun: "feature", aliases: ["feature", "features"] },
  { id: "fix", label: "Fix", noun: "fix", aliases: ["bugfix", "bug", "hotfix"] },
  { id: "refactor", label: "Refactor", noun: "refactor", aliases: ["refacto", "refractor"] },
  { id: "perf", label: "Perf", noun: "perf change", aliases: ["performance"] },
  { id: "style", label: "Style", noun: "style change", aliases: ["styles"] },
  { id: "test", label: "Test", noun: "test", aliases: ["tests"] },
  { id: "docs", label: "Docs", noun: "docs change", aliases: ["doc"] },
  { id: "chore", label: "Chore", noun: "chore", aliases: [] },
  { id: "ci", label: "CI", noun: "CI change", aliases: [] },
  { id: "a11y", label: "A11y", noun: "a11y change", aliases: ["accessibility"] },
  { id: "build", label: "Build", noun: "build change", aliases: ["deps"] },
  { id: "poc", label: "POC", noun: "POC", aliases: ["spike"] },
] as const;

export type Kind = (typeof KINDS)[number]["id"];

/** Maps a prefix like `feature` or `Feat` to its kind, or null when it is not a known type. */
export function kindOf(prefix: string): Kind | null {
  const p = prefix.trim().toLowerCase();
  const k = KINDS.find((k) => k.id === p || (k.aliases as readonly string[]).includes(p));
  return k ? k.id : null;
}

/** Kind implied by a branch name's prefix (`feature/x` → feat), or null. */
export function kindOfBranch(name: string): Kind | null {
  const i = name.indexOf("/");
  return i > 0 ? kindOf(name.slice(0, i)) : null;
}

/** Keeps a prefix the user typed (`feature/x`, `wip/x`); otherwise prefixes with the chosen kind. */
export function withPrefix(name: string, kind: Kind): string {
  const n = name.trim();
  if (!n) return "";
  return n.includes("/") ? n : `${kind}/${n}`;
}

/**
 * Starts the part after the prefix with the ticket key and an underscore (`feat/ATL-212_login`); a key already there is not repeated.
 * Preview of the backend's `with_ticket`, which applies it again on create: keep the two in step.
 */
export function withTicket(branch: string, ticket: string): string {
  const t = ticket.trim().replace(/\s/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[-_.]+|[-_.]+$/g, "");
  if (!branch || !t) return branch;
  const i = branch.indexOf("/") + 1;
  let rest = branch.slice(i);
  if (rest.toLowerCase() === t.toLowerCase()) return `${branch.slice(0, i)}${t}`;
  if (rest.toLowerCase().startsWith(t.toLowerCase()) && /^[-_]/.test(rest.slice(t.length))) rest = rest.slice(t.length + 1);
  return `${branch.slice(0, i)}${t}_${rest}`;
}

export const kindNoun = (k: string) => KINDS.find((x) => x.id === k)?.noun ?? "item";
