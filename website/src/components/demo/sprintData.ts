import type { DoneTicket, SprintStat, SprintTicket, Stage, TicketCode, WeeklyReport, Work } from '../../../../src/api/types';
import { rank } from './charts';

/**
 * Made-up tracker history for the analytics demo: a Jira board whose last sprint is running, and the tickets done
 * each week in Jira, Trello, Asana and GitHub. Seeded by date, so the same day shows the same numbers; the running
 * sprint is always between its 4th and 8th working day, so the calendar moves on by a week each Thursday. Every
 * figure is counted from the tickets, as the backend counts them.
 */

/** A seeded generator (mulberry32): the same seed, the same numbers. */
export function rng(seed: string) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 1);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = ReturnType<typeof rng>;
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const dow = (date: string) => new Date(`${date}T12:00:00`).getDay();
const isWeekend = (date: string) => dow(date) === 0 || dow(date) === 6;
/** Monday of the week holding `date`. */
export const mondayOf = (date: string) => addDays(date, -((dow(date) + 6) % 7));
const HOUR = 3_600_000;
const ts = (date: string, hour: number) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
const half = (v: number) => Math.round(v * 2) / 2;
const pick = <T,>(r: Rand, list: readonly T[]) => list[Math.floor(r() * list.length)];

/** Who the WEB board's tickets go to, the first most. */
const TEAM = ['Grace Hopper', 'Ana Moreau', 'Jules Laurent', 'Riya Kapoor', 'Tom Becker'];
const SHARE = [0.26, 0.22, 0.2, 0.18, 0.14];
function assignee(r: Rand) {
  if (r() < 0.04) return 'Unassigned';
  let x = r();
  for (let i = 0; i < TEAM.length; i++) if ((x -= SHARE[i]) < 0) return TEAM[i];
  return TEAM[0];
}

type Kind = 'Story' | 'Bug' | 'Task';
/** [type, title, Jira label] */
const POOL: [Kind, string, string][] = [
  ['Story', 'Group branches by release', 'tree'], ['Bug', 'Diff scroll jumps on reload', 'diff'], ['Story', 'Show stashes next to their branch', 'tree'],
  ['Task', 'Bump Tauri to the latest patch', 'chore'], ['Story', 'Search the commit list', 'commits'], ['Bug', 'Ahead count wrong after a squash merge', 'git'],
  ['Story', 'Keyboard shortcuts for the branch tree', 'tree'], ['Story', 'Preview images in the diff', 'diff'], ['Bug', 'Worktree paths with spaces fail', 'worktrees'],
  ['Story', 'Pin projects on the welcome screen', 'ux'], ['Task', 'Record a demo video for the site', 'website'], ['Story', 'Export release notes as Markdown', 'release'],
  ['Bug', 'Tags from other clones are missing', 'git'], ['Story', 'Fold runs of commits into one row', 'tree'], ['Story', 'Show CI checks on pull requests', 'pull-requests'],
  ['Bug', 'Commit box loses focus after amend', 'commits'], ['Task', 'Write release notes for 0.5.x', 'release'], ['Story', 'Draft release notes from merged branches', 'release'],
  ['Story', 'Undo the last commit from the menu', 'commits'], ['Bug', 'Avatar colors change between sessions', 'ux'], ['Story', 'Show who reviewed a pull request', 'pull-requests'],
  ['Task', 'Remove the old settings screen', 'chore'], ['Story', 'Open a terminal in the worktree', 'worktrees'], ['Bug', 'Long branch names push the actions out', 'tree'],
  ['Story', 'Mark branches whose ticket is done', 'tree'], ['Story', 'Suggest a branch name from the ticket', 'agents'], ['Bug', 'Fetch hangs when origin is offline', 'git'],
  ['Task', 'Add tests for the branch tree', 'tree'], ['Story', 'Copy a commit link', 'commits'], ['Story', 'Show the agent cost per session', 'agents'],
  ['Bug', 'Release notes skip reverted commits', 'release'], ['Story', 'Filter pull requests by label', 'pull-requests'], ['Task', 'Profile the startup time', 'performance'],
  ['Story', 'Resize the diff and file panes', 'diff'], ['Bug', 'Search misses commits on folded rows', 'commits'], ['Story', 'Remember the last tab per project', 'ux'],
  ['Story', 'Compare two branches side by side', 'diff'], ['Bug', 'Agent log stops at 1,000 lines', 'agents'], ['Task', 'Update the screenshots in the README', 'website'],
  ['Story', 'Cherry-pick a commit onto a release', 'git'], ['Bug', 'Stash list empty after a rebase', 'git'], ['Story', 'Show submodule changes in the diff', 'diff'],
  ['Story', 'Ask AI for a commit message', 'agents'], ['Task', 'Clean up unused CSS', 'chore'], ['Bug', 'Pull request reviews show twice', 'pull-requests'],
  ['Story', 'Tag a release from the tree', 'release'], ['Story', 'Show conflicts before merging', 'git'], ['Bug', 'Window flickers when switching projects', 'performance'],
  ['Story', 'Sign commits with SSH keys', 'git'], ['Task', 'Move CI to a bigger runner', 'chore'], ['Story', 'Notify when an agent finishes', 'agents'],
  ['Bug', 'Ctrl+F opens the browser find bar', 'ux'], ['Story', 'Drag a branch onto another to rebase', 'tree'],
];
/** The pool in a seeded order, so tickets with keys in a row get unrelated titles and types. */
const ORDER = (() => {
  const r = rng('pool');
  const o = POOL.map((_, i) => i);
  for (let i = o.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [o[i], o[j]] = [o[j], o[i]];
  }
  return o;
})();
const LABEL: Record<SprintTicket['status'], string> = { todo: 'To Do', progress: 'In Progress', review: 'In Review', ready: 'Ready to merge', done: 'Done' };
const SPRINTS = 13;
const GOALS = ['Ship 0.6.0: the branch tree path and stale remote cleanup', '', 'Agents stream their steps', 'Release notes from merged branches', '', 'Pull request reviews in the app'];

/** A sprint ticket and what the counts need on top: the day it joined the sprint, when it was created, its label. */
type Raw = SprintTicket & { addedOn: string | null; created: number; label: string };
type RawSprint = Omit<SprintStat, 'committed' | 'completed' | 'scopeStart' | 'added' | 'carried' | 'leftEstimate' | 'leftRemaining' | 'bugs' | 'bugsFixed' | 'cancelled' | 'noPoints' | 'noEstimate' | 'unassigned' | 'status' | 'cycleMedian' | 'cycleP85' | 'people' | 'kinds' | 'burndown' | 'tickets'> & { tickets: Raw[] };

/** The working days of a two-week sprint starting on Monday `start`. */
const workdates = (start: string) => [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map((n) => addDays(start, n));

/** Splits `hours` after the start over the statuses a ticket went through, review and ready only once it got there. */
function stages(r: Rand, hours: number, upTo: SprintTicket['status']): Partial<Record<Stage, number>> {
  const reached = ['progress', 'review', 'ready', 'done'].indexOf(upTo);
  const w: [Stage, number][] = [
    ['progress', 0.5 + r() * 0.3],
    ['review', reached >= 1 ? 0.12 + r() * 0.18 : 0],
    ['ready', reached >= 2 ? 0.04 + r() * 0.08 : 0],
    ['waiting', r() < 0.35 ? 0.08 + r() * 0.3 : 0],
    ['todo', r() < 0.1 ? 0.05 + r() * 0.1 : 0],
  ];
  const sum = w.reduce((a, [, v]) => a + v, 0);
  return Object.fromEntries(w.filter(([, v]) => v > 0).map(([k, v]) => [k, (v / sum) * hours]));
}

/** The commits and branch about `t`, made between its start and `until`. */
function code(r: Rand, t: Raw, until: number, project: string): TicketCode | undefined {
  if (!t.startedAt) return undefined;
  const from = Date.parse(t.startedAt);
  const branch = `${t.bug ? 'fix' : t.kind === 'Task' ? 'chore' : 'feat'}/${t.key}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').slice(0, 3).join('-')}`;
  const type = t.bug ? 'fix' : t.kind === 'Task' ? 'chore' : 'feat';
  const subjects = [`${type}(${t.label}): ${t.title[0].toLowerCase()}${t.title.slice(1)}`, `test(${t.label}): cover ${t.key}`, `${type}(${t.label}): review fixes`];
  const n = 1 + Math.floor(r() * 3);
  const commits = Array.from({ length: n }, (_, i) => {
    const at = from + ((until - from) * (n - i)) / (n + 1);
    return { sha: Math.floor(r() * 0xfffffff).toString(16).padStart(7, '0'), date: new Date(at).toISOString(), author: t.assignee === 'Unassigned' ? TEAM[0] : t.assignee, subject: subjects[i], branch, project, projectId: project };
  });
  return { commits, branches: [{ name: branch, project, projectId: project, live: !t.completed }] };
}

/** Sprint 14's tickets, the ones on the demo's Tickets page, as they stand there. */
function fixed(start: string, now: number): Raw[] {
  const days = workdates(start);
  const started = (n: number) => new Date(Math.max(ts(start, 9), now - n * 24 * HOUR)).toISOString();
  const web = (o: Partial<Raw> & Pick<Raw, 'key' | 'title' | 'kind' | 'assignee' | 'status' | 'label'>): Raw => ({
    url: `https://acme.atlassian.net/browse/${o.key}`, bug: o.kind === 'Bug', statusLabel: LABEL[o.status], completed: false, cancelled: false, carried: false, moved: false, added: false,
    points: null, estimate: null, remaining: null, doneAt: null, startedAt: null, cycleHours: null, ageHours: null, stages: {}, addedOn: null, created: ts(start, 9) - 6 * 24 * HOUR, ...o,
  });
  const tree = started(3);
  const stale = started(2);
  return [
    web({
      key: 'WEB-212', kind: 'Story', title: 'Animate the path to the checked-out branch', status: 'progress', assignee: 'Grace Hopper', label: 'tree', points: 3, estimate: 8, remaining: 3,
      startedAt: tree, ageHours: (now - Date.parse(tree)) / HOUR, stages: { progress: (now - Date.parse(tree)) / HOUR },
      code: {
        commits: [
          ['7f3a2c8', 'Draw the path from the trunk to the checked-out branch', 2], ['2c9e4b1', 'Measure rows with layout offsets, not client rects', 5],
          ['e5b8d03', 'Add usePath', 26], ['8a1f6e7', 'Style the dotted path line', 30],
        ].map(([sha, subject, h]) => ({ sha: String(sha), subject: String(subject), date: new Date(now - Number(h) * HOUR).toISOString(), author: 'Grace Hopper', branch: 'feat/branch-tree', project: 'acme-web', projectId: 'acme-web' })),
        branches: [{ name: 'feat/branch-tree', project: 'acme-web', projectId: 'acme-web', live: true }],
      },
    }),
    web({
      key: 'WEB-218', kind: 'Bug', title: 'Branches deleted on origin stay in the tree', status: 'review', assignee: 'Jules Laurent', label: 'git', points: 1, estimate: 4, remaining: 2,
      startedAt: stale, ageHours: (now - Date.parse(stale)) / HOUR, stages: { progress: ((now - Date.parse(stale)) / HOUR) * 0.8, review: ((now - Date.parse(stale)) / HOUR) * 0.2 },
      code: {
        commits: [['3d7c9a2', 'Test pruning of stale remote refs', 1], ['b6e2f15', 'Drop remote refs that are gone on fetch', 3]].map(([sha, subject, h]) => ({ sha: String(sha), subject: String(subject), date: new Date(now - Number(h) * HOUR).toISOString(), author: 'Jules Laurent', branch: 'fix/stale-remote', project: 'acme-web', projectId: 'acme-web' })),
        branches: [{ name: 'fix/stale-remote', project: 'acme-web', projectId: 'acme-web', live: true }],
      },
    }),
    web({ key: 'WEB-221', kind: 'Story', title: 'Stream agent steps in the workspace', status: 'todo', assignee: 'Riya Kapoor', label: 'agents', points: 3, estimate: 16, remaining: 16, code: { commits: [], branches: [{ name: 'feat/agent-pane', project: 'acme-web', projectId: 'acme-web', live: true }] } }),
    web({ key: 'WEB-224', kind: 'Story', title: 'Filter branches by author', status: 'todo', assignee: 'Grace Hopper', label: 'tree', points: 2, estimate: 8, remaining: 8 }),
    web({ key: 'WEB-227', kind: 'Bug', title: 'Commit box loses its draft when switching branch', status: 'todo', assignee: 'Grace Hopper', label: 'commits', points: 1, estimate: 4, remaining: 4, added: true, addedOn: days[1], created: ts(days[1], 10) }),
    web({
      key: 'WEB-205', kind: 'Task', title: 'Date the changelog when a release ships', status: 'done', assignee: 'Grace Hopper', label: 'release', points: 1, estimate: 2, remaining: 0, completed: true,
      doneAt: days[0], startedAt: new Date(ts(days[0], 9)).toISOString(), cycleHours: 6, stages: { progress: 4.5, review: 1.5 },
      code: { commits: [{ sha: 'a4e1c90', subject: 'Update changelog for 0.6.0', date: new Date(ts(days[0], 14)).toISOString(), author: 'Grace Hopper', branch: 'release/0.6.0', project: 'acme-web', projectId: 'acme-web' }], branches: [] },
    }),
  ];
}

/** The board's sprints, oldest first; the last one runs today. */
function build(now: string): RawSprint[] {
  const nowTs = Date.now();
  const mon = mondayOf(now);
  // Monday to Wednesday: the sprint's second week, else its first; so the running one is past its first days.
  const last = (dow(now) + 6) % 7 <= 2 ? addDays(mon, -7) : mon;
  const starts = Array.from({ length: SPRINTS }, (_, i) => addDays(last, -14 * (SPRINTS - 1 - i)));
  const out: RawSprint[] = [];
  let carry: Raw[] = [];
  let next = 30;
  starts.forEach((start, i) => {
    const active = i === SPRINTS - 1;
    const r = rng(`sprint:${start}`);
    const days = workdates(start);
    const end = days[9];
    const done = active ? days.filter((d) => d <= now).length : 10;
    const until = active ? nowTs : ts(end, 18);
    // How the sprint went: one in four falls short.
    const form = active ? 0.9 : [0.9, 0.84, 0.66, 0.95, 0.88, 0.62, 0.92, 0.8, 0.94, 0.76, 0.9, 0.86][i % 12];
    const keys = active ? [201, 203, 204, 206, 208, 210, 213, 214, 216, 219] : Array.from({ length: 11 + Math.floor(r() * 4) }, () => next++);
    const made: Raw[] = keys.map((k) => {
      const [kind, title, label] = POOL[ORDER[k % POOL.length]];
      const points = r() < 0.08 ? null : pick(r, kind === 'Task' ? [1, 2, 3] : kind === 'Bug' ? [1, 2, 3, 5] : [2, 3, 5, 8]);
      const estimate = r() < 0.1 ? null : half(points ? points * (2.5 + r() * 2) : 2 + r() * 10);
      const added = r() < 0.12;
      const addedOn = added ? days[1 + Math.floor(r() * 5)] : null;
      return {
        key: `WEB-${k}`, title, url: `https://acme.atlassian.net/browse/WEB-${k}`, kind, bug: kind === 'Bug', assignee: assignee(r), status: 'todo', statusLabel: LABEL.todo,
        completed: false, cancelled: !active && r() < 0.03, carried: false, moved: false, added, points, estimate, remaining: estimate, doneAt: null, startedAt: null,
        cycleHours: null, ageHours: null, stages: {}, addedOn, created: addedOn ? ts(addedOn, 10) : ts(start, 9) - (2 + Math.floor(r() * 20)) * 24 * HOUR, label,
      };
    });
    // A running sprint only has the tickets added to it so far.
    const fresh = made.filter((t) => !t.addedOn || t.addedOn <= now);
    const tickets: Raw[] = [...carry.map((t): Raw => ({ ...t, carried: true, moved: false, added: false, addedOn: null })), ...fresh];
    for (const t of tickets) {
      if (t.cancelled) {
        t.statusLabel = "Won't Do";
        t.status = 'done';
        continue;
      }
      // Each ticket draws from its own seed, the same number of times whatever the day: it keeps its fate as days pass.
      const q = rng(`${start}:${t.key}`);
      const [finishes, when, late, slow, effort, began, todo, left, here, coded] = Array.from({ length: 10 }, q);
      const from = t.addedOn ? days.indexOf(t.addedOn) : 0;
      // The working day it gets done, past the end when it does not: late in a closed sprint, early in the running one,
      // whose tickets from the Tickets page stand still.
      const at = finishes < (t.carried ? 0.88 : active ? 0.96 : form) ? Math.min(9, Math.max(from, Math.floor(10 * Math.pow(when, active ? 2.2 : 0.6)))) : 99;
      const doneTs = ts(days[Math.min(at, 9)], 13) + late * 4 * HOUR;
      const want = (t.points ?? 3) * (5 + effort * 12) * (slow < 0.08 ? 3 : 1);
      const startTs = t.startedAt ? Date.parse(t.startedAt) : at < 99 ? Math.max(ts(start, 9) + from * 24 * HOUR, doneTs - want * HOUR) : ts(days[Math.min(9, from + Math.floor(began * 6))], 10);
      if (at < done) {
        t.completed = true;
        t.status = 'done';
        t.doneAt = days[at];
        t.startedAt = new Date(startTs).toISOString();
        t.cycleHours = (doneTs - startTs) / HOUR;
        t.ageHours = null;
        t.remaining = 0;
        t.stages = stages(rng(`${t.key}:stages`), t.cycleHours, 'done');
      } else {
        // Not done (yet): how far it got, nearer done the sooner it would be.
        const soon = active ? at - (done - 1) : 9;
        const started = startTs <= until && (soon <= 3 || t.carried || todo >= 0.55);
        t.status = !started ? 'todo' : soon <= 1 ? (todo < 0.5 ? 'ready' : 'review') : soon <= 3 ? (todo < 0.5 ? 'review' : 'progress') : active ? 'progress' : (['progress', 'progress', 'review', 'ready'] as const)[Math.floor(todo * 4)];
        t.startedAt = t.status === 'todo' ? null : new Date(Math.min(startTs, until - 2 * HOUR)).toISOString();
        t.ageHours = t.startedAt ? (until - Date.parse(t.startedAt)) / HOUR : null;
        t.stages = t.ageHours ? stages(rng(`${t.key}:stages`), t.ageHours, t.status) : {};
        t.remaining = t.estimate == null ? null : half(t.estimate * { todo: 1, progress: 0.3 + left * 0.5, review: 0.1 + left * 0.2, ready: left * 0.1, done: 0 }[t.status]);
        t.moved = !active;
      }
      t.statusLabel = LABEL[t.status];
      const project = here < 0.75 ? 'acme-web' : 'acme-api';
      t.code = (t.completed ? coded < 0.8 : t.status !== 'todo' && coded < 0.7) ? code(rng(`${t.key}:code`), t, t.completed ? ts(t.doneAt!, 12) : until, project) : undefined;
    }
    const all = active ? [...fixed(start, nowTs), ...tickets] : tickets;
    out.push({ id: 100 + i, name: `Sprint ${i + 2}`, state: active ? 'active' : 'closed', goal: GOALS[(SPRINTS - 1 - i) % GOALS.length], start, end, complete: active ? null : end, workdays: 10, workdaysDone: done, tickets: all });
    carry = tickets.filter((t) => t.moved).map((t) => ({ ...t, code: undefined }));
  });
  return out;
}

let cache: { day: string; sprints: RawSprint[] } | null = null;
function board() {
  const today = iso(new Date());
  if (cache?.day !== today) cache = { day: today, sprints: build(today) };
  return cache.sprints;
}

const zero = (): Work => ({ tickets: 0, points: 0, hours: 0 });
const work = (list: SprintTicket[]) => list.reduce((a, t) => ({ tickets: a.tickets + 1, points: a.points + (t.points ?? 0), hours: a.hours + (t.estimate ?? 0) }), zero());
const sum = (list: SprintTicket[], f: (t: SprintTicket) => number | null) => list.reduce((a, t) => a + (f(t) ?? 0), 0);
const minus = (a: Work, b: Work): Work => ({ tickets: a.tickets - b.tickets, points: a.points - b.points, hours: a.hours - b.hours });

/** A sprint's figures, from the tickets of `who` (everyone when empty). */
function stat(x: RawSprint, who: string[]): SprintStat {
  const tickets = who.length ? x.tickets.filter((t) => who.includes(t.assignee)) : x.tickets;
  const live = tickets.filter((t) => !t.cancelled);
  const done = live.filter((t) => t.completed);
  const open = live.filter((t) => !t.completed);
  const scopeStart = work(live.filter((t) => !t.added));
  const today = iso(new Date());
  const days = Array.from({ length: 12 }, (_, k) => addDays(x.start, k));
  let worked = 0;
  const burndown = days.map((date) => {
    if (!isWeekend(date)) worked++;
    const seen = x.state === 'closed' || date <= today;
    const scope = work(live.filter((t) => !t.added || t.addedOn! <= date));
    const ideal = scopeStart.tickets ? { tickets: scopeStart.tickets * (1 - worked / x.workdays), points: scopeStart.points * (1 - worked / x.workdays), hours: scopeStart.hours * (1 - worked / x.workdays) } : zero();
    return { date, weekend: isWeekend(date), remaining: seen ? minus(scope, work(done.filter((t) => t.doneAt! <= date))) : null, scope: seen ? scope : null, ideal, done: done.filter((t) => t.doneAt === date).map((t) => t.key) };
  });
  const cycles = done.flatMap((t) => (t.cycleHours == null ? [] : [t.cycleHours])).sort((a, b) => a - b);
  const group = <K extends string>(by: (t: SprintTicket) => K) => [...new Set(live.map(by))].map((k) => [k, live.filter((t) => by(t) === k)] as const);
  return {
    ...x,
    tickets,
    committed: work(live),
    completed: work(done),
    scopeStart,
    added: work(live.filter((t) => t.added)),
    carried: work(live.filter((t) => t.carried)),
    leftEstimate: sum(open, (t) => t.estimate),
    leftRemaining: sum(open, (t) => t.remaining),
    bugs: live.filter((t) => t.bug).length,
    bugsFixed: done.filter((t) => t.bug).length,
    cancelled: tickets.length - live.length,
    noPoints: live.filter((t) => t.points == null).length,
    noEstimate: live.filter((t) => t.estimate == null).length,
    unassigned: live.filter((t) => t.assignee === 'Unassigned').length,
    status: Object.fromEntries(group((t) => t.status).map(([k, l]) => [k, l.length])),
    cycleMedian: rank(cycles, 0.5),
    cycleP85: rank(cycles, 0.85),
    people: group((t) => t.assignee).map(([name, l]) => ({ name, committed: work(l), completed: work(l.filter((t) => t.completed)), leftHours: sum(l.filter((t) => !t.completed), (t) => t.remaining), bugsFixed: l.filter((t) => t.completed && t.bug).length })),
    kinds: group((t) => t.kind).map(([name, l]) => ({ name, committed: work(l), completed: work(l.filter((t) => t.completed)) })),
    burndown,
  };
}

/** The trackers each demo project shows tickets from. */
const TRACKERS: Record<string, string[]> = { 'acme-web': ['Jira', 'GitHub'], 'acme-api': ['Jira', 'Trello'], 'design-system': ['Asana', 'GitHub'] };
export const trackersOf = (ids: string[]) => ['Jira', 'Trello', 'Asana', 'GitHub'].filter((t) => ids.some((id) => TRACKERS[id]?.includes(t)));

/** The WEB board's last `count` sprints, counted for `who`, as the sprints call returns them. */
export function sprints(count: number, who: string[]) {
  const all = board();
  const everyone = [...new Set(all.flatMap((x) => x.tickets.map((t) => t.assignee)))].sort((a, b) => Number(a === 'Unassigned') - Number(b === 'Unassigned') || a.localeCompare(b));
  const list = all.slice(-count).map((x) => stat(x, who));
  const tickets = list.flatMap((x) => x.tickets);
  return { board: { id: 'acme:1', name: 'WEB board', site: 'acme.atlassian.net', sprints: list }, points: tickets.some((t) => t.points != null), hours: tickets.some((t) => t.estimate != null), assignees: everyone };
}

/** [title, labels] of GitHub issues; a "bug" label makes the issue a bug. */
const ISSUES: Record<string, [string, string[]][]> = {
  'acme-web': [
    ['Crash when a branch name has an emoji', ['bug']], ['Support Windows on ARM', ['enhancement', 'windows']], ['Docs: how to pair the phone app', ['documentation']],
    ['Blank diff for files over 1 MB', ['bug', 'diff']], ['Let me hide merged branches', ['enhancement', 'ui']], ['Typo in the settings page', ['good first issue', 'documentation']],
    ['High CPU while an agent builds', ['bug', 'performance']], ['Open the repo on GitHub from the menu', ['enhancement']], ['Tree loses its scroll on fetch', ['bug', 'ui']],
    ['Add a Linux tarball', ['enhancement', 'packaging']], ['Commit list slow on big repos', ['performance']], ['Translate the app into French', ['enhancement', 'i18n']],
  ],
  'design-system': [
    ['Button focus ring hidden on dark panels', ['bug', 'a11y']], ['Date picker: week numbers', ['enhancement', 'component']], ['Document the density tokens', ['documentation']],
    ['Toast stacks over the modal', ['bug', 'component']], ['Tooltip delay token', ['enhancement']], ['Contrast of the faint text', ['a11y']],
  ],
};
const CARDS: Record<string, { tracker: DoneTicket['source']; place: string; prefix: string; kind: string; team: string[]; titles: string[] }> = {
  'acme-api': { tracker: 'trello', place: 'API roadmap', prefix: 'API', kind: 'Card', team: ['Tom Becker', 'Ana Moreau', 'Mei Lin'], titles: ['Rate limit per token', 'Webhooks retry with backoff', 'Orders export as CSV', 'Refund rounding', 'Slow cart query', 'PDF invoices on Linux', 'Pagination cursors', 'Audit log endpoint'] },
  'design-system': { tracker: 'asana', place: 'Design system', prefix: 'DS', kind: 'Task', team: ['Mei Lin', 'Riya Kapoor'], titles: ['Dark palette review', 'Button usage guidelines', 'Date picker keyboard support', 'Icon set audit', 'Spacing scale', 'Card component'] },
};
const TEAMS: Record<string, string[]> = { 'acme-web': ['Grace Hopper', 'Ana Moreau', 'Jules Laurent', 'Riya Kapoor', 'Unassigned'], 'design-system': ['Mei Lin', 'Riya Kapoor'] };
const EPOCH = '2026-01-05';

/** The tickets done in the last `weeks` weeks in the trackers of `ids`, newest first, and their counts per week. */
export function weekly(ids: string[], weeks: number): WeeklyReport {
  const today = iso(new Date());
  const now = Date.now();
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(mondayOf(today), -7 * (weeks - 1 - i)));
  const first = mondays[0];
  const tickets: DoneTicket[] = [];
  if (ids.some((id) => TRACKERS[id].includes('Jira'))) {
    for (const t of board().flatMap((x) => x.tickets)) {
      if (!t.completed || !t.doneAt || t.doneAt < first || t.doneAt > today) continue;
      const done = ts(t.doneAt, 15);
      tickets.push({ key: t.key, title: t.title, url: t.url, source: 'jira', place: 'WEB', kind: t.kind, labels: [t.label], assignee: t.assignee, doneAt: new Date(done).toISOString(), created: new Date(t.created).toISOString(), points: t.points, week: mondayOf(t.doneAt), leadHours: (done - t.created) / HOUR });
    }
  }
  for (const monday of mondays) {
    const nth = Math.round((Date.parse(`${monday}T12:00:00Z`) - Date.parse(`${EPOCH}T12:00:00Z`)) / (7 * 24 * HOUR));
    for (const id of ids) {
      const r = rng(`${id}:${monday}`);
      const add = (key: string, title: string, url: string, source: DoneTicket['source'], place: string, kind: string, labels: string[] | undefined, who: string, j: number) => {
        const date = addDays(monday, Math.floor(r() * 5));
        if (date > today) return;
        const done = ts(date, 10 + j);
        const created = done - (12 + r() * 24 * 20) * HOUR;
        tickets.push({ key, title, url, source, place, kind, labels, assignee: who, doneAt: new Date(done).toISOString(), created: new Date(created).toISOString(), points: null, week: monday, leadHours: (done - created) / HOUR });
      };
      if (TRACKERS[id].includes('GitHub')) {
        const pool = ISSUES[id];
        for (let j = 0, n = Math.floor(r() * (id === 'acme-web' ? 5 : 3)); j < n; j++) {
          const num = 40 + nth * 6 + j;
          const [title, labels] = pool[(num * 5) % pool.length];
          add(`#${num}`, title, `https://github.com/acme/${id}/issues/${num}`, 'github', `acme/${id}`, labels.includes('bug') ? 'Bug' : 'Issue', labels, pick(r, TEAMS[id]), j);
        }
      }
      const c = CARDS[id];
      if (c && TRACKERS[id].some((t) => t.toLowerCase() === c.tracker)) {
        for (let j = 0, n = 1 + Math.floor(r() * 3); j < n; j++) {
          const num = 10 + nth * 3 + j;
          add(`${c.prefix}-${num}`, c.titles[(num * 3) % c.titles.length], `https://${c.tracker}.com/${c.prefix.toLowerCase()}-${num}`, c.tracker, c.place, c.kind, undefined, pick(r, c.team), j);
        }
      }
    }
  }
  tickets.sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  const rows = mondays.map((start) => {
    const mine = tickets.filter((t) => t.week === start);
    const people = new Map<string, number>();
    for (const t of mine) people.set(t.assignee, (people.get(t.assignee) ?? 0) + 1);
    return { start, done: mine.length, points: mine.reduce((a, t) => a + (t.points ?? 0), 0), people: [...people].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
  });
  return { sources: trackersOf(ids), weeks: rows, tickets, points: tickets.some((t) => t.points != null), errors: [], syncedAt: new Date(now - 4 * 60_000).toISOString() };
}
