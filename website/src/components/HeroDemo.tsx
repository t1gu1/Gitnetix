import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
// The app's own icon set, so the demo draws the same glyphs.
import { Icon } from '../../../src/components/Icon';
import { STATUS_SHOWN } from '../../../src/lib/agentLog';
import { plural } from '../../../src/lib/format';
import { kindOfBranch } from '../../../src/lib/kinds';
import { otherMode, resolveTheme } from '../../../src/lib/themes';
import Analytics from './demo/Analytics';
import { AgentInput, AgentLog, AgentPicker, FinishCard, ME, TRY, keyOf, pathOf, shown, useAgents, type Ai, type Pick } from './demo/agents';
import { CARD_ROOM, MapLayer, MapLegendBox, PREFS, branches, layoutMap, lineageOf, onMap, type AgentInfo, type MapHandlers, type MapPrefs, type Shipped } from './demo/BranchMap';
import PullRequests from './demo/PullRequests';
import ReleaseNotes from './demo/ReleaseNotes';
import Submodules from './demo/Submodules';
import Tickets from './demo/Tickets';
import { Avatar, DemoContext, FindBar, FixedWidth, Menu, ProfileAvatar, Seg, useMenu, useThumb, type Demo, type MenuItem } from './demo/ui';
import Worktrees from './demo/Worktrees';

/**
 * The hero's playable app: a scripted copy of its screens, the Workspace here and the other pages in ./demo.
 * Markup and class names follow src/components/TopBar.tsx, src/screens/Workspace.tsx, src/screens/BranchMap.tsx
 * and src/components/AgentLog.tsx, so the rules in site.css (scoped under .hd) can stay copies of src/styles/app.css.
 */

export type File = { path: string; add: number; del: number; s: 'M' | 'A' | 'D' | ' '; staged?: boolean };
export type Branch = {
  name: string;
  /** Work branch type: shown as a chip, and the name loses its prefix. */
  kind?: string;
  role: 'trunk' | 'release' | 'branch';
  base?: string;
  tag?: string;
  author: string;
  ahead: number;
  behind: number;
  wip: File[];
  files: File[];
  kids?: string[];
  /** Checked out in its own worktree, where an agent works. */
  wt?: boolean;
  /** Commits made in the demo, newest first; the older ones come from LOG. */
  log?: Commit[];
  /** All its commits are in its base: a chip under it on the map. */
  merged?: boolean;
  /** Days since its last commit, said on a branch falling behind. */
  idle?: number;
  /** Commits origin doesn't have yet. */
  push?: number;
  stashes?: number;
};
/** A commit of a branch, with the files it changed; `when` as src/lib/format.ts `ago` says it. */
export type Commit = { sha: string; subject: string; body?: string; author: string; when: string; files: File[]; tags?: string[] };

const BRANCHES: Record<string, Branch> = {
  main: { name: 'main', role: 'trunk', author: 'Ana Moreau', ahead: 0, behind: 0, wip: [], files: [], kids: ['release/0.6.0', 'feat/agent-pane', 'feat/old-sidebar', 'fix/tab-order'] },
  'release/0.6.0': {
    name: 'release/0.6.0', role: 'release', base: 'main', tag: 'Next', author: 'Ana Moreau', ahead: 9, behind: 0, wip: [],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 120, del: 34, s: 'M' }, { path: 'src/styles/app.css', add: 48, del: 6, s: 'M' }, { path: 'CHANGELOG.md', add: 22, del: 0, s: 'M' }],
    kids: ['feat/branch-tree', 'fix/stale-remote', 'feat/commit-folds'],
  },
  'feat/branch-tree': {
    name: 'feat/branch-tree', kind: 'feat', role: 'branch', base: 'release/0.6.0', author: ME, ahead: 4, behind: 0, stashes: 2,
    wip: [{ path: 'src/screens/BranchTree.tsx', add: 42, del: 6, s: 'M' }, { path: 'src/styles/app.css', add: 18, del: 0, s: 'M' }],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 96, del: 21, s: 'M' }, { path: 'src/lib/path.ts', add: 64, del: 0, s: 'A' }, { path: 'src/styles/app.css', add: 30, del: 4, s: 'M' }],
  },
  // An agent is at work on it, in its worktree (src/components/demo/agents.tsx).
  'fix/stale-remote': {
    name: 'fix/stale-remote', kind: 'fix', role: 'branch', base: 'release/0.6.0', author: 'Jules Laurent', ahead: 2, behind: 2, wip: [], wt: true,
    files: [{ path: 'crates/core/src/git.rs', add: 14, del: 9, s: 'M' }],
  },
  'feat/commit-folds': { name: 'feat/commit-folds', kind: 'feat', role: 'branch', base: 'release/0.6.0', author: ME, ahead: 0, behind: 0, wip: [], files: [], merged: true },
  'feat/agent-pane': { name: 'feat/agent-pane', kind: 'feat', role: 'branch', base: 'main', author: 'Riya Kapoor', ahead: 0, behind: 13, wip: [], files: [] },
  'feat/old-sidebar': {
    name: 'feat/old-sidebar', kind: 'feat', role: 'branch', base: 'main', author: 'Riya Kapoor', ahead: 3, behind: 31, idle: 41, wip: [],
    files: [{ path: 'src/components/Sidebar.tsx', add: 88, del: 0, s: 'A' }, { path: 'src/styles/app.css', add: 24, del: 3, s: 'M' }],
  },
  'fix/tab-order': { name: 'fix/tab-order', kind: 'fix', role: 'branch', base: 'main', author: 'Jules Laurent', ahead: 0, behind: 0, wip: [], files: [], merged: true },
};
const ch = (path: string, add: number, del: number, s: File['s'] = 'M'): File => ({ path, add, del, s });
/** Each branch's history before the demo starts, newest first: as many as it is ahead of its base, main's recent ones. */
const LOG: Record<string, Commit[]> = {
  main: [
    { sha: '9c41e07', subject: 'Release 0.5.2', author: 'Ana Moreau', when: '4d ago', files: [ch('CHANGELOG.md', 14, 0), ch('package.json', 1, 1)], tags: ['v0.5.2'] },
    { sha: '3fa8d21', subject: 'Keep the scroll position when a branch moves', author: 'Riya Kapoor', when: '5d ago', files: [ch('src/screens/BranchTree.tsx', 18, 5)] },
    { sha: 'b27e6c4', subject: 'Fix the tab order of the commit box', author: 'Jules Laurent', when: '6d ago', files: [ch('src/screens/Workspace.tsx', 6, 4)] },
    { sha: '58d0a9f', subject: 'Show stashes next to their branch', body: 'A stash counter on the row opens the stashes made on that branch.', author: ME, when: '7d ago', files: [ch('src/screens/BranchTree.tsx', 41, 3), ch('src/screens/StashList.tsx', 96, 0, 'A')] },
    { sha: 'e19b3d2', subject: 'Release 0.5.1', author: 'Ana Moreau', when: '14d ago', files: [ch('CHANGELOG.md', 9, 0), ch('package.json', 1, 1)], tags: ['v0.5.1'] },
    { sha: '07c5f8a', subject: 'Group branches falling behind', author: 'Riya Kapoor', when: '15d ago', files: [ch('src/screens/BranchTree.tsx', 64, 12), ch('src/styles/app.css', 22, 0)] },
  ],
  'release/0.6.0': [
    { sha: 'a4e1c90', subject: 'Update changelog for 0.6.0', author: 'Ana Moreau', when: '3h ago', files: [ch('CHANGELOG.md', 22, 0)] },
    { sha: '6d2b7f3', subject: "Merge branch 'feat/commit-folds' into release/0.6.0", author: ME, when: '1d ago', files: [ch('src/screens/BranchTree.tsx', 38, 9)] },
    { sha: 'c80f5e1', subject: 'Fold runs of commits into one row', author: ME, when: '1d ago', files: [ch('src/screens/BranchTree.tsx', 30, 11), ch('src/styles/app.css', 16, 2)] },
    { sha: '1b9a6d4', subject: 'Count WIP files under a closed group', author: 'Riya Kapoor', when: '2d ago', files: [ch('src/screens/BranchTree.tsx', 12, 3)] },
    { sha: 'f3c7e28', subject: 'Slide the page tab underline', author: 'Jules Laurent', when: '2d ago', files: [ch('src/styles/app.css', 14, 4)] },
    { sha: '5e08b1a', subject: 'Show the release tag on the next release', author: 'Ana Moreau', when: '3d ago', files: [ch('src/screens/BranchTree.tsx', 9, 2)] },
    { sha: '92d4f6c', subject: 'Draw the child branches toggle', author: 'Riya Kapoor', when: '3d ago', files: [ch('src/screens/BranchTree.tsx', 21, 6), ch('src/styles/app.css', 10, 0)] },
    { sha: '4a7c3e9', subject: 'Taller rows for touch', author: 'Jules Laurent', when: '4d ago', files: [ch('src/styles/app.css', 8, 0)] },
    { sha: 'd61e0b5', subject: 'Start 0.6.0', author: 'Ana Moreau', when: '4d ago', files: [ch('package.json', 1, 1)] },
  ],
  'feat/branch-tree': [
    { sha: '7f3a2c8', subject: 'Draw the path from the trunk to the checked-out branch', body: 'Measured off the rendered rows, so it follows folded groups.', author: ME, when: '2h ago', files: [ch('src/screens/BranchTree.tsx', 58, 12), ch('src/lib/path.ts', 12, 0)] },
    { sha: '2c9e4b1', subject: 'Measure rows with layout offsets, not client rects', author: ME, when: '5h ago', files: [ch('src/screens/BranchTree.tsx', 38, 9)] },
    { sha: 'e5b8d03', subject: 'Add usePath', author: ME, when: '1d ago', files: [ch('src/lib/path.ts', 52, 0, 'A')] },
    { sha: '8a1f6e7', subject: 'Style the dotted path line', author: ME, when: '1d ago', files: [ch('src/styles/app.css', 30, 4)] },
  ],
  'fix/stale-remote': [
    { sha: '3d7c9a2', subject: 'Test pruning of stale remote refs', author: 'Jules Laurent', when: '1h ago', files: [ch('crates/core/src/git.rs', 4, 2)] },
    { sha: 'b6e2f15', subject: 'Drop remote refs that are gone on fetch', author: 'Jules Laurent', when: '3h ago', files: [ch('crates/core/src/git.rs', 10, 7)] },
  ],
  'feat/old-sidebar': [
    { sha: 'c41f0a8', subject: 'Collapse the sidebar to icons', author: 'Riya Kapoor', when: 'Oct 8', files: [ch('src/components/Sidebar.tsx', 40, 0), ch('src/styles/app.css', 24, 3)] },
    { sha: '9e2d6b3', subject: 'Remember the sidebar width', author: 'Riya Kapoor', when: 'Oct 7', files: [ch('src/components/Sidebar.tsx', 22, 0)] },
    { sha: '04ab7e1', subject: 'Start the sidebar', author: 'Riya Kapoor', when: 'Oct 6', files: [ch('src/components/Sidebar.tsx', 26, 0, 'A')] },
  ],
};
/** Releases shipped from main, newest first, with the commits each shipped. */
const SHIPPED: Shipped[] = [
  { tag: 'v0.5.2', date: 'Nov 14', commits: LOG.main.slice(0, 4) },
  { tag: 'v0.5.1', date: 'Nov 4', commits: LOG.main.slice(4, 6) },
  {
    tag: 'v0.5.0', date: 'Oct 21',
    commits: [
      { sha: '6b1e9f4', subject: 'Release 0.5.0', author: 'Ana Moreau', when: 'Oct 21', files: [ch('CHANGELOG.md', 31, 0), ch('package.json', 1, 1)], tags: ['v0.5.0'] },
      { sha: 'd2c47a0', subject: 'Open a branch full screen from its card', author: ME, when: 'Oct 20', files: [ch('src/screens/Workspace.tsx', 120, 18)] },
      { sha: '91fa3c5', subject: 'Count WIP files on the map', author: 'Riya Kapoor', when: 'Oct 18', files: [ch('src/screens/BranchTree.tsx', 22, 4)] },
    ],
  },
  {
    tag: 'v0.4.0', date: 'Sep 30',
    commits: [
      { sha: '3e8d0b7', subject: 'Release 0.4.0', author: 'Ana Moreau', when: 'Sep 30', files: [ch('CHANGELOG.md', 26, 0), ch('package.json', 1, 1)], tags: ['v0.4.0'] },
      { sha: 'a7f2c19', subject: 'Close a worktree and merge it in', author: 'Jules Laurent', when: 'Sep 28', files: [ch('src/screens/Worktrees.tsx', 64, 9)] },
    ],
  },
];
/** `b`'s commits, newest first: a tracked branch lists the ones its base doesn't have, a trunk its recent history. */
const logOf = (b: Branch) => [...(b.log ?? []), ...(LOG[b.name] ?? [])].slice(0, b.base ? b.ahead : undefined);
const PROJECT = ['package.json', 'src/App.tsx', 'src/screens/BranchTree.tsx', 'src/screens/Workspace.tsx', 'src/styles/app.css', 'README.md'];
/** The agent's name per provider, as the map's chips say it. */
const LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Antigravity', copilot: 'Copilot', ollama: 'Ollama' };

/** Same pages as PAGES in src/lib/nav.tsx. */
const PAGES: { id: string; label: string; icon: string; Page?: ComponentType }[] = [
  { id: 'workspace', label: 'Workspace', icon: 'home' },
  { id: 'prs', label: 'Pull requests', icon: 'pr', Page: PullRequests },
  { id: 'tickets', label: 'Tickets', icon: 'ticket', Page: Tickets },
  { id: 'notes', label: 'Release notes', icon: 'tag', Page: ReleaseNotes },
  { id: 'submodules', label: 'Submodules', icon: 'box', Page: Submodules },
  { id: 'analytics', label: 'Analytics', icon: 'chart', Page: Analytics },
];
/** Worktrees & agents has no page tab: its own square button beside the menu opens it over the project's page (TopBar.tsx). */
const VIEWS = [{ id: 'worktrees', Page: Worktrees }, ...PAGES];

const HUNK = '@@ -88,6 +88,7 @@ export function BranchTree';
const DIFF: [' ' | '+' | '-', string][] = [
  [' ', 'export function BranchTree({ o, selected }: Props) {'],
  [' ', '  const path = usePath(o.currentBranch);'],
  ['-', '  return <Tree path={path} />;'],
  ['+', '  const pulse = usePulse(path, 90);'],
  ['+', '  return <Tree path={path} pulse={pulse} />;'],
  [' ', '}'],
];
/** What "Full" adds above the change: the rest of the file. */
const ABOVE = ["import { usePath } from '../lib/path';", "import { usePulse } from '../lib/pulse';", "import { Tree } from './Tree';", ''];

const labelOf = (b: string) => (b.startsWith('release/') ? `v${b.slice(8)}` : b);
const agentWords = (a: AgentInfo) => (a.state === 'working' ? 'working' : a.state === 'waiting' ? 'waiting for you' : a.state === 'done' ? 'done, ready to review' : 'idle');
/** Where the branch stands with origin, in a few words, and its colour (originOf in BranchMap.tsx). */
const originOf = (b: Branch): [string, string] => (b.push ? [`↑${b.push} to push`, ''] : ['synced with origin', '']);
/** What "Look at the code" opens on: the uncommitted work, else the branch's own changes, else the project's files. */
const lookItem = (b: Branch) => (b.wip.length ? 'wip' : b.ahead > 0 && b.base ? 'all' : 'project');
/** `b` once `done` (some of its WIP) is committed: those changes join the branch's own, and wait to be pushed. */
function fold(b: Branch, done: File[], subject = "Apply the agent's changes", body?: string): Branch {
  const files = b.files.map((f) => {
    const w = done.find((x) => x.path === f.path);
    return w ? { ...f, add: f.add + w.add, del: f.del + w.del } : f;
  });
  const plain = done.map(({ staged: _, ...f }) => f);
  const added = plain.filter((w) => !b.files.some((f) => f.path === w.path));
  const sha = Math.random().toString(16).slice(2, 9).padEnd(7, '0');
  const c: Commit = { sha, subject, body, author: ME, when: 'just now', files: plain };
  return { ...b, ahead: b.ahead + 1, push: (b.push ?? 0) + 1, wip: b.wip.filter((f) => !done.includes(f)), files: [...files, ...added], log: [c, ...(b.log ?? [])] };
}
/** The message AI writes for `wip`. */
const aiSubject = (wip: File[]) => (wip.some((f) => /pulse|BranchTree/.test(f.path)) ? 'Pulse along the branch path' : "Apply the agent's changes");

function Nums({ add, del }: { add: number; del: number }) {
  return (
    <span className="row mono file-nums">
      <span className="c-add">{add > 0 && `+${add}`}</span>
      <span className="c-del">{del > 0 && `−${del}`}</span>
    </span>
  );
}

type Dir = { dirs: Map<string, Dir>; files: File[] };
function buildTree(list: File[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of list) {
    let d = root;
    for (const p of f.path.split('/').slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  return root;
}
const filesUnder = (d: Dir): File[] => [...d.files, ...[...d.dirs.values()].flatMap(filesUnder)];

/** `depth` set = shown in a tree, where the folder rows already name the directory. */
function FileRow({ f, depth, active, onPick, actions }: { f: File; depth?: number; active: boolean; onPick: (f: File) => void; actions?: ReactNode }) {
  const cut = f.path.lastIndexOf('/');
  const dir = cut >= 0 && depth === undefined ? f.path.slice(0, cut) : '';
  const color = { A: 'c-add', D: 'c-del', M: 'c-mod', ' ': 'faint' }[f.s];
  const btn = (
    <button className="file-btn" style={depth ? { paddingLeft: 14 + depth * 14 } : undefined} aria-pressed={active} onClick={() => onPick(f)}>
      <span className={`file-st ${color}`}>{f.s === ' ' ? '·' : f.s}</span>
      <span className="grow ellipsis">
        <span style={{ color: f.s === ' ' ? 'var(--muted)' : 'var(--fg)' }}>{f.path.slice(cut + 1)}</span> <span className="faint" style={{ fontSize: 11.5 }}>{dir}</span>
      </span>
      <Nums add={f.add} del={f.del} />
    </button>
  );
  if (!actions) return btn;
  return (
    <div className="file-row">
      {btn}
      <span className="file-acts">{actions}</span>
    </div>
  );
}

/** Changed files as a flat list, or nested under their folders, like FileList in Workspace.tsx; `allClosed`: folders start closed. */
function FileList({ list, tree, allClosed = false, current, onPick, actions }: { list: File[]; tree: boolean; allClosed?: boolean; current?: File; onPick: (f: File) => void; actions?: (fs: File[], name: string) => ReactNode }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const row = (f: File, depth?: number) => (
    <li key={f.path}>
      <FileRow f={f} depth={depth} active={f.path === current?.path} onPick={onPick} actions={actions?.([f], f.path)} />
    </li>
  );
  if (!tree) return <>{list.map((f) => row(f))}</>;
  const walk = (d: Dir, path: string, depth: number): ReactNode[] => [
    ...[...d.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, sub]) => {
      // Folders holding a single folder fold into one row, like "src/screens".
      while (!sub.files.length && sub.dirs.size === 1) {
        const [n, s] = [...sub.dirs][0];
        name += `/${n}`;
        sub = s;
      }
      const key = `${path}${name}/`;
      const fs = filesUnder(sub);
      const shut = closed[key] ?? allClosed;
      const btn = (
        <button className="file-btn" style={{ paddingLeft: 14 + depth * 14 }} aria-expanded={!shut} onClick={() => setClosed((c) => ({ ...c, [key]: !shut }))}>
          <Icon name="chevronDown" size={12} className="chev" />
          <span className="grow ellipsis faint">{name}</span>
          <Nums add={fs.reduce((n, f) => n + f.add, 0)} del={fs.reduce((n, f) => n + f.del, 0)} />
        </button>
      );
      return (
        <li key={key}>
          {actions ? <div className="file-row">{btn}<span className="file-acts">{actions(fs, key)}</span></div> : btn}
          <ul hidden={shut}>{walk(sub, key, depth + 1)}</ul>
        </li>
      );
    }),
    ...d.files.map((f) => row(f, depth)),
  ];
  return <>{walk(buildTree(list), '', 0)}</>;
}

type Mode = 'wip' | 'branch' | 'project';
/** Collapse/expand all for the lists showing `list` (useFold in Workspace.tsx): a new `n` remounts them, dropping per-folder
 *  toggles. Each new list starts expanded, the Project one collapsed: the whole repo. */
function useFold(list: string) {
  const [fold, setFold] = useState({ closed: list === 'project', n: 0, list });
  if (fold.list !== list) setFold({ closed: list === 'project', n: fold.n + 1, list });
  return [fold, () => setFold((f) => ({ ...f, closed: !f.closed, n: f.n + 1 }))] as const;
}
/** The Collapse all / Expand all button of a file list head, in tree view. */
const FoldBtn = ({ closed, onClick, style }: { closed: boolean; onClick: () => void; style?: CSSProperties }) => (
  <button className="btn btn-sm btn-icon" style={style} aria-label={closed ? 'Expand all folders' : 'Collapse all folders'} title={closed ? 'Expand all' : 'Collapse all'} aria-expanded={!closed} onClick={onClick}>
    <Icon name="chevronDown" size={12} className="chev" />
  </button>
);

/** Unified, split or whole-file diff with the change map on its right, like src/components/DiffView.tsx; `raw` is an unchanged file as it is. */
function Diff({ mode }: { mode: 'split' | 'unified' | 'full' | 'raw' }) {
  type Row = { k: ' ' | '+' | '-' | '@'; o?: number; n?: number; t: string };
  const whole = mode === 'full' || mode === 'raw';
  const rows: Row[] = whole ? ABOVE.map((t, i) => ({ k: ' ', o: i + 84, n: i + 84, t })) : [{ k: '@', t: HUNK }];
  let o = 88;
  let n = 88;
  for (const [k, t] of DIFF) {
    // Raw: the file as it is now, every line numbered on both sides.
    if (mode === 'raw') {
      if (k !== '-') rows.push({ k: ' ', t, o: n, n: n++ });
      continue;
    }
    rows.push({ k, t, o: k === '+' ? undefined : o++, n: k === '-' ? undefined : n++ });
  }
  // Digits of the highest line number: on a narrow screen the number columns fit just that, like lnWidth in DiffView.tsx.
  const ln = { '--ln': String(Math.max(o, n) - 1).length } as CSSProperties;
  const cls = (k: Row['k']) => (k === '+' ? ' add' : k === '-' ? ' del' : k === '@' ? ' hunk' : '');
  const sign = (k: Row['k']) => (k === '+' ? '+' : k === '-' ? '−' : '');
  // Marks come from the rendered rows (wrapped lines are taller), as fractions of the content, like Heatmapped in DiffView.tsx.
  const scroller = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<{ k: 'add' | 'del'; top: number; height: number }[]>([]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const total = el.scrollHeight || 1;
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      const out: typeof marks = [];
      const last: Partial<Record<'add' | 'del', (typeof marks)[number]>> = {};
      el.querySelectorAll<HTMLElement>('.diff-row.add, .diff-row.del, .diff-half.add, .diff-half.del').forEach((r) => {
        const k = r.classList.contains('add') ? 'add' : 'del';
        const box = r.getBoundingClientRect();
        const top = (box.top - origin) / total;
        const height = box.height / total;
        const prev = last[k];
        if (prev && Math.abs(prev.top + prev.height - top) < 1e-6) prev.height += height;
        else out.push((last[k] = { k, top, height }));
      });
      setMarks(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);
  // Split: removed lines on the left facing the added ones on the right, the rest on both sides.
  const pairs: [Row | null, Row | null][] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.k === '-') {
      const dels = rows.slice(i).filter((x, j, a) => a.slice(0, j + 1).every((y) => y.k === '-'));
      const adds = rows.slice(i + dels.length).filter((x, j, a) => a.slice(0, j + 1).every((y) => y.k === '+'));
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) pairs.push([dels[j] ?? null, adds[j] ?? null]);
      i += dels.length + adds.length - 1;
    } else pairs.push([r, r]);
  }
  return (
    <div className="diff">
      <div className="diff-pane">
        <div ref={scroller} className="diff-pane-scroll">
          {mode === 'split' ? (
            <div className="diff-split" style={ln}>
              {pairs.map(([l, r], i) => (
                <div key={i} className="diff-split-row">
                  {[l && { ...l, num: l.k === '@' ? undefined : l.o }, r && { ...r, num: r.k === '@' ? undefined : r.n }].map((x, j) => (
                    <div key={j} className={`diff-half${x ? cls(x.k) : ' blank'}`}>
                      <span className="ln">{x?.num}</span>
                      <span className="sg">{x && sign(x.k)}</span>
                      <span className="tx">{x?.t}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="diff-u" style={ln}>
              {rows.map((r, i) => (
                <div key={i} className={`diff-row${cls(r.k)}`}>
                  <span className="ln">{r.k === '+' ? '' : r.o}</span>
                  <span className="ln">{r.k === '-' ? '' : r.n}</span>
                  <span className="sg">{sign(r.k)}</span>
                  <span className="tx">{r.t}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={`diff-heatmap${mode === 'split' ? ' split' : ''}`} aria-hidden="true">
          {marks.map((m, i) => <span key={i} className={`hm ${m.k}`} style={{ top: `${m.top * 100}%`, height: `${m.height * 100}%` }} />)}
        </div>
      </div>
    </div>
  );
}

/** Tags naming a branch's place, like BranchTags in BranchMap.tsx: the one checked out, the default branch (unless checked out), a release's kind. */
function BranchTags({ b, head }: { b: Branch; head: string }) {
  return (
    <>
      {b.name === head && <span className="tag inv">Checked out</span>}
      {b.role === 'trunk' && b.name !== head && <span className="tag">Default</span>}
      {b.tag && <span className={b.tag === 'Next' ? 'tag inv' : 'tag'}>{b.tag}</span>}
    </>
  );
}

/** The demo's other profiles, for the profile menu: name, emoji, hue. */
const PROFILES: [string, string, number][] = [['Personal', '🦊', 22], ['Open source', '🐙', 270]];

/** Same as MOBILE_TABS in src/App.tsx: [page, label, icon]. The other pages go under "More". */
const TABS = [['workspace', 'Releases', 'tag'], ['worktrees', 'Agents', 'layers'], ['prs', 'PRs', 'pr'], ['tickets', 'Tickets', 'ticket']];

/** The phone's bottom tabs, like MobileTabs in src/App.tsx: the open one's icon in a sliding pill. */
function MobileTabs({ page, go }: { page: string; go: (p: string) => void }) {
  const bar = useRef<HTMLElement>(null);
  const more = useMenu();
  const tab = TABS.findIndex(([id]) => id === page);
  const bubble = useThumb(bar, tab < 0 ? TABS.length : tab, TABS.length + 1, ':scope > button > span');
  return (
    <nav ref={bar} className="mobile-tabs" aria-label="Sections">
      {bubble && <span className="mobile-tabs-bubble" style={bubble} aria-hidden="true" />}
      {TABS.map(([id, label, icon]) => (
        <button key={id} type="button" aria-pressed={id === page} onClick={() => go(id)}>
          <span><Icon name={icon} size={18} /></span>
          {label}
        </button>
      ))}
      <button type="button" aria-haspopup="menu" aria-pressed={tab < 0} onClick={(e) => more.toggle(e, true)}>
        <span><Icon name="more" size={18} /></span>
        More
      </button>
      {more.at && <Menu {...more.at} up alignRight label="More pages" onClose={more.close} items={PAGES.filter((p) => !TABS.some(([id]) => id === p.id)).map((p) => ({ id: p.id, label: p.label, icon: p.icon, run: () => go(p.id) }))} />}
    </nav>
  );
}

/** The agent panel bar's icon cells, as in Terminal (src/screens/Workspace.tsx). */
const TERM_BTN: CSSProperties = { width: 34, height: 'auto', border: 0, borderLeft: '1px solid var(--line)', borderRadius: 0 };

/** What a button suggests for a branch: like an Action in src/screens/BranchMenu.tsx. */
type Act = { label: string; icon: string; tip: string; danger?: boolean; run: () => void };

/** `phone`: the app as a phone browser shows it, one pane at a time and tabs at the bottom. */
export default function HeroDemo({ phone }: { phone?: boolean }) {
  const [bs, setBs] = useState(BRANCHES);
  const [head, setHead] = useState('feat/branch-tree');
  const [sel, setSel] = useState('feat/branch-tree');
  // The map, or the selected branch full screen (Workspace.tsx `focused`), and what it shows there: WIP, the branch's changes, the
  // project's files, or one commit opened from the map.
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<Mode>('wip');
  const [commit, setCommit] = useState<Commit>();
  const [file, setFile] = useState<string>();
  const [tree, setTree] = useState(false);
  const [diffMode, setDiffMode] = useState<'split' | 'unified' | 'full'>('unified');
  // On a phone, the focus view's pane on screen (Workspace.tsx PANES).
  const [pane, setPane] = useState<'rail' | 'code'>('rail');
  // The map's filters and zoom (useMapPrefs), what was unfolded on it by hand, and the selected card folded away.
  const [prefs, setPrefs] = useState<MapPrefs>(PREFS);
  const [zoom, setZoom] = useState(phone ? 0.8 : 0.9);
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [folded, setFolded] = useState(!!phone);
  // The files under the card (MapFiles in Workspace.tsx): the list it shows and the file open over the map, for one branch;
  // and the branch whose files its "Files" button opened, which a branch with uncommitted work doesn't need.
  const [mapAt, setMapAt] = useState<{ branch: string; mode?: Mode; file?: string }>({ branch: '' });
  const [mapFiles, setMapFiles] = useState('');
  const [mapDiffMode, setMapDiffMode] = useState<'split' | 'unified' | 'full'>('unified');
  // The branch search (Ctrl+F): its text and the match its arrows are on.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [hitAt, setHitAt] = useState(0);
  const profile = useMenu();
  // A branch's menu: its "…" on the card, or a right click on the map.
  const [menu, setMenu] = useState<{ x: number; y: number; n: string; right: boolean } | null>(null);
  const [secOpen, setSecOpen] = useState({ true: true, false: true });
  // The agent panel, closed until opened like the app's, and expanded over the map.
  const [term, setTerm] = useState<'agent' | 'shell' | null>(null);
  const [max, setMax] = useState(false);
  const [text, setText] = useState(TRY);
  const [picks, setPicks] = useState<Pick[]>([]);
  // Why the agent pane would not start an agent on a branch.
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [msgOpen, setMsgOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [page, setPage] = useState('workspace');
  // The worktrees view, shown over the project's page, which stays as it was left (nav.inWorktrees), and the row a link picks there.
  const [wt, setWt] = useState(false);
  const [wtPick, setWtPick] = useState<{ key: string }>();
  const view = wt ? 'worktrees' : page;
  // Pages mount on their first visit and stay: their state, and the agents they show, carry on while you look elsewhere.
  const [seen, setSeen] = useState(['workspace']);
  const timers = useRef<number[]>([]);
  const toastId = useRef(0);
  const tabsRef = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  // A branch picked from another page, scrolled into view once the map shows it.
  const reveal = useRef<string | undefined>(undefined);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const setWip = (n: string, f: (w: File[]) => File[]) => setBs((x) => (x[n] ? { ...x, [n]: { ...x[n], wip: f(x[n].wip) } } : x));
  // An agent's answer leaves its files in its worktree, uncommitted.
  const agents = useAgents((s, wip) => s.project === 'acme-web' && setWip(s.branch, (w) => [...w.filter((f) => !wip.some((x) => x.path === f.path)), ...wip]));
  const ink = useThumb(tabsRef, wt ? -1 : PAGES.findIndex((p) => p.id === page), PAGES.length);

  const layout = useMemo(() => layoutMap(bs, head, prefs, ME, toggles, SHIPPED), [bs, head, prefs, toggles]);
  // A filter hiding the selected branch: the map shows the checked-out one as selected instead.
  const shownSel = onMap(layout, sel) ? sel : layout.at.has(head) ? head : 'main';
  const agentOf = (n: string): AgentInfo | undefined => {
    const s = agents.get(keyOf('acme-web', n));
    if (!s) return undefined;
    const st = shown(s);
    return { label: LABEL[s.ai.provider] ?? 'Agent', state: st === 'running' ? 'working' : st === 'waiting' || st === 'done' ? st : undefined };
  };

  const b = bs[sel] ?? bs[head];
  const key = keyOf('acme-web', b.name);
  const ses = agents.get(key);
  const busy = ses?.status === 'running' || ses?.status === 'paused';
  const running = agents.sessions.filter((s) => s.status === 'running');
  const isOut = b.name === head || !!b.wt;
  const wipCount = b.wip.length;
  /** Whether `x`'s uncommitted work can be committed here: checked out, some to commit, no agent at work on it. */
  const canCommitOn = (x: Branch) => {
    const st = agents.get(keyOf('acme-web', x.name))?.status;
    return (x.name === head || !!x.wt) && x.wip.length > 0 && st !== 'running' && st !== 'paused';
  };
  const later = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, ms));
  const flash = (t: string, error?: boolean) => {
    const id = ++toastId.current;
    setToast({ text: t, error });
    later(2600, () => id === toastId.current && setToast(undefined));
  };
  const go = (p: string) => {
    setWt(p === 'worktrees');
    if (p !== 'worktrees') setPage(p);
    setSeen((s) => (s.includes(p) ? s : [...s, p]));
  };

  // The card floats over the map's top right unless the demo is narrow, as phones show it: then it sits above the map.
  const cardRoom = () => (!phone && (root.current?.clientWidth ?? 0) > 720 ? CARD_ROOM : 0);
  /** Brings tile `n` into view, out from under the card, unless it is already (scrollTo in BranchMap.tsx). */
  const scrollTo = (n: string, smooth = false) => {
    const el = canvas.current;
    const t = layout.at.get(n) ?? layout.at.get(layout.parent(n) ?? '');
    if (!el || !t || !el.clientWidth) return;
    const room = cardRoom();
    const [left, top] = [t.x * zoom, t.y * zoom];
    if (left >= el.scrollLeft && left + t.w * zoom <= el.scrollLeft + el.clientWidth - room && top >= el.scrollTop && top + t.h * zoom <= el.scrollTop + el.clientHeight) return;
    el.scrollTo({ left: left + (t.w * zoom) / 2 - (el.clientWidth - room) / 2, top: top + (t.h * zoom) / 2 - el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  /** The whole map in view, left of the card. */
  const fit = () => {
    const el = canvas.current;
    if (!el?.clientWidth) return;
    const room = cardRoom();
    // In 5% steps: the demo's window is narrower than the app's, and a 10% step down left the map smaller than it had to be.
    setZoom(Math.max(0.4, Math.min(1, Math.floor(Math.min((el.clientWidth - room) / layout.W, el.clientHeight / layout.H) * 20) / 20)));
    el.scrollTo({ left: 0, top: 0 });
  };
  // Opening: the map fits the window; a phone shows the checked-out branch instead. A narrow window folds the card, as a phone does.
  useLayoutEffect(() => {
    if (phone) return scrollTo(head);
    if (!cardRoom()) setFolded(true);
    fit();
  }, []);
  // Opening the agent panel narrows the map: the selected branch comes out from under the card.
  useEffect(() => {
    // A frame later: the canvas has its narrower width by then, so the scroll isn't cut short.
    if (!term || focused || phone) return;
    const id = requestAnimationFrame(() => scrollTo(shownSel, true));
    return () => cancelAnimationFrame(id);
  }, [!!term]);
  // The demo hears its keys on its root: as the map and the focus view swap, focus moves to the one shown, not out to the page.
  const swapped = useRef(false);
  useLayoutEffect(() => {
    if (swapped.current) root.current?.querySelector<HTMLElement>(focused ? '.focus-back' : '.map-canvas')?.focus({ preventScroll: true });
    swapped.current = true;
  }, [focused]);
  useLayoutEffect(() => {
    if (!reveal.current || focused || view !== 'workspace') return;
    scrollTo(reveal.current, true);
    reveal.current = undefined;
  });

  // Like workspace.switch: uncommitted work comes along.
  const checkout = (n: string) => {
    if (n === head) return;
    setBs((x) => ({ ...x, [head]: { ...x[head], wip: [] }, [n]: { ...x[n], wt: false, wip: [...x[n].wip, ...x[head].wip] } }));
    setHead(n);
  };
  const select = (n: string) => {
    // A phone's card starts folded, out of the map's way; picking another branch unfolds it.
    if (phone && n !== sel) setFolded(false);
    setSel(n);
    agents.wake(keyOf('acme-web', n));
  };
  /** Branch `n` full screen, on `item` (openFocus in Workspace.tsx). */
  const openFocus = (n: string, item: 'wip' | 'all' | 'project' | Commit) => {
    select(n);
    setCommit(typeof item === 'object' ? item : undefined);
    setMode(item === 'wip' ? 'wip' : item === 'project' ? 'project' : 'branch');
    setFile(undefined);
    setFocused(true);
    setPane('rail');
  };
  /** An agent on the branch, in its own worktree: same rules as start_agent_on in crates/core/src/app.rs. */
  const agentOn = (n: string, t: string, base = bs[n]?.base ?? 'main', ai?: Ai) => {
    if (n === 'main') return 'main is reserved: create a new branch for the agent.';
    if (n === head && bs[n].wip.length) return `${n} has uncommitted changes in the main checkout. Commit or stash them first: the agent gets its own worktree.`;
    if (n === head) setHead(base);
    setBs((x) => ({ ...x, [n]: { ...x[n], wt: true } }));
    agents.start({ project: 'acme-web', branch: n, base, behind: bs[n]?.behind }, t, ai);
  };
  const addBranch = (n: string, base: string) =>
    setBs((x) => ({
      ...x,
      [base]: { ...x[base], kids: [...(x[base].kids ?? []), n] },
      [n]: { name: n, kind: kindOfBranch(n) ?? undefined, role: 'branch', base, author: ME, ahead: 0, behind: 0, wip: [], files: [] },
    }));
  /** Takes `names` off the map: their worktree sessions end, and the checkout moves to the parent of one checked out. */
  const remove = (names: string[]) => {
    names.forEach((n) => agents.remove(keyOf('acme-web', n)));
    if (names.includes(head)) checkout(bs[head].base ?? 'main');
    if (names.includes(sel)) setSel(bs[sel].base ?? 'main');
    setBs((x) => {
      const y = { ...x };
      for (const n of names) {
        const p = y[n]?.base;
        if (p && y[p]) y[p] = { ...y[p], kids: y[p].kids?.filter((k) => k !== n) };
        delete y[n];
      }
      return y;
    });
  };
  /** A work branch's commits (uncommitted work as one more) join its base's; it stays on the map as merged, its worktree gone. */
  const merge = (n: string) => {
    const base = bs[n].base!;
    setBs((x) => {
      const g = x[n].wip.length ? fold(x[n], x[n].wip) : x[n];
      return { ...x, [n]: { ...g, merged: true, ahead: 0, push: 0, wt: false, wip: [] }, [base]: { ...x[base], ahead: x[base].ahead + g.ahead, log: [...logOf(g), ...(x[base].log ?? [])] } };
    });
    // Its work is in the base now: the checkout moves there.
    if (head === n) setHead(base);
  };
  /** Ends a worktree session. Merged, the branch turns into a chip under its base; deleted, it leaves the map; one with child branches only loses its worktree. */
  const finish: Demo['finish'] = (k, how, sw, note = '') => {
    const s = agents.get(k);
    if (!s) return;
    agents.remove(k);
    const n = s.branch;
    const x = bs[n];
    if (s.project === 'acme-web' && x) {
      const base = x.base ?? 'main';
      if (how === 'continue' || x.kids?.length) {
        // Its uncommitted changes are committed first; the app lets you pick: commit or discard.
        setBs((y) => ({ ...y, [n]: { ...(y[n].wip.length ? fold(y[n], y[n].wip) : y[n]), wt: false } }));
        if (sw && how === 'continue') checkout(n);
      } else if (how === 'merge') {
        merge(n);
        if (sw) checkout(base);
      } else remove([n]);
    }
    flash(how === 'continue' ? `Worktree closed: ${n} and its commits stay` : how === 'merge' ? `Merged ${n} into ${s.base}${note}` : `Deleted the worktree and ${n}`);
  };
  const commitAll = (n: string) => {
    const subject = aiSubject(bs[n].wip);
    setBs((x) => ({ ...x, [n]: fold(x[n], x[n].wip, subject) }));
    flash(`AI wrote: ${subject}`);
  };
  const push = (n: string) => {
    setBs((x) => ({ ...x, [n]: { ...x[n], push: 0 } }));
    flash(`Pushed ${n}`);
  };
  /** Replays `n` on its base (a work branch), or merges the base's new commits into it (a release or trunk). */
  const catchUp = (n: string) => {
    const x = bs[n];
    setBs((y) => ({ ...y, [n]: { ...y[n], behind: 0, idle: undefined } }));
    flash(x.role === 'branch' ? `Rebased ${n} onto ${labelOf(x.base!)}` : `${labelOf(n)} is up to date with ${labelOf(x.base!)}`);
  };
  // A new branch off `n`, picked: the app asks its type and name first, or names it from a ticket.
  const create = (n: string) => {
    let i = 1;
    while (bs[`feat/idea-${i}`]) i++;
    addBranch(`feat/idea-${i}`, n);
    select(`feat/idea-${i}`);
    reveal.current = `feat/idea-${i}`;
    flash(`Created feat/idea-${i} off ${labelOf(n)}. The app asks for its type and name first, or names it from a ticket`);
  };

  /** What the user most likely wants next for `n`, picked like `primary` in src/screens/BranchMenu.tsx. */
  const primary = (n: string): Act => {
    const x = bs[n];
    const out = n === head || !!x.wt;
    const parent = x.base ? labelOf(x.base) : '';
    const agent = agentOf(n);
    // Once the worktree's agent is done, wrap it up: merge into the parent and delete the worktree.
    if (x.wt && agent?.state === 'done') return { label: 'Finish and merge', icon: 'merged', tip: `Merge ${n} into ${parent}, then delete its worktree. Uncommitted changes get committed first`, run: () => finish(keyOf('acme-web', n), 'merge', false) };
    if (x.wip.length && out && agent?.state !== 'working') return { label: 'Stage & commit all', icon: 'sparkle', tip: `Stage the ${plural(x.wip.length, 'uncommitted file')} on ${n} and commit them. AI writes the message`, run: () => commitAll(n) };
    if (x.merged && !out) return { label: 'Delete', icon: 'trash', danger: true, tip: `${n} is merged into ${parent}: delete the local branch`, run: () => (remove([n]), flash(`Deleted ${n}`)) };
    if (x.role !== 'branch') {
      // Releases and trunks are shared: they catch up with their base by merging.
      if (x.behind && x.base) return { label: 'Update', icon: 'refresh', tip: `Merge the ${plural(x.behind, 'new commit')} from ${parent} into ${n}`, run: () => catchUp(n) };
      if (x.push) return { label: `Push ${x.push}`, icon: 'push', tip: `Push ${plural(x.push, 'commit')} to origin/${n}`, run: () => push(n) };
      if (x.base && x.ahead) return { label: 'Merge', icon: 'merged', tip: `Merge ${plural(x.ahead, 'commit')} into ${parent}`, run: () => flash(`Shipping ${labelOf(n)} merges it into ${parent}: Create tag & Update changelog… in its menu does both`) };
      if (!out) return { label: 'Switch', icon: 'swap', tip: `Check out ${n}`, run: () => (checkout(n), flash(`Switched to ${n}`)) };
      return { label: 'Pull', icon: 'refresh', tip: `Pull from origin/${n}`, run: () => flash(`${n} is up to date`) };
    }
    if (!out) return { label: 'Switch', icon: 'swap', tip: `Check out ${n}`, run: () => (checkout(n), flash(`Switched to ${n}`)) };
    if (x.wt)
      return {
        label: 'Continue',
        icon: 'swap',
        tip: `Delete the worktree of ${n} and check ${n} out here. Uncommitted changes there get committed first`,
        run: () => (agent?.state === 'working' ? flash(`The agent is still working on ${n}`, true) : agents.get(keyOf('acme-web', n)) ? finish(keyOf('acme-web', n), 'continue', true) : (checkout(n), flash(`Switched to ${n}`))),
      };
    if (x.push) return { label: `Push ${x.push}`, icon: 'push', tip: `Push ${plural(x.push, 'commit')} to origin/${n}`, run: () => push(n) };
    if (x.behind) return { label: 'Rebase', icon: 'branch', tip: `Replay ${n} on top of ${parent} (${plural(x.behind, 'commit')} behind)`, run: () => catchUp(n) };
    if (x.ahead) return { label: 'Merge', icon: 'merged', tip: `Merge ${plural(x.ahead, 'commit')} into ${parent}`, run: () => (merge(n), flash(`Merged ${n} into ${parent}`)) };
    return { label: 'Pull', icon: 'refresh', tip: `Pull from origin/${n}`, run: () => flash(`${n} is up to date`) };
  };
  // A branch's menu: a few entries of the context menu in src/screens/BranchMenu.tsx.
  const menuItems = (n: string): MenuItem[] => {
    const x = bs[n];
    const parent = x.base ? labelOf(x.base) : '';
    const out = n === head || !!x.wt;
    return [
      ...(out ? [] : [{ id: 'switch', label: 'Switch to branch', icon: 'swap', run: () => (checkout(n), flash(`Switched to ${n}`)) }]),
      { id: 'create', label: 'Create a branch from here', icon: 'plus', run: () => create(n) },
      'sep',
      { id: 'pull', label: <>Pull from <span className="mono">origin/{n}</span></>, icon: 'refresh', run: () => flash(`${n} is up to date`) },
      { id: 'push', label: 'Push', icon: 'push', hint: x.push ? `↑${x.push}` : undefined, run: () => (x.push ? push(n) : flash(`origin/${n} already has every commit`)) },
      ...(out ? [{ id: 'commit', label: 'Stage & commit all', icon: 'sparkle', hint: x.wip.length ? plural(x.wip.length, 'file') : 'nothing to commit', disabled: !x.wip.length, run: () => commitAll(n) }] : []),
      ...(x.base
        ? [
            'sep' as const,
            ...(x.role === 'branch' && !x.wt ? [{ id: 'rebase', label: <>Rebase onto <span className="mono">{parent}</span></>, icon: 'branch', hint: x.behind ? `${x.behind} behind` : undefined, run: () => catchUp(n) }] : []),
            { id: 'merge', label: <>{x.wt ? 'Finish and merge' : 'Merge'} into <span className="mono">{parent}</span>…</>, icon: 'merged', hint: x.ahead ? plural(x.ahead, 'commit') : 'nothing to merge', disabled: !x.ahead || x.merged, run: () => (x.role === 'branch' ? (merge(n), flash(`Merged ${n} into ${parent}`)) : primary(n).run()) },
            ...(x.wt ? [] : [{ id: 'pr', label: <>Open pull request into <span className="mono">{parent}</span></>, icon: 'pr', run: () => go('prs') }]),
          ]
        : []),
      'sep',
      {
        id: 'publish',
        label: 'Create tag & Update changelog…',
        icon: 'ship',
        // A release takes its version from its name; any other branch picks Major, Minor, Patch or a custom tag.
        run: () => flash(x.role === 'release' ? `Tag ${labelOf(n)}: the changelog gets its date, then ${n} is pushed with its tag` : `Tag ${n}: pick Major, Minor or Patch, or type any tag name (Custom), then push it with its tag`),
      },
      ...(n === 'main' ? [] : ['sep' as const, { id: 'delete', label: 'Delete branch…', icon: 'trash', danger: true, run: () => (remove([n]), flash(`Deleted ${n}`)) }]),
    ];
  };
  const openMenu = (n: string, e: MouseEvent, right = false) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu(right ? { x: r.right, y: r.bottom + 2, n, right } : { x: e.clientX, y: e.clientY, n, right });
  };

  // Branches falling behind a cleanup may delete: not the checked-out one, nor one with work or an agent on it.
  const staleLeft = Object.values(bs).filter((x) => layout.stale(x) && x.name !== head && !x.wip.length && !x.wt);
  const handlers: MapHandlers = {
    select,
    checkout: (n) => (checkout(n), flash(`Switched to ${n}`)),
    toggle: (k, on) => setToggles((m) => new Map(m).set(k, on)),
    look: (n, c) => openFocus(n, c),
    menu: (n, e) => (select(n), openMenu(n, e)),
    rebase: (n) => catchUp(n),
    create,
    cleanup: (n, list) => (remove(list.map((x) => x.name)), flash(`Deleted ${branches(list.length, 'merged branch')} under ${labelOf(n)}`)),
    worktree: (n) => demo.openWorktree(keyOf('acme-web', n)),
    stashes: (n) => flash(`${bs[n].stashes} stashes set aside on ${n}. In the app they list in place of its files, to pop, apply or drop`),
    tag: (t) => flash(`Checked out ${t} (detached HEAD)`),
  };

  // The search marks matching branches and steps through them, hiding none: tiles and the merged chips under them, in order.
  const q = finding ? query.trim().toLowerCase() : '';
  const hits = q ? layout.tiles.flatMap((t) => [t.b, ...t.merged].filter((x) => x.name.toLowerCase().includes(q) || labelOf(x.name).includes(q)).map((x) => x.name)) : [];
  const hit = hits.length ? hits[Math.min(hitAt, hits.length - 1)] : undefined;
  useEffect(() => {
    if (hit) scrollTo(hit, true);
  }, [hit]);
  const openFind = () => {
    setFinding(true);
    root.current?.querySelector<HTMLInputElement>('.map-find input')?.focus();
  };

  // A mouse drag anywhere on the map pans it; under 5 px it stays a click. Touch keeps its native scroll.
  const pan = useRef<{ x: number; y: number; l: number; t: number; on: boolean } | null>(null);
  const panned = useRef(false);
  const endPan = (e: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.on) {
      panned.current = true;
      delete e.currentTarget.dataset.panning;
    }
    pan.current = null;
  };

  const send = (t: string) => {
    if (ses && ses.status !== 'idle') {
      setText('');
      return agents.send(key, t);
    }
    const why = agentOn(b.name, t);
    setRefused((x) => ({ ...x, [b.name]: why ?? '' }));
    if (!why) setText('');
  };

  /** The commit box's Commit on `x`: its staged files, or with nothing staged, everything. */
  const commitBox = (x: Branch) => {
    if (!canCommitOn(x)) return;
    const staged = x.wip.filter((f) => f.staged);
    const done = staged.length ? staged : x.wip;
    const subject = summary.trim() || aiSubject(done);
    setBs((y) => ({ ...y, [x.name]: fold(x, done, subject, body.trim() || undefined) }));
    flash(summary.trim() ? `Committed: ${subject}` : `AI wrote: ${subject}`);
    setSummary('');
    setBody('');
    if (focused && done.length === x.wip.length) setMode('branch');
  };
  /** CommitBox in src/screens/Workspace.tsx, for `x`: the message (AI writes it when left empty) and Commit. */
  const commitArea = (x: Branch) => {
    const out = x.name === head || !!x.wt;
    const can = canCommitOn(x);
    const staged = x.wip.filter((f) => f.staged).length;
    return (
      <div className="col" style={{ padding: '10px 16px 14px', gap: 8, borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ justifyContent: 'space-between', minHeight: 24, margin: 0 }}>
          <button className="commit-sec" aria-expanded={msgOpen} onClick={() => setMsgOpen(!msgOpen)}>
            <Icon name="chevronDown" size={12} className="chev" />
            <span>Commit message</span>
          </button>
          {msgOpen && (
            <button className="btn btn-sm" style={{ height: 24, padding: '0 8px' }} disabled={!can} title="AI drafts a message from the changed files" onClick={() => { setSummary(aiSubject(x.wip)); setBody('Runs from the trunk to the checked-out branch and restarts on switch.'); }}>
              <Icon name="sparkle" size={12} />
              Draft
            </button>
          )}
        </div>
        {msgOpen && (
          <div className="col">
            <input className="input" style={{ height: 32, fontSize: 12.5, padding: '0 10px' }} value={summary} disabled={!can} onChange={(e) => setSummary(e.target.value)} placeholder={!out ? 'Check out this branch to commit' : !x.wip.length ? 'No changes to commit' : 'Summary — leave empty for AI'} aria-label="Summary" />
            <textarea className="textarea" rows={3} style={{ fontSize: 12.5, padding: '8px 10px', resize: 'none' }} value={body} disabled={!can} onChange={(e) => setBody(e.target.value)} placeholder="Description (optional)" aria-label="Description" />
          </div>
        )}
        <span className="split-btn" style={{ display: 'flex', width: '100%' }}>
          <button className="btn btn-primary split-main commit-btn" style={{ flex: '1 1 auto' }} disabled={!can} onClick={() => commitBox(x)}>
            <Icon name="sparkle" size={12} />
            <span>{staged ? 'Commit' : 'Stage all & Commit'}<span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>{staged || x.wip.length || null}</span></span>
          </button>
          <span className="btn btn-primary btn-icon split-more commit-btn" aria-hidden="true">
            <Icon name="more" size={14} />
          </span>
        </span>
      </div>
    );
  };

  const demo: Demo = {
    flash,
    go,
    openBranch: (n) => {
      go('workspace');
      setFocused(false);
      select(n);
      reveal.current = n;
    },
    openWorktree: (key) => {
      setWtPick({ key });
      go('worktrees');
    },
    wtPick,
    branches: bs,
    logOf,
    sel,
    head,
    addBranch,
    setBranch: (n, p) => setBs((x) => ({ ...x, [n]: { ...x[n], ...p } })),
    commit: (n) => setBs((x) => (x[n]?.wip.length ? { ...x, [n]: fold(x[n], x[n].wip) } : x)),
    agents,
    root,
    agentOn,
    finish,
  };

  // The focus view: its files, the one shown and where it sits among them.
  /** `x`'s files in list `m`: its uncommitted ones, its own changes, or every file of the project, changed or not. */
  const filesOf = (x: Branch, m: Mode): File[] =>
    m === 'wip'
      ? x.wip
      : m === 'branch'
        ? x.files
        : [...new Set([...PROJECT, ...x.files.map((f) => f.path), ...x.wip.map((f) => f.path)])].sort().map((p) => x.wip.find((f) => f.path === p) ?? x.files.find((f) => f.path === p) ?? { path: p, add: 0, del: 0, s: ' ' });
  const list: File[] = commit ? commit.files : filesOf(b, mode);
  const isWip = mode === 'wip' && !commit;
  const [railFold, toggleRailFold] = useFold(commit ? commit.sha : mode);
  // In the order the list shows them: staged files first.
  const listed = isWip ? [...list.filter((f) => f.staged), ...list.filter((f) => !f.staged)] : list;
  const current = list.find((f) => f.path === file) ?? (mode === 'project' && !commit ? (listed.find((f) => f.s !== ' ') ?? listed[0]) : listed[0]);
  const fileAt = current ? listed.indexOf(current) : -1;
  const unchanged = mode === 'project' && !commit && current?.s === ' ';
  const pickFile = (f: File) => {
    setFile(f.path);
    setPane('code');
  };
  const step = (d: number) => listed[fileAt + d] && setFile(listed[fileAt + d].path);
  /** Stage (or unstage) and discard buttons for files `fs` of branch `n`'s uncommitted work. */
  const fileActs = (n: string) => (fs: File[], name: string) => {
    const up = !fs[0]?.staged;
    const paths = fs.map((f) => f.path);
    return (
      <>
        <button className="btn btn-ghost btn-act" title={up ? 'Stage' : 'Unstage'} aria-label={`${up ? 'Stage' : 'Unstage'} ${name}`} onClick={() => setWip(n, (w) => w.map((f) => (paths.includes(f.path) ? { ...f, staged: up } : f)))}>
          <Icon name={up ? 'plus' : 'minus'} size={12} />
        </button>
        <button className="btn btn-ghost btn-act btn-danger" title="Discard changes" aria-label={`Discard changes to ${name}`} onClick={() => setWip(n, (w) => w.filter((f) => !paths.includes(f.path)))}>
          <Icon name="undo" size={12} />
        </button>
      </>
    );
  };
  /** Branch `n`'s uncommitted files under Staged and Unstaged, each side folding (WipList in Workspace.tsx). */
  const wipList = (n: string, list: File[], at: File | undefined, onPick: (f: File) => void, fd: { closed: boolean; n: number }) =>
    [true, false].map((sd) => {
      const side = list.filter((f) => !!f.staged === sd);
      if (!side.length) return null;
      const k = String(sd) as 'true' | 'false';
      return (
        <li key={k}>
          <div className="file-sec">
            <button className="file-sec-toggle" aria-expanded={secOpen[k]} onClick={() => setSecOpen((o) => ({ ...o, [k]: !o[k] }))}>
              <Icon name="chevronDown" size={12} className="chev" />
              <span>{sd ? 'Staged' : 'Unstaged'}</span>
              <span style={{ fontWeight: 400 }}>{side.length}</span>
            </button>
            <span className="file-sec-acts">{fileActs(n)(side, sd ? 'all staged files' : 'all unstaged files')}</span>
          </div>
          <ul hidden={!secOpen[k]}>
            <FileList key={fd.n} list={side} tree={tree} allClosed={fd.closed} current={at} onPick={onPick} actions={fileActs(n)} />
          </ul>
        </li>
      );
    });
  const agentHere = !!b.wt && !!ses;
  const agent = agentOf(b.name);
  const chain = lineageOf(layout, b.name);
  const sum = (l: File[], k: 'add' | 'del') => l.reduce((n, f) => n + f[k], 0);
  const nums = (l: File[]) => [<span key="add" className="mono c-add">+{sum(l, 'add')}</span>, <span key="del" className="mono c-del">−{sum(l, 'del')}</span>];
  const where = b.wt ? 'in its own worktree' : b.name === head ? 'checked out here' : 'not checked out';
  const [originText, originCls] = originOf(b);
  // What the code shows, above it: the item picked, and what can be done with it (Workspace.tsx).
  const top = commit
    ? null
    : mode === 'wip'
      ? {
          eyebrow: 'Not committed',
          title: agent?.state === 'working' ? `${agent.label} is still changing these files` : agent?.state ? `${agent.label} changed these files` : 'Your changes since the last commit',
          meta: [<span key="n">{plural(wipCount, 'file')}</span>, ...nums(b.wip), <span key="where">{where}</span>],
          acts: <button className="btn btn-sm" disabled={!wipCount || !isOut} title={isOut ? `Set aside ${plural(wipCount, 'uncommitted file')} on ${b.name}` : `Check out ${b.name} to stash its changes`} onClick={() => { setWip(b.name, () => []); setBs((x) => ({ ...x, [b.name]: { ...x[b.name], stashes: (x[b.name].stashes ?? 0) + 1 } })); flash(`Stashed changes on ${b.name}`); }}><Icon name="stash" size={12} />Stash</button>,
        }
      : mode === 'branch'
        ? {
            eyebrow: b.base ? 'All changes on this branch' : 'History',
            title: labelOf(b.name),
            meta: [<span key="c">{plural(b.ahead, 'commit')}</span>, <span key="f">{plural(list.length, 'file')}</span>, ...nums(list), b.base ? <span key="m">what merging into <span className="mono">{labelOf(b.base)}</span> brings</span> : null],
            acts: b.base && !b.wt && <button className="btn btn-sm" title={`Open a pull request into ${labelOf(b.base)}`} onClick={() => go('prs')}><Icon name="pr" size={12} />Open PR</button>,
          }
        : {
            eyebrow: 'Project · files at this branch',
            title: current?.path ?? 'Files',
            meta: [<span key="as">as it is on <span className="mono">{b.name}</span>{b.name === head ? ', with your changes' : ''}</span>],
            acts: current && <button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(current.path); flash('Copied the path'); }}><Icon name="copy" size={12} />Copy path</button>,
          };
  const note = !current ? '' : commit ? `in ${commit.sha}` : mode === 'wip' ? (current.staged ? 'staged' : 'not staged') : mode === 'branch' ? `all ${plural(b.ahead, 'commit')}${b.base ? ` vs ${labelOf(b.base)}` : ''}` : unchanged ? 'unchanged on this branch' : 'changed on this branch';
  const cut = current ? current.path.lastIndexOf('/') : -1;

  /** The selected branch, floating over the map: what it is, how it stands, and what to do next (SelectedCard in BranchMap.tsx). */
  const cb = bs[shownSel];
  const card = (() => {
    const c = cb;
    const p = primary(c.name);
    const look = lookItem(c);
    const ca = agentOf(c.name);
    const base = c.base ? labelOf(c.base) : '';
    const trunk = c.role === 'trunk';
    const rows: [string, ReactNode, string?][] = [];
    if (c.base) rows.push(['Parent', base]);
    if (c.merged) rows.push(['Merged into', base]);
    else if (c.role === 'release') rows.push(['Ships as', labelOf(c.name)]);
    if (c.role === 'branch' && !c.merged) {
      const words = ca && `${ca.label} · ${agentWords(ca)}`;
      rows.push([
        'Agent',
        ca ? (
          <button className="link-btn agent-link" style={{ color: 'inherit', textAlign: 'left' }} title="Open its session in Worktrees & agents" onClick={() => demo.openWorktree(keyOf('acme-web', c.name))}>
            {ca.state === 'working' ? <span className="glow-working"><span>{words}</span></span> : words}
          </button>
        ) : 'none',
        ca?.state === 'waiting' ? 'c-warn' : undefined,
      ]);
    }
    if (c.stashes) rows.push(['Stashes', <button className="link-btn" onClick={() => handlers.stashes(c.name)}>{c.stashes} stashes</button>]);
    // Its headline numbers, in the display face: how far it is from its base and what is uncommitted on it; for the default
    // branch, what the next release ships and how many are open.
    const big: [string, number, string?][] = trunk
      ? [['Unreleased', c.ahead], ['Releases open', layout.tiles.filter((t) => t.b.role === 'release').length], ['WIP files', c.wip.length]]
      : [['Ahead', c.ahead], ['Behind', c.behind, c.behind ? 'c-del' : undefined], ['WIP files', c.wip.length]];
    const tone = p.danger ? 'btn-danger' : 'btn-primary';
    const kind = c.role === 'branch' && c.kind;
    const name = c.role === 'release' ? `${labelOf(c.name)} · ${c.name}` : kind ? c.name.slice(kind.length + 1) : c.name;
    // With no uncommitted work, the files under the card wait for this button (filesButton in Workspace.tsx).
    const filesShown = mapFiles === c.name;
    return (
      <aside className="map-card" aria-label={`Selected branch ${c.name}`} data-folded={folded || undefined}>
        <div className="map-card-head">
          {/* Its kind and tags on one line above the name. */}
          <div className="map-card-tags">
            {kind && <span className="map-kind">{kind}</span>}
            <BranchTags b={c} head={head} />
          </div>
          {/* The name opens the branch full screen; folded, the eye says so. */}
          <h3 className="mono">
            <button className="map-card-look" title="Look at the code" onClick={() => openFocus(c.name, look)}>
              {folded ? (
                <>
                  {name.slice(0, -4)}
                  <span className="map-card-tail">
                    {name.slice(-4)}
                    <Icon name="eye" size={13} className="map-card-eye" />
                  </span>
                </>
              ) : (
                name
              )}
            </button>
          </h3>
          <button className="btn btn-icon map-card-fold" aria-expanded={!folded} aria-label={folded ? 'Show the selected branch' : 'Fold the selected branch'} onClick={() => setFolded(!folded)}>
            <Icon name="chevronDown" size={14} className="chev" />
          </button>
        </div>
        {!folded && (
          <>
            <div className="map-big">
              {big.map(([k, n, cls]) => (
                <div key={k}>
                  <b className={cls}>{n}</b>
                  <span className="label">{k}</span>
                </div>
              ))}
            </div>
            {rows.length > 0 && (
              <dl className="map-status">
                {rows.map(([k, v, cls]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className={cls}>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
        {/* Folded, the card still offers the suggested action. */}
        <div className="map-card-acts">
          <button className={`btn ${tone} split-main grow`} title={p.tip} onClick={p.run}>
            <Icon name={p.icon} size={14} />
            <span className="ellipsis">{p.label}</span>
          </button>
          <button className={`btn btn-icon ${tone} split-more`} aria-label={`More actions for ${c.name}`} title={`More actions for ${c.name}`} aria-haspopup="menu" aria-expanded={menu?.n === c.name && menu.right} onClick={(e) => (menu?.right ? setMenu(null) : openMenu(c.name, e, true))}>
            <Icon name="more" size={14} />
          </button>
          {!c.wip.length && (
            <button
              className="btn btn-sm map-card-files"
              aria-pressed={filesShown}
              title={filesShown ? 'Hide the files' : "Show the branch's files"}
              onClick={() => {
                setMapFiles(filesShown ? '' : c.name);
                // Hidden, its open file goes too.
                if (filesShown) setMapAt({ branch: c.name, mode: side.mode });
              }}
            >
              <Icon name="folder" size={12} />
              Files
            </button>
          )}
        </div>
      </aside>
    );
  })();

  // The card's branch's files under it, and the one picked from them over the map (MapFiles and MapDiff in Workspace.tsx):
  // on their own while it has uncommitted work, else once its Files button opens them. A phone has no room: the focus view lists them.
  const side = (() => {
    const at = mapAt.branch === cb.name ? mapAt : { branch: cb.name };
    return { ...at, mode: at.mode ?? (cb.wip.length ? 'wip' : cb.base ? 'branch' : 'project') } as { branch: string; mode: Mode; file?: string };
  })();
  const sideOpen = !phone && (cb.wip.length > 0 || mapFiles === cb.name);
  const sideList = filesOf(cb, side.mode);
  const sideWip = side.mode === 'wip' && sideList.length > 0;
  // In the order the list shows them: staged files first.
  const sideListed = sideWip ? [...sideList.filter((f) => f.staged), ...sideList.filter((f) => !f.staged)] : sideList;
  const sideFile = sideOpen ? sideList.find((f) => f.path === side.file) : undefined;
  const sideAt = sideFile ? sideListed.indexOf(sideFile) : -1;
  const [sideFold, toggleSideFold] = useFold(side.mode);
  const openSide = (f: File) => setMapAt({ branch: cb.name, mode: side.mode, file: f.path });
  const closeSide = () => setMapAt({ branch: cb.name, mode: side.mode });
  const stepSide = (d: number) => sideListed[sideAt + d] && openSide(sideListed[sideAt + d]);
  const files = sideOpen && (
    <section className="map-files" aria-label={`Files of ${cb.name}`}>
      <div className="map-files-head">
        <Seg
          label="Files"
          grid
          value={side.mode}
          onChange={(m) => setMapAt({ branch: cb.name, mode: m })}
          options={[
            ['wip', cb.wip.length > 0 ? <span className="wip-badge">WIP {cb.wip.length}</span> : <>WIP <span className="faint">0</span></>],
            ['branch', 'Branch'],
            ['project', 'Project'],
          ]}
        />
        {tree && <FoldBtn closed={sideFold.closed} onClick={toggleSideFold} />}
        <button className="btn btn-sm btn-icon" aria-label={tree ? 'Show files as a list' : 'Show files as a tree'} title={tree ? 'List view' : 'Tree view'} onClick={() => setTree(!tree)}>
          <Icon name={tree ? 'menu' : 'folder'} size={12} />
        </button>
      </div>
      <ul className="scroll map-files-list" data-wip={sideWip || undefined}>
        {sideWip ? wipList(cb.name, sideList, sideFile, openSide, sideFold) : <FileList key={sideFold.n} list={sideList} tree={tree} allClosed={sideFold.closed} current={sideFile} onPick={openSide} />}
        {sideList.length === 0 && (
          <li className="empty">
            {side.mode === 'wip' ? (cb.name === head || cb.wt ? 'No uncommitted changes.' : 'Not checked out: nothing uncommitted here.') : side.mode === 'project' ? 'No files.' : cb.base ? 'No changes on this branch yet.' : 'Nothing to compare: it is the base branch.'}
          </li>
        )}
      </ul>
      {side.mode === 'wip' && (cb.name === head || cb.wt) && commitArea(cb)}
    </section>
  );
  const sideCut = sideFile ? sideFile.path.lastIndexOf('/') : -1;
  const sideUnchanged = sideFile?.s === ' ';
  const fileDiff = sideFile && (
    <section className="map-diff" aria-label={`Changes to ${sideFile.path}`}>
      <div className="code-file">
        <span className={`file-st ${{ A: 'c-add', D: 'c-del', M: 'c-mod', ' ': 'faint' }[sideFile.s]}`}>{sideUnchanged ? '·' : sideFile.s}</span>
        <span className="code-path mono ellipsis" title={sideFile.path}>
          {sideCut >= 0 && <span className="faint">{sideFile.path.slice(0, sideCut + 1)}</span>}
          <b>{sideFile.path.slice(sideCut + 1)}</b>
        </span>
        <span className="row mono" style={{ gap: 6, margin: 0 }}>
          {sideFile.add ? <span className="c-add">+{sideFile.add}</span> : null}
          {sideFile.del ? <span className="c-del">−{sideFile.del}</span> : null}
        </span>
        {side.mode !== 'branch' && <span className="faint ellipsis code-note">{side.mode === 'wip' ? (sideFile.staged ? 'staged' : 'not staged') : sideUnchanged ? 'unchanged on this branch' : 'changed on this branch'}</span>}
        <span className="grow" />
        {sideListed.length > 1 && (
          <span className="code-files" role="group" aria-label="Files">
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous file ([)" title="Previous file ([)" disabled={sideAt <= 0} onClick={() => stepSide(-1)}>
              <Icon name="chevronLeft" size={12} />
            </button>
            <span>{`File ${sideAt + 1} of ${sideListed.length}`}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next file (])" title="Next file (])" disabled={sideAt >= sideListed.length - 1} onClick={() => stepSide(1)}>
              <Icon name="chevronRight" size={12} />
            </button>
          </span>
        )}
        {!sideUnchanged && <Seg label="Diff mode" value={mapDiffMode} onChange={setMapDiffMode} options={[['split', 'Split'], ['unified', 'Unified'], ['full', 'Full']]} />}
        {(cb.name === head || cb.wt) && sideFile.s !== 'D' && (
          <button className="btn btn-sm btn-icon" aria-label="Open in file explorer" title="Open in file explorer" onClick={() => flash(`In the app, this shows ${sideFile.path.slice(sideCut + 1)} in your file manager`)}>
            <Icon name="folder" size={12} />
          </button>
        )}
        <button className="btn btn-sm" aria-label="File history" title="Commits that changed this file" onClick={() => flash(`In the app, History lists the commits that changed ${sideFile.path.slice(sideCut + 1)}, beside the file`)}>
          <Icon name="history" size={12} />
          <span className="hide-narrow">History</span>
        </button>
        <button className="btn btn-sm btn-icon" aria-label="Close the file (Esc)" title="Close (Esc)" onClick={closeSide}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <Diff mode={sideUnchanged ? 'raw' : mapDiffMode} />
    </section>
  );

  const toggleBtn = (k: 'merged' | 'behind' | 'shipped', label: string, n: number) => (
    <button key={k} className="map-toggle" aria-pressed={prefs[k]} onClick={() => setPrefs({ ...prefs, [k]: !prefs[k] })}>
      <span className="map-box" aria-hidden="true"><Icon name="check" size={10} stroke={2.4} /></span>
      <span>{label}</span>
      <span className="faint">{n}</span>
    </button>
  );
  const st = !ses || term === 'shell' ? undefined : shown(ses);

  return (
    <DemoContext.Provider value={demo}>
    <div
      ref={root}
      className={phone ? 'ap hd hd-phone' : 'ap hd'}
      onKeyDown={(e) => {
        if (view !== 'workspace') return;
        const k = e.key.toLowerCase();
        // Ctrl+F (⌘F) finds branches while the map shows; anywhere else on the site it stays the browser's.
        if (k === 'f' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !focused) {
          e.preventDefault();
          return openFind();
        }
        // The focus view's keys, and those of a file open over the map (Workspace.tsx), outside a field, the agent panel or a
        // menu: [ and ] move through the files, S switches split and unified, Escape goes back to the map or closes the file.
        if (!(focused || fileDiff) || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, [role="menu"], [role="dialog"], .term')) return;
        const split = (m: 'split' | 'unified' | 'full') => (m === 'split' ? 'unified' : 'split');
        if (e.key === 'Escape') (focused ? setFocused(false) : closeSide());
        else if (e.key === '[' || e.key === ']') (focused ? step : stepSide)(e.key === '[' ? -1 : 1);
        else if (k === 's') (focused ? setDiffMode : setMapDiffMode)(split);
        else return;
        e.preventDefault();
      }}
    >
      {/* project tabs (src/components/TopBar.tsx) */}
      <header className="hdr">
        {/* Worktrees & agents: a tab of its own, marked like the open project's; the phone has its Agents tab instead. */}
        {!phone && (
          <button type="button" className={`hdr-icon${running.length ? ' glow-working' : ''}`} aria-label="Worktrees & agents" title={running.length ? `Worktrees & agents (${running.length} running)` : 'Worktrees & agents'} aria-current={wt ? 'page' : undefined} onClick={() => go('worktrees')}>
            <Icon name="layers" size={18} />
          </button>
        )}
        <span className="tabs-projects">
          {['acme-web', 'acme-api', 'design-system'].map((p, i) => {
            const label = (
              <>
                {running.some((s) => s.project === p) && <span className="pulse glow-dot" />}
                <FixedWidth>{p}</FixedWidth>
              </>
            );
            return (
              <span key={p} className={i === 2 ? 'tab-project hide-sm' : 'tab-project'} data-active={(i === 0 && !wt) || undefined}>
                {/* The open project's tab leaves the worktrees view for its page, as it was left; the others are for show. */}
                {i === 0 ? <button type="button" className="tab-project-open" aria-pressed={!wt} onClick={() => go(page)}>{label}</button> : <span className="tab-project-open" aria-hidden="true">{label}</span>}
                <span className="tab-project-close" aria-hidden="true"><Icon name="close" size={12} /></span>
              </span>
            );
          })}
          <span className="btn btn-ghost btn-icon" aria-hidden="true" style={{ height: 'auto', width: 42, flex: 'none', border: 0, borderRadius: 0 }}><Icon name="plus" /></span>
        </span>
        {/* The app's ProfileButton (src/components/Profiles.tsx); its Light / Dark mode is read off the page as src/components/ShellPane.tsx does, and Base.astro's script saves and shows the pick. */}
        <span className="hdr-tools">
          {!phone && (
            <button className="hdr-gear hide-narrow" aria-label="Settings" title="Settings" onClick={() => flash('In the app, the settings open here')}>
              <Icon name="gear" size={16} />
            </button>
          )}
          <button className="profile-btn" aria-haspopup="menu" aria-expanded={!!profile.at} aria-label="Profile Work, settings" title={profile.at ? undefined : 'Work'} onClick={(e) => profile.toggle(e, true)}>
            <ProfileAvatar size={26} />
          </button>
        </span>
      </header>
      {profile.at && (
        <Menu
          {...profile.at}
          x={profile.at.x - 6}
          alignRight
          label="Profile"
          onClose={profile.close}
          items={[
            {
              heading: (
                <span className="profile-head">
                  <ProfileAvatar size={34} />
                  <span className="col" style={{ gap: 1, minWidth: 0 }}>
                    <strong className="ellipsis">Work</strong>
                    <span>3 projects</span>
                  </span>
                </span>
              ),
            },
            'sep',
            { heading: 'Switch to' },
            ...PROFILES.map(([name, emoji, hue]) => ({
              id: name,
              icon: null,
              label: (
                <span className="ctx-profile">
                  <ProfileAvatar emoji={emoji} hue={hue} size={18} />
                  <span className="ellipsis">{name}</span>
                </span>
              ),
              run: () => flash(`${name} keeps its own projects, connections, tokens and AI setup`),
            })),
            { id: 'new', label: 'New profile…', icon: 'plus', run: () => flash('A profile gets a name, an emoji, photo or Gravatar, and a color') },
            'sep',
            { id: 'settings', label: 'Settings', icon: 'gear', run: () => flash('In the app, the settings open here') },
            {
              id: 'theme',
              label: document.documentElement.dataset.theme === 'light' ? 'Dark mode' : 'Light mode',
              icon: document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun',
              run: () => {
                const root = document.documentElement;
                dispatchEvent(new CustomEvent('themechange', { detail: otherMode(resolveTheme(root.dataset.palette ?? root.dataset.theme ?? '', root.dataset.theme === 'light' ? 'light' : 'dark')) }));
              },
            },
          ]}
        />
      )}
      {menu && bs[menu.n] && <Menu key={menu.n} x={menu.x} y={menu.y} alignRight={menu.right} label={`Actions for ${menu.n}`} onClose={() => setMenu(null)} items={menuItems(menu.n)} />}
      {/* page tabs, the accent underline sliding to the open one; the worktrees view has none */}
      <nav ref={tabsRef} aria-label="Pages" className="tabs-pages" hidden={wt}>
        {ink && <span className="tabs-ink" style={ink} aria-hidden="true" />}
        {PAGES.map((p) => (
          <button key={p.id} type="button" className="tab-page" aria-current={p.id === view ? 'page' : undefined} onClick={() => go(p.id)}>
            <Icon name={p.icon} size={14} />
            <FixedWidth>{p.label}</FixedWidth>
          </button>
        ))}
      </nav>

      <main className="ws" hidden={view !== 'workspace'}>
        <div className="ws-head">
          {focused ? (
            <div className="focus-head">
              <button className="btn btn-sm focus-back" title="Back to the branch map (Esc)" onClick={() => setFocused(false)}>
                <Icon name="back" size={14} />
                <span className="hide-narrow">Branch map</span>
                <kbd className="hide-narrow">Esc</kbd>
              </button>
              <nav className="focus-crumbs" aria-label="Where it comes from">
                {chain.map((c, i) => (
                  <Fragment key={c}>
                    {i > 0 && <span className="faint" aria-hidden="true">›</span>}
                    <button className="mono" aria-current={c === b.name || undefined} onClick={() => c !== b.name && openFocus(c, lookItem(bs[c]))}>
                      {labelOf(c)}
                    </button>
                  </Fragment>
                ))}
                <BranchTags b={b} head={head} />
              </nav>
              <span className="grow" />
              <span className="focus-pills hide-narrow">
                {b.role === 'branch' && b.base && !b.merged && (
                  <span>
                    ↑{b.ahead}
                    {b.behind > 0 && <span className="c-del"> ↓{b.behind}</span>} vs {labelOf(b.base)}
                  </span>
                )}
                {agent &&
                  (agent.state === 'working' ? (
                    <span>
                      <span className="pulse glow-dot" />
                      <span className="glow-working"><span>{agent.label} working</span></span>
                    </span>
                  ) : (
                    <span className={agent.state === 'waiting' ? 'c-warn' : undefined}>
                      {agent.state === 'waiting' && <span className="pulse map-wait" />}
                      {agent.label} {agentWords(agent)}
                    </span>
                  ))}
                {b.merged ? <span>merged into {labelOf(b.base!)}</span> : <span className={originCls}>{originText}</span>}
              </span>
            </div>
          ) : (
            // The map's toolbar (BranchMap.tsx), above the map and the agent panel.
            <div className="map-bar">
              <h2 className="map-title">Branch map</h2>
              <Seg
                label="Branches by person"
                value={prefs.who}
                onChange={(who) => setPrefs({ ...prefs, who })}
                options={[
                  ['all', <>Everyone <span className="faint">{layout.counts.open}</span></>],
                  ['me', <><Avatar name={ME} size={16} />Mine <span className="faint">{layout.counts.mine}</span></>],
                ]}
              />
              <div className="map-toggles" role="group" aria-label="Show on the map">
                {toggleBtn('merged', 'Merged', layout.counts.merged)}
                {staleLeft.length > 0 ? (
                  // Its Clean up as the toggle's right side: one control.
                  <span className="map-toggle-split">
                    {toggleBtn('behind', 'Falling behind', layout.counts.behind)}
                    <button className="map-clean" aria-label={`Pick which of the ${branches(staleLeft.length)} falling behind to delete`} title={`Pick which of the ${branches(staleLeft.length)} falling behind to delete`} onClick={() => (remove(staleLeft.map((x) => x.name)), flash(`Deleted ${branches(staleLeft.length)} falling behind`))}>
                      <Icon name="brush" size={12} />
                    </button>
                  </span>
                ) : (
                  toggleBtn('behind', 'Falling behind', layout.counts.behind)
                )}
                {toggleBtn('shipped', 'Shipped', SHIPPED.length)}
              </div>
              <span className="grow" />
              <span className="map-acts">
                <button className="btn btn-sm btn-icon" aria-label="Search branches" title="Search branches (Ctrl+F)" onClick={openFind}>
                  <Icon name="search" size={14} />
                </button>
                <button className="btn btn-sm" aria-label="Show 2 stashes" title="2 stashes set aside" onClick={() => handlers.stashes('feat/branch-tree')}>
                  <Icon name="stash" size={14} />2 stashes
                </button>
                <button className="btn btn-sm btn-icon" aria-label="Fetch origin" title="Fetch origin" onClick={() => flash('Fetched origin')}>
                  <Icon name="refresh" size={14} />
                </button>
              </span>
              <div className="map-group map-zoom" role="group" aria-label="Zoom">
                <button className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom out" disabled={zoom <= 0.4} onClick={() => setZoom(Math.round(zoom * 10 - 1) / 10)}>
                  <Icon name="minus" size={13} />
                </button>
                <span aria-live="polite">{Math.round(zoom * 100)}%</span>
                <button className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom in" disabled={zoom >= 1.4} onClick={() => setZoom(Math.round(zoom * 10 + 1) / 10)}>
                  <Icon name="plus" size={13} />
                </button>
                <button className="btn btn-ghost btn-sm" title="Fit the whole map in view" onClick={fit}>Fit</button>
              </div>
            </div>
          )}
        </div>
        <div className="ws-body">
          {!focused ? (
            <section className="map" aria-label="Branch map">
              {finding && (
                <FindBar
                  className="map-find"
                  label="Search branches"
                  icon={<Icon name="search" size={14} className="faint" />}
                  query={query}
                  onQuery={(v) => {
                    setQuery(v);
                    setHitAt(0);
                  }}
                  hits={{ i: Math.min(hitAt, hits.length - 1), n: hits.length }}
                  onStep={(back) => hits.length && setHitAt((i) => (Math.min(i, hits.length - 1) + (back ? -1 : 1) + hits.length) % hits.length)}
                  onClose={() => setFinding(false)}
                />
              )}
              {/* A file open over the map: the map under it holds still. */}
              <div className="map-view" data-file-open={fileDiff ? '' : undefined}>
                <div
                  ref={canvas}
                  className="map-canvas"
                  data-covered={fileDiff ? '' : undefined}
                  role="region"
                  aria-label="Branches"
                  // A click on the empty map keeps focus in the demo, so Ctrl+F finds a branch.
                  tabIndex={-1}
                  onDragStart={(e) => e.preventDefault()}
                  onPointerDown={(e) => {
                    const el = e.currentTarget;
                    panned.current = false;
                    // Not on the canvas's own scrollbars, past its client box.
                    if (e.button || e.pointerType === 'touch' || (e.target === el && (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight))) return;
                    pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop, on: false };
                  }}
                  onPointerMove={(e) => {
                    const p = pan.current;
                    if (!p) return;
                    const el = e.currentTarget;
                    if (!(e.buttons & 1)) return endPan(e);
                    const [dx, dy] = [e.clientX - p.x, e.clientY - p.y];
                    if (!p.on) {
                      if (Math.hypot(dx, dy) < 5) return;
                      p.on = true;
                      el.setPointerCapture(e.pointerId);
                      el.dataset.panning = '';
                    }
                    el.scrollLeft = p.l - dx;
                    el.scrollTop = p.t - dy;
                  }}
                  onPointerUp={endPan}
                  onPointerCancel={endPan}
                  // The click that ends a drag picks nothing.
                  onClickCapture={(e) => {
                    if (!panned.current) return;
                    panned.current = false;
                    e.stopPropagation();
                  }}
                >
                  {/* Room on the right for the card too, so a tile can be scrolled out from under it. */}
                  <div className="map-size" style={{ width: layout.W * zoom + (phone ? 0 : CARD_ROOM), height: layout.H * zoom, minWidth: '100%', minHeight: '100%' }}>
                    <div className="map-layer" style={{ width: layout.W, height: layout.H, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
                      <MapLayer layout={layout} head={head} shown={shownSel} toggles={toggles} q={q} hit={hit} agentOf={agentOf} logOf={logOf} labelOf={labelOf} on={handlers} />
                    </div>
                  </div>
                </div>
                {/* Floating over the view's bottom left, level with the card's column at the right. */}
                <MapLegendBox />
                {phone ? (
                  card
                ) : (
                  // The card, and the branch's files under it in the room it leaves.
                  <div className="map-side">
                    {card}
                    {files}
                  </div>
                )}
                {fileDiff}
              </div>
            </section>
          ) : (
            <section className="focus" aria-label={`${b.name} full screen`}>
              <div className="focus-body">
                {/* the branch's files (the rail in Workspace.tsx) */}
                <aside className="rail" aria-label="Changed files" data-pane data-active={pane === 'rail'}>
                  <div className="col rail-head">
                    <div className="row" style={{ alignItems: 'center', minWidth: 0, margin: 0 }}>
                      <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</span>
                      {b.base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{b.merged ? 'merged into' : 'from'} {labelOf(b.base)}</span>}
                      {tree && <FoldBtn closed={railFold.closed} onClick={toggleRailFold} style={{ marginLeft: 'auto', flex: '0 0 auto', alignSelf: 'center' }} />}
                      <button className="btn btn-sm btn-icon" style={{ marginLeft: tree ? 0 : 'auto', flex: '0 0 auto' }} aria-label={tree ? 'Show files as a list' : 'Show files as a tree'} title={tree ? 'List view' : 'Tree view'} onClick={() => setTree(!tree)}>
                        <Icon name={tree ? 'menu' : 'folder'} size={12} />
                      </button>
                    </div>
                    {commit ? (
                      // Opened from a commit on the map: its files, until closed back to the branch's.
                      <div className="commit-head">
                        <div className="col" style={{ gap: 3, minWidth: 0, flex: '1 1 auto' }}>
                          <span className="commit-subject">{commit.subject}</span>
                          <span className="commit-meta">
                            <span className="mono">{commit.sha}</span>
                            <span className="ellipsis">{commit.author}</span>
                            <span style={{ whiteSpace: 'nowrap' }}>{commit.when}</span>
                            <span style={{ whiteSpace: 'nowrap' }}>{plural(commit.files.length, 'file')}</span>
                            {nums(commit.files)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <Seg
                        label="File view"
                        grid
                        value={mode}
                        onChange={(m) => {
                          setMode(m);
                          setFile(undefined);
                        }}
                        options={[
                          ['wip', wipCount > 0 ? <span className="wip-badge">WIP {wipCount}</span> : <>WIP <span className="faint">{wipCount}</span></>],
                          ['branch', <>Branch <span className="faint">{b.files.length}</span></>],
                          ['project', 'Project'],
                        ]}
                      />
                    )}
                    {b.wt && <span className="hint mono ellipsis">{pathOf({ project: 'acme-web', branch: b.name })}</span>}
                  </div>
                  <ul className="scroll rail-files" data-wip={(isWip && list.length > 0) || undefined}>
                    {isWip && list.length > 0 ? (
                      wipList(b.name, list, current, pickFile, railFold)
                    ) : (
                      <FileList key={railFold.n} list={list} tree={tree} allClosed={railFold.closed} current={current} onPick={pickFile} />
                    )}
                    {list.length === 0 && (
                      <li className="empty engraved">{commit ? 'This commit changes no files.' : mode === 'wip' ? (isOut ? 'No uncommitted changes.' : 'This branch is not checked out.') : 'No changes on this branch yet.'}</li>
                    )}
                  </ul>
                  {/* CommitBox in src/screens/Workspace.tsx, gone while a commit shows */}
                  {!commit && commitArea(b)}
                </aside>
                {/* the code of what the rail picked */}
                <section aria-label="Code" className="focus-code" data-pane data-active={pane === 'code'}>
                  {top && (
                    <div className="code-top">
                      <div className="code-title">
                        <h2>{top.title}</h2>
                        <div className="code-meta">
                          <span className="faint">{top.eyebrow}</span>
                          {top.meta}
                        </div>
                      </div>
                      <div className="code-acts">{top.acts}</div>
                    </div>
                  )}
                  <div className="code-file">
                    {current ? (
                      <>
                        <span className={`file-st ${{ A: 'c-add', D: 'c-del', M: 'c-mod', ' ': 'faint' }[current.s]}`}>{current.s === ' ' ? '·' : current.s}</span>
                        <span className="code-path mono ellipsis" title={current.path}>
                          {cut >= 0 && <span className="faint">{current.path.slice(0, cut + 1)}</span>}
                          <b>{current.path.slice(cut + 1)}</b>
                        </span>
                        <span className="row mono hide-narrow" style={{ gap: 6, margin: 0 }}>
                          {current.add ? <span className="c-add">+{current.add}</span> : null}
                          {current.del ? <span className="c-del">−{current.del}</span> : null}
                        </span>
                        <span className="faint ellipsis hide-narrow code-note">{note}</span>
                      </>
                    ) : (
                      <span className="faint">No file selected</span>
                    )}
                    <span className="grow" />
                    {listed.length > 1 && (
                      <span className="code-files" role="group" aria-label="Files">
                        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous file ([)" title="Previous file ([)" disabled={fileAt <= 0} onClick={() => step(-1)}>
                          <Icon name="chevronLeft" size={12} />
                        </button>
                        <span className="hide-narrow">{fileAt >= 0 ? `File ${fileAt + 1} of ${listed.length}` : `${listed.length} files`}</span>
                        <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next file (])" title="Next file (])" disabled={fileAt >= listed.length - 1} onClick={() => step(1)}>
                          <Icon name="chevronRight" size={12} />
                        </button>
                      </span>
                    )}
                    {current && !unchanged && <Seg label="Diff mode" value={diffMode} onChange={setDiffMode} options={[['split', 'Split'], ['unified', 'Unified'], ['full', 'Full']]} />}
                    {current && (
                      <button className="btn btn-sm" aria-label="File history" title="Commits that changed this file" onClick={() => flash(`In the app, History lists the commits that changed ${current.path.slice(cut + 1)}, and Esc comes back`)}>
                        <Icon name="history" size={12} />
                        <span className="hide-narrow">History</span>
                      </button>
                    )}
                  </div>
                  {current ? <Diff mode={unchanged ? 'raw' : diffMode} /> : <div className={list.length ? 'diff empty' : 'diff empty engraved'}>{list.length ? 'No file selected.' : isWip ? 'Nothing to show — working tree is clean.' : 'Nothing to show for this.'}</div>}
                  <div className="code-foot">
                    <span><kbd>[</kbd><kbd>]</kbd>previous and next file</span>
                    <span><kbd>S</kbd>split or unified</span>
                    <span><kbd>Esc</kbd>back to the map</span>
                  </div>
                </section>
              </div>
            </section>
          )}
          {/* the agent or the shell (Terminal in src/screens/Workspace.tsx), docked on the right */}
          {term ? (
            <div className={max ? 'term term-max' : 'term'}>
              {/* Empty parts of the bar collapse it, like the closed bar opens it. */}
              <div className="term-tabs term-bar" onClick={(e) => !(e.target as HTMLElement).closest('button') && setTerm(null)}>
                <div className="term-side" style={{ flex: 'none' }}>
                  <button type="button" className="term-tab" style={{ borderLeft: 0 }} aria-pressed={term === 'agent'} onClick={() => setTerm('agent')}>
                    <Icon name="sparkle" size={12} />Agent
                  </button>
                  <button type="button" className="term-tab" style={{ borderRight: '1px solid var(--line)' }} aria-pressed={term === 'shell'} onClick={() => setTerm('shell')}>
                    <Icon name="terminal" size={12} />Shell
                  </button>
                </div>
                {term === 'agent' && agentHere && (
                  <>
                    <span className="term-tab" style={{ borderLeft: 0 }}>
                      {ses.status === 'running' && <span className="pulse glow-dot" />}
                      <span className="mono">{b.name}</span>
                      <span className="faint">worktree</span>
                    </span>
                    <button type="button" className="term-tab term-tab-x" aria-label={`Close ${b.name} session`} title="Close its worktree in Worktrees & agents" onClick={() => demo.openWorktree(key)}>
                      <Icon name="close" size={11} />
                    </button>
                  </>
                )}
                <div className="term-side" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-icon" style={TERM_BTN} aria-label={max ? 'Restore terminal size' : 'Expand terminal'} aria-pressed={max} title={max ? 'Restore' : 'Expand'} onClick={() => setMax(!max)}>
                    <Icon name={max ? 'minimize' : 'maximize'} size={16} />
                  </button>
                  <button className="btn btn-ghost btn-icon term-collapse" style={TERM_BTN} aria-label="Collapse agents" onClick={() => (setTerm(null), setMax(false))}>
                    <Icon name="chevronDown" size={16} />
                  </button>
                </div>
              </div>
              {term === 'agent' ? (
                <>
                  <AgentLog
                    s={ses}
                    empty={`Start an agent on ${b.name}: it gets its own worktree, so it keeps working while you switch branches.`}
                    picks={picks}
                    onPicks={setPicks}
                    error={refused[b.name]}
                    actions={ses && b.wt && ses.add + ses.del > 0 && <FinishCard s={ses} />}
                  />
                  <AgentInput
                    id={phone ? 'hdp-ask' : 'hd-ask'}
                    value={text}
                    onChange={setText}
                    picks={picks}
                    onPicks={setPicks}
                    onSend={send}
                    onStop={busy ? () => agents.stop(key) : undefined}
                    picker={<AgentPicker value={ses?.ai ?? agents.pick} onChange={(ai) => (ses ? agents.update(key, { ai }) : agents.setPick(ai))} />}
                    placeholder={busy ? 'Agent is working…' : agentHere ? 'Reply to the agent…' : 'Ask the agent anything…'}
                  />
                </>
              ) : (
                <div className="term-log hd-shell">
                  <div><span className="c-add">~/acme-web</span> <span className="c-acc">({head})</span> $ git status --short</div>
                  {bs[head].wip.map((f) => <div key={f.path}>&nbsp;M {f.path}</div>)}
                  <div><span className="c-add">~/acme-web</span> <span className="c-acc">({head})</span> $ <span className="blink">▍</span></div>
                </div>
              )}
            </div>
          ) : (
            // Closed: a strip down the right edge (a bar at the bottom on a phone) that opens it.
            <button className="row term-bar term-closed" onClick={() => setTerm('agent')}>
              <Icon name="terminal" />
              <span>
                {st ? (
                  <>
                    Agent ·{' '}
                    {/* Coloured as on Worktrees & agents: the running glow, else the status colour. */}
                    <span className={st === 'running' ? 'glow-working' : STATUS_SHOWN[st][1]}><span>{st}</span></span>
                  </>
                ) : (
                  'Agent'
                )}
              </span>
              {st === 'running' && <span className="pulse glow-dot" />}
              <span className="grow" />
              <Icon name="chevronUp" size={13} />
            </button>
          )}
        </div>
      </main>
      {phone && view === 'workspace' && focused && (
        <div className="pane-switch">
          <Seg label="Panel" grid value={pane} onChange={setPane} options={[['rail', 'Files'], ['code', listed.length ? `Code ${fileAt >= 0 ? `${fileAt + 1}/${listed.length}` : listed.length}` : 'Code & agent']]} />
        </div>
      )}
      {/* the other pages (src/components/demo), mounted on their first visit */}
      {VIEWS.map(({ id, Page }) => Page && seen.includes(id) && (
        <div key={id} className="pg" hidden={view !== id}>
          <Page />
        </div>
      ))}
      {phone && <MobileTabs page={view} go={go} />}
      {toast && <div className={`toast${toast.error ? ' error' : ''}`} role="status">{toast.text}</div>}
    </div>
    </DemoContext.Provider>
  );
}
