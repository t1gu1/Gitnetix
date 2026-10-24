import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
// The app's own icon set, so the demo draws the same glyphs.
import { Icon } from '../../../src/components/Icon';

/**
 * The hero's playable Workspace: a scripted copy of the app's screen.
 * Markup and class names follow src/components/TopBar.tsx, src/screens/Workspace.tsx, src/screens/BranchTree.tsx
 * and src/components/AgentLog.tsx, so the rules in site.css (scoped under .hd) can stay copies of src/styles/app.css.
 */

type File = { path: string; add: number; del: number; s: 'M' | 'A' | 'D' | ' '; staged?: boolean };
type Branch = {
  name: string;
  /** Work branch type: shown as a chip, and the name loses its prefix. */
  kind?: 'feat' | 'fix';
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
};
/** The orange path from the trunk to the checked-out row, measured off the rendered tree. */
type Path = { d: string; len: number; x: number; top: number; mid: number; bottom: number };
type Line = { kind: 'you' | 'steps' | 'ai' | 'wait' | 'err'; text: string };

const ME = 'Grace Hopper';
const BRANCHES: Record<string, Branch> = {
  main: { name: 'main', role: 'trunk', author: 'Ana Moreau', ahead: 0, behind: 0, wip: [], files: [], kids: ['release/0.6.0', 'feat/agent-pane'] },
  'release/0.6.0': {
    name: 'release/0.6.0', role: 'release', base: 'main', tag: 'Next', author: 'Ana Moreau', ahead: 9, behind: 0, wip: [],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 120, del: 34, s: 'M' }, { path: 'src/styles/app.css', add: 48, del: 6, s: 'M' }, { path: 'CHANGELOG.md', add: 22, del: 0, s: 'M' }],
    kids: ['feat/branch-tree', 'fix/stale-remote'],
  },
  'feat/branch-tree': {
    name: 'feat/branch-tree', kind: 'feat', role: 'branch', base: 'release/0.6.0', author: ME, ahead: 4, behind: 0,
    wip: [{ path: 'src/screens/BranchTree.tsx', add: 42, del: 6, s: 'M' }, { path: 'src/styles/app.css', add: 18, del: 0, s: 'M' }],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 96, del: 21, s: 'M' }, { path: 'src/lib/path.ts', add: 64, del: 0, s: 'A' }, { path: 'src/styles/app.css', add: 30, del: 4, s: 'M' }],
  },
  'fix/stale-remote': {
    name: 'fix/stale-remote', kind: 'fix', role: 'branch', base: 'release/0.6.0', author: 'Jules Laurent', ahead: 2, behind: 2, wip: [],
    files: [{ path: 'crates/core/src/git.rs', add: 14, del: 9, s: 'M' }],
  },
  'feat/agent-pane': {
    name: 'feat/agent-pane', kind: 'feat', role: 'branch', base: 'main', author: 'Riya Kapoor', ahead: 0, behind: 13, wip: [], files: [],
  },
};
const PROJECT = ['package.json', 'src/App.tsx', 'src/screens/BranchTree.tsx', 'src/screens/Workspace.tsx', 'src/styles/app.css'];

/** Same page list as PAGES in src/components/TopBar.tsx. */
const PAGES: [string, string, boolean?][] = [
  ['Workspace', 'home'], ['Release notes', 'tag'], ['Pull requests', 'pr'], ['Tickets', 'ticket', true],
  ['Worktrees & agents', 'layers', true], ['Submodules', 'box', true], ['Analytics', 'chart', true],
];

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

const TRY = 'add a pulse that travels down the branch path';

// Same as src/components/Avatar.tsx: initials on a colour picked from the name.
function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function initials(name: string) {
  const w = name.trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}
function Avatar({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="user-avatar" role="img" aria-label={name} title={name} style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: `hsl(${hue(name)} 45% 42%)` }}>
      {initials(name)}
    </span>
  );
}

// Claude's starburst, from src/components/AgentLog.tsx.
const RAYS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  const r = i % 2 ? 5.2 : 6.6;
  return `M${8 + 1.6 * Math.cos(a)} ${8 + 1.6 * Math.sin(a)}L${8 + r * Math.cos(a)} ${8 + r * Math.sin(a)}`;
}).join('');
const MARK = (
  <span className="ag-avatar" aria-hidden="true">
    <svg width={17} height={17} viewBox="0 0 16 16" stroke="#d97757" strokeWidth={1.7} strokeLinecap="round"><path d={RAYS} /></svg>
  </span>
);

/** Reserves the width of the bold rendering, like FixedWidth in src/components/ui.tsx. */
function FixedWidth({ children }: { children: ReactNode }) {
  return (
    <span className="fixed-w">
      <span>{children}</span>
      <span className="fixed-w-ghost" aria-hidden="true">{children}</span>
    </span>
  );
}

function Seg<T extends string>({ label, value, options, onChange, grid }: { label: string; value: T; options: [T, ReactNode][]; onChange: (v: T) => void; grid?: boolean }) {
  // The highlight slides to the pressed option, like useThumb in src/components/ui.tsx.
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ width: number; height: number; transform: string }>();
  const selected = options.findIndex(([v]) => v === value);
  useLayoutEffect(() => {
    const btns = ref.current!.querySelectorAll<HTMLElement>(':scope > button');
    const place = () => {
      const b = btns[selected];
      setThumb(b?.offsetWidth ? { width: b.offsetWidth, height: b.offsetHeight, transform: `translate(${b.offsetLeft}px, ${b.offsetTop}px)` } : undefined);
    };
    place();
    const ro = new ResizeObserver(place);
    btns.forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [selected, options.length]);
  return (
    <div ref={ref} role="group" aria-label={label} className={`hd-seg${grid ? ' grid' : ''}`}>
      {thumb && <span className="seg-thumb" style={thumb} aria-hidden="true" />}
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{grid ? l : <FixedWidth>{l}</FixedWidth>}</button>
      ))}
    </div>
  );
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

const labelOf = (b: string) => (b.startsWith('release/') ? `v${b.slice(8)}` : b);

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

/** Changed files as a flat list, or nested under their folders, like FileList in Workspace.tsx. */
function FileList({ list, tree, current, onPick, actions }: { list: File[]; tree: boolean; current?: File; onPick: (f: File) => void; actions?: (fs: File[], name: string) => ReactNode }) {
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
      const btn = (
        <button className="file-btn" style={{ paddingLeft: 14 + depth * 14 }} aria-expanded={!closed[key]} onClick={() => setClosed((c) => ({ ...c, [key]: !c[key] }))}>
          <Icon name="chevronDown" size={12} className="chev" />
          <span className="grow ellipsis faint">{name}</span>
          <Nums add={fs.reduce((n, f) => n + f.add, 0)} del={fs.reduce((n, f) => n + f.del, 0)} />
        </button>
      );
      return (
        <li key={key}>
          {actions ? <div className="file-row">{btn}<span className="file-acts">{actions(fs, key)}</span></div> : btn}
          <ul hidden={closed[key]}>{walk(sub, key, depth + 1)}</ul>
        </li>
      );
    }),
    ...d.files.map((f) => row(f, depth)),
  ];
  return <>{walk(buildTree(list), '', 0)}</>;
}

/** Unified, split or whole-file diff with the change map on its right, like src/components/DiffView.tsx. */
function Diff({ mode }: { mode: 'split' | 'unified' | 'full' }) {
  type Row = { k: ' ' | '+' | '-' | '@'; o?: number; n?: number; t: string };
  const rows: Row[] = mode === 'full' ? ABOVE.map((t, i) => ({ k: ' ', o: i + 84, n: i + 84, t })) : [{ k: '@', t: HUNK }];
  let o = 88;
  let n = 88;
  for (const [k, t] of DIFF) rows.push({ k, t, o: k === '+' ? undefined : o++, n: k === '-' ? undefined : n++ });
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
            <div className="diff-split">
              {pairs.map(([l, r], i) => (
                <div key={i} className="diff-split-row">
                  {[l && { ...l, num: l.k === '@' ? undefined : l.o }, r && { ...r, num: r.k === '@' ? undefined : r.n }].map((x, j) => (
                    <div key={j} className={`diff-half${x ? cls(x.k) : ' empty'}`}>
                      <span className="ln">{x?.num}</span>
                      <span className="sg">{x && sign(x.k)}</span>
                      <span className="tx">{x?.t}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="diff-u">
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

/** Dotted path, a solid stretch on the checked-out row, and a pulse that runs down it at the app's 90px/s and flares on arrival. */
function PathLine({ p }: { p: Path }) {
  const dur = Math.max(p.len, 1) / 90;
  const arrive = p.len / (p.len + 12);
  return (
    <svg className="hd-path" aria-hidden="true" key={p.d}>
      <defs>
        <linearGradient id="hd-cur" gradientUnits="userSpaceOnUse" x1="0" y1={p.top} x2="0" y2={p.bottom}>
          <stop offset="0" stopColor="var(--path-fg)" stopOpacity=".45" />
          <stop offset=".38" stopColor="var(--path-fg)" />
          <stop offset=".62" stopColor="var(--path-fg)" />
          <stop offset="1" stopColor="var(--path-fg)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* The row's lower half hides the grey nesting line behind it. */}
      <path d={`M${p.x} ${p.mid}V${p.bottom}`} stroke="var(--panel)" />
      <path d={p.d} stroke="var(--path-fg)" strokeDasharray="1 2" />
      <path d={`M${p.x} ${p.top}V${p.bottom}`} stroke="url(#hd-cur)" />
      <g className="hd-beam">
        <path d={p.d} stroke="var(--path-fg)" strokeWidth="5" strokeOpacity=".5" strokeDasharray={`12 ${p.len + 24}`} filter="blur(1.5px)">
          <animate attributeName="stroke-dashoffset" from="12" to={-p.len} dur={`${dur}s`} repeatCount="indefinite" />
        </path>
        <path d={p.d} stroke="#fff3dd" strokeDasharray={`12 ${p.len + 24}`}>
          <animate attributeName="stroke-dashoffset" from="12" to={-p.len} dur={`${dur}s`} repeatCount="indefinite" />
        </path>
        <circle cx={p.x} cy={p.mid} r="3" fill="var(--path-fg)" filter="blur(1.5px)" opacity="0">
          <animate attributeName="opacity" values="0;0;.9;0" keyTimes={`0;${arrive};${arrive};${Math.min(1, arrive + 1 / dur)}`} dur={`${dur}s`} repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  );
}

export default function HeroDemo() {
  const [bs, setBs] = useState(BRANCHES);
  const [head, setHead] = useState('feat/branch-tree');
  const [sel, setSel] = useState('feat/branch-tree');
  const [mode, setMode] = useState<'wip' | 'branch' | 'project'>('wip');
  const [tree, setTree] = useState(false);
  const [file, setFile] = useState<File>();
  const [diffMode, setDiffMode] = useState<'split' | 'unified' | 'full'>('unified');
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [secOpen, setSecOpen] = useState({ true: true, false: true });
  const [term, setTerm] = useState<'agent' | 'shell' | null>('agent');
  const [text, setText] = useState(TRY);
  const [logs, setLogs] = useState<Record<string, Line[]>>({});
  const [running, setRunning] = useState<string>();
  const [msgOpen, setMsgOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [toast, setToast] = useState<string>();
  const timers = useRef<number[]>([]);
  const treeRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState<Path | null>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Like the app's tree: the line runs 6px left of each row on the path and steps in at the top of each level's
  // child list (just under its "Child branches" toggle), down to the middle of the checked-out row.
  useLayoutEffect(() => {
    const t = treeRef.current;
    const chain: string[] = [];
    for (let n: string | undefined = head; n; n = bs[n].base) chain.unshift(n);
    const rows = chain.map((n) => t?.querySelector<HTMLElement>(`[data-row="${n}"]`));
    if (!t || rows.some((r) => !r)) return setPath(null);
    const box = t.getBoundingClientRect();
    const y = (v: number) => v - box.top + t.scrollTop;
    const x = (el: HTMLElement) => Math.round(el.getBoundingClientRect().left - box.left + t.scrollLeft) - 5.5;
    const first = rows[0]!.getBoundingClientRect();
    let cx = x(rows[0]!);
    let cy = y(first.top);
    let d = `M${cx} ${cy}`;
    let len = 0;
    for (const el of rows.slice(1)) {
      const k = y(el!.closest('.tree-open')!.getBoundingClientRect().top);
      const nx = x(el!);
      d += `V${k}H${nx}`;
      len += k - cy + Math.abs(nx - cx);
      cx = nx;
      cy = k;
    }
    const cur = rows.at(-1)!.getBoundingClientRect();
    const mid = y((cur.top + cur.bottom) / 2);
    d += `V${mid}`;
    len += mid - cy;
    setPath((p) => (p?.d === d ? p : { d, len, x: cx, top: y(cur.top), mid, bottom: y(cur.bottom) }));
  });
  // Re-measure when the window reflows the rows.
  const [, reflow] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => reflow((n) => n + 1));
    if (treeRef.current) ro.observe(treeRef.current);
    return () => ro.disconnect();
  }, [file, term]);

  // Like AgentLog: new lines keep the log scrolled to the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, running, sel]);

  const b = bs[sel];
  const isHead = sel === head;
  const log = logs[sel] ?? [];
  const wipCount = b.wip.length;
  const staged = b.wip.filter((f) => f.staged).length;
  const all = staged === 0;
  const canCommit = (isHead || !!b.wt) && wipCount > 0 && running !== sel;
  const later = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, ms));
  const flash = (t: string) => {
    setToast(t);
    later(2600, () => setToast(undefined));
  };
  const setWip = (n: string, f: (w: File[]) => File[]) => setBs((x) => ({ ...x, [n]: { ...x[n], wip: f(x[n].wip) } }));
  // Like workspace.switch: uncommitted work comes along.
  const checkout = (n: string) => {
    if (n === head) return;
    setBs((x) => ({ ...x, [head]: { ...x[head], wip: [] }, [n]: { ...x[n], wt: false, wip: [...x[n].wip, ...x[head].wip] } }));
    setHead(n);
  };
  const select = (n: string) => {
    setSel(n);
    setFile(undefined);
    setMode((n === head || bs[n].wt) && bs[n].wip.length ? 'wip' : 'branch');
  };
  // The row's main action for its state, picked like `primary` in src/screens/BranchMenu.tsx.
  const primary = (n: string): { icon: string; tip: string; run: () => void } => {
    const x = bs[n];
    const parent = x.base ? labelOf(x.base) : '';
    if (x.wt) return { icon: 'swap', tip: `Continue on ${n} here and delete its worktree`, run: () => (running === n ? flash(`The agent is still working on ${n}`) : checkout(n)) };
    if (x.role === 'release' && x.ahead) return { icon: 'ship', tip: `Fast-forward main to ${n} and tag ${labelOf(n)}`, run: () => flash(`Ship ${labelOf(n)}: fast-forward main and tag it`) };
    if (n !== head) return { icon: 'swap', tip: `Check out ${n}`, run: () => checkout(n) };
    if (x.role === 'branch' && x.behind) return { icon: 'branch', tip: `Replay ${n} on top of ${parent} (${plural(x.behind, 'commit')} behind)`, run: () => flash(`Rebased ${n} onto ${parent}`) };
    if (x.role === 'branch' && x.ahead) return { icon: 'merged', tip: `Merge ${plural(x.ahead, 'commit')} into ${parent}`, run: () => flash(`Merge ${plural(x.ahead, 'commit')} into ${parent}…`) };
    return { icon: 'refresh', tip: `Pull from origin/${n}`, run: () => flash(`${n} is up to date`) };
  };

  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    const at = sel;
    const add = (l: Line) => setLogs((x) => ({ ...x, [at]: [...(x[at] ?? []).filter((y) => y.kind !== 'wait'), l] }));
    // Same rules as start_agent_on in crates/core/src/app.rs.
    if (at === 'main') return add({ kind: 'err', text: 'main is reserved: create a new branch for the agent.' });
    if (at === head && bs[at].wip.length) return add({ kind: 'err', text: `${at} has uncommitted changes in the main checkout. Commit or stash them first: the agent gets its own worktree.` });
    if (at === head) setHead(bs[at].base ?? 'main');
    setBs((x) => ({ ...x, [at]: { ...x[at], wt: true } }));
    setText('');
    setRunning(at);
    add({ kind: 'you', text: t });
    later(1300, () => add({ kind: 'steps', text: 'Read src/screens/BranchTree.tsx\nRead src/styles/app.css\nEdit src/screens/BranchTree.tsx\nBash npm test' }));
    later(3000, () => {
      add({ kind: 'ai', text: 'Done: the pulse now runs from the trunk to the checked-out branch and restarts when you switch. Tests pass. Want me to slow it down on long paths?' });
      add({ kind: 'wait', text: '' });
      setRunning(undefined);
      setWip(at, (w) => [...w.filter((f) => f.path !== 'src/lib/pulse.ts'), { path: 'src/lib/pulse.ts', add: 31, del: 0, s: 'A' }]);
    });
  };
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunning(undefined);
    if (running) setLogs((x) => ({ ...x, [running]: [...(x[running] ?? []), { kind: 'wait', text: '' }] }));
  };

  const commit = () => {
    if (!canCommit) return;
    // The committed changes join the branch's own; with nothing staged, everything goes.
    const done = all ? b.wip : b.wip.filter((f) => f.staged);
    const files = b.files.map((f) => {
      const w = done.find((x) => x.path === f.path);
      return w ? { ...f, add: f.add + w.add, del: f.del + w.del } : f;
    });
    const added = done.filter((w) => !b.files.some((f) => f.path === w.path)).map(({ staged: _, ...f }) => f);
    const left = b.wip.filter((f) => !done.includes(f));
    setBs((x) => ({ ...x, [sel]: { ...b, ahead: b.ahead + 1, wip: left, files: [...files, ...added] } }));
    flash(summary.trim() ? `Committed: ${summary.trim()}` : 'AI wrote: Pulse along the branch path');
    setSummary('');
    setBody('');
    if (!left.length) setMode('branch');
  };

  const shows = (n: string): boolean => !filter || n.includes(filter) || !!bs[n].kids?.some(shows);
  const below = (n: string): string[] => (bs[n].kids ?? []).flatMap((k) => [k, ...below(k)]);

  const row = (n: string): ReactNode => {
    if (!shows(n)) return null;
    const x = bs[n];
    const cur = n === head;
    const tracked = !!x.base;
    const typed = x.role === 'branch' && !!x.kind;
    const name = x.role === 'release' ? labelOf(n) : typed ? n.slice(n.indexOf('/') + 1) : n;
    const wip = x.wip.length > 0 && <span className="wip-badge">WIP {x.wip.length}</span>;
    const p = primary(n);
    const kids = (x.kids ?? []).filter(shows);
    const open = !closed[n] || !!filter;
    const pathLive = below(n).includes(head);
    const wipBelow = open ? 0 : below(n).reduce((t, k) => t + bs[k].wip.length, 0);
    return (
      <div key={n} role="group" className="tree-node">
        <div className="tree-row" data-row={n} data-current={cur || undefined} data-role={x.role}>
          <button className="tree-btn" aria-pressed={n === sel} onClick={() => select(n)} onDoubleClick={() => !x.wt && checkout(n)}>
            <span className="tree-lead">
              <span className="tree-icon"><Icon name={x.role === 'trunk' ? 'home' : x.role === 'release' ? 'tag' : 'branch'} size={13} stroke={1.5} /></span>
              <Avatar name={x.author} />
            </span>
            <span className="tree-main">
              <span className="tree-name">
                <span className="mono ellipsis">{name}</span>
                {x.tag && <span className="tag accent">{x.tag}</span>}
              </span>
              <span className="branch-meta">
                {typed && wip}
                {typed && !wip && <span className={`kind-chip ${x.kind === 'fix' ? 'c-del' : 'c-mod'}`}>{x.kind}</span>}
                {x.role === 'release' && <span className="mono">{n}</span>}
                {cur && <span className="c-current">checked out</span>}
                {!typed && !x.wt && wip}
                {tracked && x.ahead > 0 && <span className="meta-link">{plural(x.ahead, 'commit')}</span>}
                {tracked && x.ahead === 0 && x.role === 'branch' && <span>no commits yet</span>}
                {!tracked && <span className="meta-link">all commits</span>}
                {tracked && x.behind > 0 && <span className="c-warn">↓{x.behind} from {labelOf(x.base!)}</span>}
              </span>
              {x.wt && (
                <span className="branch-meta">
                  <span className={`row${running === n ? ' c-acc' : ''}`} style={{ gap: 4 }}><Icon name="layers" size={11} stroke={1.4} />{running === n ? <span className="ai-fade">AI working</span> : 'worktree'}</span>
                  {running !== n && logs[n]?.at(-1)?.kind === 'wait' && <span className="c-add ai-fade">waiting</span>}
                  {!typed && wip}
                </span>
              )}
            </span>
          </button>
          <span className="tree-acts">
            <span className="acts">
              <button className="act act-main" aria-label={p.tip} title={p.tip} onClick={p.run}>
                <Icon name={p.icon} size={14} />
              </button>
              <span className="act-stack" aria-hidden="true">
                <span className="act"><Icon name="plus" size={12} /></span>
                <span className="act"><Icon name="more" size={13} /></span>
              </span>
            </span>
          </span>
        </div>
        {kids.length > 0 && (
          <div className="tree-sub">
            <button className="tree-row tree-group tree-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the child branches of ${n}`} onClick={() => setClosed((c) => ({ ...c, [n]: open }))}>
              <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
              <span className="child-label" data-active={pathLive || undefined}>Child branches</span>
              <span className="faint">{kids.length}</span>
              {wipBelow > 0 && <span className="wip-badge">(WIP {wipBelow})</span>}
            </button>
            {open && (
              <div className="tree-open">
                <div className="tree-kids">{kids.map(row)}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const list: File[] = mode === 'wip' ? b.wip : mode === 'branch' ? b.files : PROJECT.map((p) => ({ path: p, add: 0, del: 0, s: ' ' as const }));
  const fileActs = (fs: File[], name: string) => {
    const up = !fs[0]?.staged;
    const paths = fs.map((f) => f.path);
    return (
      <>
        <button className="btn btn-ghost btn-act" title={up ? 'Stage' : 'Unstage'} aria-label={`${up ? 'Stage' : 'Unstage'} ${name}`} onClick={() => setWip(sel, (w) => w.map((f) => (paths.includes(f.path) ? { ...f, staged: up } : f)))}>
          <Icon name={up ? 'plus' : 'minus'} size={12} />
        </button>
        <button className="btn btn-ghost btn-act btn-danger" title="Discard changes" aria-label={`Discard changes to ${name}`} onClick={() => setWip(sel, (w) => w.filter((f) => !paths.includes(f.path)))}>
          <Icon name="undo" size={12} />
        </button>
      </>
    );
  };
  const agentHere = !!b.wt && log.length > 0;

  return (
    <div className="ap hd">
      {/* project tabs (src/components/TopBar.tsx) */}
      <header className="hdr" aria-hidden="true">
        <span className="hdr-icon"><Icon name="menu" size={18} stroke={1.4} /></span>
        <span className="tabs-projects">
          {['acme-web', 'acme-api', 'design-system'].map((p, i) => (
            <span key={p} className={i === 2 ? 'tab-project hide-sm' : 'tab-project'} data-active={i === 0 || undefined}>
              <span className="tab-project-open"><FixedWidth>{p}</FixedWidth></span>
              <span className="tab-project-close"><Icon name="close" size={12} /></span>
            </span>
          ))}
          <span className="btn btn-ghost btn-icon" style={{ height: 'auto', width: 42, flex: 'none', border: 0, borderRadius: 0 }}><Icon name="plus" /></span>
        </span>
        <span className="hdr-tools">
          <span className="btn btn-ghost btn-icon theme-toggle">
            <Icon name="sun" size={15} stroke={1.4} className="hd-dark" />
            <Icon name="moon" size={15} stroke={1.4} className="hd-light" />
          </span>
        </span>
      </header>
      {/* screen tabs */}
      <nav className="tabs-pages" aria-hidden="true">
        {PAGES.map(([label, icon, small], i) => (
          <span key={label} className={small ? 'tab-page hide-sm' : 'tab-page'} aria-current={i === 0 ? 'page' : undefined}>
            <Icon name={icon} size={14} />
            <FixedWidth>{label}</FixedWidth>
          </span>
        ))}
      </nav>

      <div className="ws" data-file-open={file ? true : undefined}>
        {/* left: branches and the agent, or the open file's diff */}
        <div className="ws-left">
          {file ? (
            <section aria-label="Diff" className="ws-diff">
              <div className="pane-head" style={{ background: 'var(--panel)' }}>
                <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{file.path}</span>
                <span className="row mono" style={{ fontSize: 11.5, gap: 6 }}>
                  {file.add > 0 && <span className="c-add">+{file.add}</span>}
                  {file.del > 0 && <span className="c-del">−{file.del}</span>}
                </span>
                <span className="grow" />
                <Seg label="Diff mode" value={diffMode} onChange={setDiffMode} options={[['split', 'Split'], ['unified', 'Unified'], ['full', 'Full']]} />
                <button className="btn btn-sm btn-icon" style={{ marginLeft: 8 }} aria-label="Close file" title="Back to branches" onClick={() => setFile(undefined)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
              <Diff mode={diffMode} />
            </section>
          ) : (
            <section aria-label="Branches" className="ws-releases">
              <div className="pane-head">
                <span className="row" style={{ gap: 6 }}>
                  <span className="label">Branches</span>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <button className="btn btn-sm" aria-label="Show 2 stashes" title="2 stashes set aside" onClick={() => flash('2 stashes set aside on feat/branch-tree')}>
                    <Icon name="stash" size={12} stroke={1.6} />2
                  </button>
                  <button className="btn btn-sm btn-icon" aria-label="Fetch origin" onClick={() => flash('Fetched origin')}>
                    <Icon name="refresh" size={12} />
                  </button>
                  <span className="btn btn-sm hide-sm" aria-hidden="true">
                    <Icon name="plus" size={12} stroke={1.6} />Release
                  </span>
                </span>
              </div>
              <div className="tree-filter">
                <Icon name="search" size={12} className="faint" />
                <input type="search" className="input" placeholder="Filter branches" aria-label="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <span className="btn btn-sm" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                  <span className="ellipsis">All</span>
                  <Icon name="chevronDown" size={10} />
                </span>
              </div>
              <div className="scroll tree" ref={treeRef}>
                {path && <PathLine p={path} />}
                {row('main')}
                <div className="tree-row tree-group tree-merged tree-behind" aria-hidden="true">
                  <span className="tree-merged-toggle">
                    <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev hd-shut" /></span>
                    <span className="group-label">Branches falling behind</span>
                    <span className="faint">3</span>
                  </span>
                  <span className="act act-main tree-cleanup"><Icon name="brush" size={14} /></span>
                </div>
                <div className="tree-sep" />
                <div className="tree-row tree-group" aria-hidden="true">
                  <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev hd-shut" /></span>
                  <span className="shipped-label">Shipped</span>
                  <span className="faint">3</span>
                </div>
              </div>
            </section>
          )}
          {/* agent / shell (Terminal in src/screens/Workspace.tsx) */}
          {!file && (term ? (
            <div className="term">
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
                    <span className="term-tab" style={{ fontSize: 11.5, borderLeft: 0 }}>
                      {running === sel && <span className="pulse" />}
                      <span className="mono">{sel}</span>
                      <span className="faint">worktree</span>
                    </span>
                    <span className="term-tab term-tab-x" aria-hidden="true"><Icon name="close" size={11} /></span>
                  </>
                )}
                <div className="term-side" style={{ justifyContent: 'flex-end' }}>
                  <span className="btn btn-ghost hd-term-btn" aria-hidden="true"><Icon name="maximize" size={13} /></span>
                  <button className="btn btn-ghost hd-term-btn" aria-label="Collapse agents" onClick={() => setTerm(null)}>
                    <Icon name="chevronDown" size={13} />
                  </button>
                </div>
              </div>
              {term === 'agent' ? (
                <>
                  <div ref={logRef} className="term-log ag-log" aria-live="polite">
                    {log.length === 0 && <div className="ag-empty">Start an agent on {sel}: it gets its own worktree, so it keeps working while you switch branches.</div>}
                    {log.map((l, i) =>
                      l.kind === 'you' ? (
                        <div key={i} className="ag-you">
                          <div className="ag-you-row">
                            <Avatar name={ME} size={22} />
                            <div className="ag-bubble">{l.text}</div>
                          </div>
                        </div>
                      ) : l.kind === 'steps' ? (
                        <div key={i} className="ag-act">
                          {log[i - 1]?.kind === 'you' && MARK}
                          <details className="ag-steps" open>
                            <summary>
                              <span className="ag-steps-n">4 steps</span>
                              <span className="ellipsis">Read ×2 · Edit · Bash</span>
                            </summary>
                            <div className="ag-steps-list">
                              {l.text.split('\n').map((s) => (
                                <div key={s} className="ag-step">
                                  <span className="ag-step-name">{s.split(' ')[0]}</span>
                                  <span className="ag-step-detail">{s.slice(s.indexOf(' ') + 1)}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        </div>
                      ) : l.kind === 'err' ? (
                        <div key={i} className="ag-err">✕ {l.text}</div>
                      ) : l.kind === 'ai' ? (
                        <div key={i} className="ag-ai">
                          {log[i - 1]?.kind === 'you' && MARK}
                          <div className="md"><p>{l.text}</p></div>
                        </div>
                      ) : i === log.length - 1 ? (
                        <div key={i} className="ag-wait"><span className="ag-wait-chip">Your turn!</span></div>
                      ) : null,
                    )}
                    {running === sel && (
                      <div className="ag-act" role="status" aria-label="Agent is thinking">
                        {log.at(-1)?.kind === 'you' && MARK}
                        <span className="ag-dots" aria-hidden="true"><i /><i /><i /></span>
                      </div>
                    )}
                  </div>
                  <form className="term-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
                    <span className="mono c-acc" aria-hidden="true">›</span>
                    <label htmlFor="hd-ask" className="sr-only">Ask the agent</label>
                    <input id="hd-ask" value={text} onChange={(e) => setText(e.target.value)} placeholder={running === sel ? 'Agent is working…' : agentHere ? 'Reply to the agent…' : 'Ask the agent anything…'} />
                    <div className="picker-acts" aria-hidden="true">
                      <span className="picker-act hd-opt"><span className="ellipsis">Claude</span><Icon name="chevronDown" size={10} /></span>
                      <span className="picker-act"><span className="ellipsis">Claude Opus 5.5</span><Icon name="chevronDown" size={10} /></span>
                      <span className="picker-act"><span className="ellipsis">xhigh</span><Icon name="chevronDown" size={10} /></span>
                    </div>
                    {running === sel ? (
                      <button type="button" className="btn btn-sm btn-danger btn-icon" aria-label="Stop the agent" title="Stop" onClick={stop}>
                        <Icon name="stop" size={16} />
                      </button>
                    ) : (
                      <button type="submit" className="btn btn-sm btn-primary btn-icon" aria-label="Send" title="Send" disabled={!text.trim() || !!running}>
                        <Icon name="send" size={20} />
                      </button>
                    )}
                  </form>
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
            <button className="row term-bar hd-term-closed" onClick={() => setTerm('agent')}>
              <Icon name="terminal" />
              <span>{term === null && running ? 'Agent · running' : 'Agent'}</span>
              {running && <span className="pulse" />}
              <span className="grow" />
              <Icon name="chevronUp" size={13} />
            </button>
          ))}
        </div>

        {/* right: the selected branch's files */}
        <section aria-label="Changed files" className="ws-files">
          <div className="col" style={{ gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ alignItems: 'center', minWidth: 0, margin: 0 }}>
              <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</span>
              {b.base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>from {b.base}</span>}
              {tree && (
                <span className="btn btn-sm btn-icon" style={{ marginLeft: 'auto', flex: '0 0 auto' }} aria-hidden="true">
                  <Icon name="chevronDown" size={12} className="chev" />
                </span>
              )}
              <button className="btn btn-sm btn-icon" style={{ marginLeft: tree ? 0 : 'auto', flex: '0 0 auto' }} aria-label={tree ? 'Show files as a list' : 'Show files as a tree'} title={tree ? 'List view' : 'Tree view'} onClick={() => setTree(!tree)}>
                <Icon name={tree ? 'menu' : 'folder'} size={12} />
              </button>
            </div>
            <Seg
              label="File view"
              grid
              value={mode}
              onChange={setMode}
              options={[
                ['wip', wipCount > 0 ? <span className="wip-badge">WIP {wipCount}</span> : <>WIP <span className="faint">{wipCount}</span></>],
                ['branch', <>Branch <span className="faint">{b.files.length}</span></>],
                ['project', 'Project'],
              ]}
            />
          </div>
          <ul className="scroll" style={{ flex: '1 1 auto', margin: 0, padding: mode === 'wip' && list.length > 0 ? '0 0 6px' : '6px 0' }}>
            {mode === 'wip' && list.length > 0 ? (
              [true, false].map((st) => {
                const side = list.filter((f) => !!f.staged === st);
                if (!side.length) return null;
                const k = String(st) as 'true' | 'false';
                return (
                  <li key={k}>
                    <div className="file-sec">
                      <button className="file-sec-toggle" aria-expanded={secOpen[k]} onClick={() => setSecOpen((o) => ({ ...o, [k]: !o[k] }))}>
                        <Icon name="chevronDown" size={12} className="chev" />
                        <span>{st ? 'Staged' : 'Unstaged'}</span>
                        <span style={{ fontWeight: 400 }}>{side.length}</span>
                      </button>
                      <span className="file-sec-acts">{fileActs(side, st ? 'all staged files' : 'all unstaged files')}</span>
                    </div>
                    <ul hidden={!secOpen[k]}>
                      <FileList list={side} tree={tree} current={file} onPick={setFile} actions={fileActs} />
                    </ul>
                  </li>
                );
              })
            ) : (
              <FileList list={list} tree={tree} current={file} onPick={setFile} />
            )}
            {list.length === 0 && (
              <li className="empty engraved">{mode === 'wip' ? (isHead || b.wt ? 'No uncommitted changes.' : 'This branch is not checked out.') : 'No changes on this branch yet.'}</li>
            )}
          </ul>
          {/* CommitBox in src/screens/Workspace.tsx */}
          <div className="col" style={{ padding: '6px 12px 10px', gap: 6, borderTop: '1px solid var(--line)' }}>
            <div className="row faint" style={{ justifyContent: 'space-between', fontSize: 11, margin: 0 }}>
              <button className="row hd-msg-toggle" aria-expanded={msgOpen} onClick={() => setMsgOpen(!msgOpen)}>
                <Icon name="chevronDown" size={12} className="chev" />
                <span>Commit message</span>
              </button>
              {msgOpen && (
                <button className="btn btn-ghost btn-sm" style={{ height: 20 }} disabled={!canCommit} title="AI drafts a message from the changed files" onClick={() => { setSummary('Pulse along the branch path'); setBody('Runs from the trunk to the checked-out branch and restarts on switch.'); }}>
                  <Icon name="sparkle" size={10} />
                  Draft
                </button>
              )}
            </div>
            {msgOpen && (
              <div className="col">
                <input className="input" style={{ height: 32, fontSize: 12.5, padding: '0 10px' }} value={summary} disabled={!canCommit} onChange={(e) => setSummary(e.target.value)} placeholder={!isHead && !b.wt ? 'Check out this branch to commit' : !wipCount ? 'No changes to commit' : 'Summary — leave empty for AI'} aria-label="Summary" />
                <textarea className="textarea" rows={3} style={{ fontSize: 12.5, padding: '8px 10px', resize: 'none' }} value={body} disabled={!canCommit} onChange={(e) => setBody(e.target.value)} placeholder="Description (optional)" aria-label="Description" />
              </div>
            )}
            <span className="split-btn" style={{ display: 'flex', width: '100%' }}>
              <button className="btn btn-primary split-main commit-btn" style={{ flex: '1 1 auto' }} disabled={!canCommit} onClick={commit}>
                <Icon name="sparkle" size={12} />
                <span>{all ? 'Stage all & Commit' : 'Commit'}<span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 6 }}>{all ? wipCount || null : staged}</span></span>
              </button>
              <span className="btn btn-primary btn-icon split-more commit-btn" aria-hidden="true">
                <Icon name="more" size={14} />
              </span>
            </span>
          </div>
        </section>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
