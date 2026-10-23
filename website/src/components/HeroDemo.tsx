import { useEffect, useRef, useState, type ReactNode } from 'react';
// The app's own icon set, so the demo draws the same glyphs.
import { Icon } from '../../../src/components/Icon';

/** The hero's playable Workspace: a scripted copy of the app's screen, laid out like src/screens/Workspace.tsx. */

type File = { path: string; add: number; del: number; s: 'M' | 'A' | 'D' };
type Branch = {
  name: string;
  label?: string;
  role: 'trunk' | 'release' | 'branch';
  base?: string;
  tag?: string;
  av: [string, string];
  ahead: number;
  behind: number;
  wip: File[];
  files: File[];
  kids?: string[];
  /** Checked out in its own worktree, where an agent works. */
  wt?: boolean;
};
type Line = { kind: 'you' | 'steps' | 'ai' | 'wait' | 'err'; text: string };

const BRANCHES: Record<string, Branch> = {
  main: { name: 'main', role: 'trunk', av: ['AM', '#8e44ad'], ahead: 0, behind: 0, wip: [], files: [], kids: ['release/0.6.0', 'feat/agent-pane'] },
  'release/0.6.0': {
    name: 'release/0.6.0', label: 'v0.6.0', role: 'release', base: 'main', tag: 'Next', av: ['AM', '#8e44ad'], ahead: 9, behind: 0, wip: [],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 120, del: 34, s: 'M' }, { path: 'src/styles/app.css', add: 48, del: 6, s: 'M' }, { path: 'CHANGELOG.md', add: 22, del: 0, s: 'M' }],
    kids: ['feat/branch-tree', 'fix/stale-remote'],
  },
  'feat/branch-tree': {
    name: 'feat/branch-tree', role: 'branch', base: 'release/0.6.0', av: ['GH', '#b7791f'], ahead: 4, behind: 0,
    wip: [{ path: 'src/screens/BranchTree.tsx', add: 42, del: 6, s: 'M' }, { path: 'src/styles/app.css', add: 18, del: 0, s: 'M' }],
    files: [{ path: 'src/screens/BranchTree.tsx', add: 96, del: 21, s: 'M' }, { path: 'src/lib/path.ts', add: 64, del: 0, s: 'A' }, { path: 'src/styles/app.css', add: 30, del: 4, s: 'M' }],
  },
  'fix/stale-remote': {
    name: 'fix/stale-remote', role: 'branch', base: 'release/0.6.0', av: ['JL', '#2f7d6d'], ahead: 2, behind: 2, wip: [],
    files: [{ path: 'crates/core/src/git.rs', add: 14, del: 9, s: 'M' }],
  },
  'feat/agent-pane': {
    name: 'feat/agent-pane', role: 'branch', base: 'main', av: ['RK', '#3b6fd4'], ahead: 0, behind: 13, wip: [], files: [],
  },
};

const DIFF: [' ' | '+' | '-', string][] = [
  [' ', 'export function BranchTree({ o, selected }: Props) {'],
  [' ', '  const path = usePath(o.currentBranch);'],
  ['-', '  return <Tree path={path} />;'],
  ['+', '  const pulse = usePulse(path, 90);'],
  ['+', '  return <Tree path={path} pulse={pulse} />;'],
  [' ', '}'],
];

const TRY = 'add a pulse that travels down the branch path';

function Av({ b }: { b: Branch }) {
  return <span className="hd-av" style={{ background: b.av[1] }}>{b.av[0]}</span>;
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

function sum(fs: File[]) {
  return fs.reduce((t, f) => [t[0] + f.add, t[1] + f.del], [0, 0]);
}

function Nums({ add, del }: { add: number; del: number }) {
  return <span className="hd-nums mono">{add > 0 && <span className="c-add">+{add}</span>}{del > 0 && <span className="c-del">−{del}</span>}</span>;
}

/** Files grouped under their folder, with the folder's totals, like the app's tree view. */
function Files({ list, tree, onPick }: { list: File[]; tree: boolean; onPick: (f: File) => void }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const row = (f: File, nested: boolean) => (
    <button key={f.path} className="hd-file" style={{ paddingLeft: nested ? 30 : 14 }} onClick={() => onPick(f)}>
      <span className={`mono hd-st s-${f.s}`}>{f.s}</span>
      <span className="ellipsis">{tree ? f.path.split('/').pop() : f.path}</span>
      <Nums add={f.add} del={f.del} />
    </button>
  );
  if (!tree) return <>{list.map((f) => row(f, false))}</>;
  const dirs = [...new Set(list.map((f) => f.path.slice(0, f.path.lastIndexOf('/') + 1) || '/'))];
  return (
    <>
      {dirs.map((d) => {
        const fs = list.filter((f) => (f.path.slice(0, f.path.lastIndexOf('/') + 1) || '/') === d);
        const [a, r] = sum(fs);
        return (
          <div key={d}>
            {d !== '/' && (
              <button className="hd-file hd-dir" aria-expanded={!closed[d]} onClick={() => setClosed((c) => ({ ...c, [d]: !c[d] }))}>
                <Icon name="chevronDown" size={12} className="chev" />
                <span className="ellipsis">{d.slice(0, -1)}</span>
                <Nums add={a} del={r} />
              </button>
            )}
            {!closed[d] && fs.map((f) => row(f, d !== '/'))}
          </div>
        );
      })}
    </>
  );
}

export default function HeroDemo() {
  const [bs, setBs] = useState(BRANCHES);
  const [head, setHead] = useState('feat/branch-tree');
  const [sel, setSel] = useState('feat/branch-tree');
  const [mode, setMode] = useState<'wip' | 'branch' | 'project'>('wip');
  const [tree, setTree] = useState(true);
  const [file, setFile] = useState<File>();
  const [split, setSplit] = useState(true);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ kids: true });
  const [term, setTerm] = useState<'agent' | 'shell' | null>('agent');
  const [text, setText] = useState(TRY);
  const [logs, setLogs] = useState<Record<string, Line[]>>({});
  const [running, setRunning] = useState<string>();
  const [msgOpen, setMsgOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [toast, setToast] = useState<string>();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const b = bs[sel];
  const isHead = sel === head;
  const log = logs[sel] ?? [];
  const wipCount = b.wip.length;
  const canCommit = (isHead || !!b.wt) && wipCount > 0;
  const later = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, ms));
  const flash = (t: string) => {
    setToast(t);
    later(2600, () => setToast(undefined));
  };
  const select = (n: string) => {
    setSel(n);
    setFile(undefined);
    setMode(n === head && bs[n].wip.length ? 'wip' : 'branch');
  };

  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    const at = sel;
    const add = (l: Line) => setLogs((x) => ({ ...x, [at]: [...(x[at] ?? []), l] }));
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
      setBs((x) => ({ ...x, [at]: { ...x[at], wip: [...x[at].wip.filter((f) => f.path !== 'src/lib/pulse.ts'), { path: 'src/lib/pulse.ts', add: 31, del: 0, s: 'A' }] } }));
    });
  };

  const commit = () => {
    if (!canCommit) return;
    // The committed changes join the branch's own.
    const files = b.files.map((f) => {
      const w = b.wip.find((x) => x.path === f.path);
      return w ? { ...f, add: f.add + w.add, del: f.del + w.del } : f;
    });
    setBs((x) => ({ ...x, [sel]: { ...b, ahead: b.ahead + 1, wip: [], files: [...files, ...b.wip.filter((w) => !b.files.some((f) => f.path === w.path))] } }));
    flash(summary.trim() ? `Committed: ${summary.trim()}` : 'AI wrote: Pulse along the branch path');
    setSummary('');
    setMode('branch');
  };

  // Branches whose subtree holds the checked-out one: the path runs through them.
  const holds = (n: string): boolean => n === head || !!bs[n].kids?.some(holds);
  const shows = (n: string): boolean => !filter || n.includes(filter) || !!bs[n].kids?.some(shows);

  const row = (n: string): ReactNode => {
    if (!shows(n)) return null;
    const x = bs[n];
    const cur = n === head;
    const tracked = !!x.base;
    return (
      <div key={n}>
        <div className="hd-row" data-cur={cur || undefined} data-sel={n === sel || undefined} data-role={x.role}>
          <button className="hd-row-btn" onClick={() => select(n)} onDoubleClick={() => !x.wt && setHead(n)}>
            <span className="hd-lead">
              <Icon name={x.role === 'trunk' ? 'home' : x.role === 'release' ? 'tag' : 'branch'} size={13} />
            </span>
            <span className="hd-main">
              <span className="hd-name"><span className="mono ellipsis">{x.label ?? x.name}</span>{x.tag && <span className="hd-tag">{x.tag}</span>}</span>
              <span className="hd-meta">
                <Av b={x} />
                {x.role === 'release' && <span className="mono">{x.name}</span>}
                {cur && <span className="c-current">checked out</span>}
                {!x.wt && x.wip.length > 0 && <span className="hd-wip">WIP {x.wip.length}</span>}
                {!tracked && <span className="dul">all commits</span>}
                {tracked && (x.ahead ? <span className="dul">{plural(x.ahead, 'commit')}</span> : <span>no commits yet</span>)}
                {tracked && x.behind > 0 && <span className="c-warn">↓{x.behind} from {x.base === 'release/0.6.0' ? 'v0.6.0' : x.base}</span>}
              </span>
              {x.wt && (
                <span className="hd-meta">
                  <span className={running === n ? 'c-acc hd-pulse-txt' : 'hd-pulse-txt'}><Icon name="layers" size={11} stroke={1.4} />&nbsp;{running === n ? 'AI working' : 'worktree'}</span>
                  {x.wip.length > 0 && <span className="hd-wip">WIP {x.wip.length}</span>}
                </span>
              )}
            </span>
          </button>
          <span className="hd-acts">
            {!x.wt && <button className="hd-act hd-act-main" aria-label={cur ? `Pull ${n}` : `Switch to ${n}`} title={cur ? 'Pull' : 'Switch to this branch'} onClick={() => (cur ? flash(`${n} is up to date`) : setHead(n))}>
              <Icon name={cur ? 'refresh' : 'swap'} size={13} />
            </button>}
            <span className="hd-act-stack" aria-hidden="true"><span className="hd-act"><Icon name="plus" size={11} /></span><span className="hd-act"><Icon name="more" size={13} stroke={2.4} /></span></span>
          </span>
        </div>
        {x.kids && (n === 'main' ? (
          <>
            <button className="hd-grp" aria-expanded={!!open.kids} onClick={() => setOpen((o) => ({ ...o, kids: !o.kids }))}>
              <Icon name="chevronDown" size={12} className="chev" /><span className="lbl child">Child branches</span><span className="faint">{x.kids.length}</span>
            </button>
            {open.kids && <div className="hd-kids" data-path={holds(n) && n !== head ? '' : undefined}>{x.kids.map(row)}</div>}
          </>
        ) : (
          <div className="hd-kids" data-path={holds(n) && n !== head ? '' : undefined}>{x.kids.map(row)}</div>
        ))}
      </div>
    );
  };

  const list = mode === 'wip' ? b.wip : b.files;
  return (
    <div className="ap hd" style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 40px 120px -40px rgba(0,0,0,.7)', textAlign: 'left', lineHeight: '1.35' }}>
      {/* project tabs */}
      <div className="hd-bar" style={{ height: 42, background: 'var(--bg)' }}>
        <span className="hd-sq" aria-hidden="true"><Icon name="menu" size={16} /></span>
        <span className="ptab on">acme-web <span aria-hidden="true" className="faint">×</span></span>
        <span className="ptab">acme-api <span aria-hidden="true" className="faint">×</span></span>
        <span className="ptab hide-sm">design-system <span aria-hidden="true" className="faint">×</span></span>
        <span aria-hidden="true" className="ptab" style={{ padding: '0 14px' }}>+</span>
        <span style={{ flex: 1 }} />
        <span className="hd-sq" aria-hidden="true" style={{ borderRight: 0, borderLeft: '1px solid var(--line)' }}><Icon name="sun" size={16} /></span>
      </div>
      {/* screen tabs */}
      <div className="hd-bar" style={{ padding: '0 8px' }} aria-hidden="true">
        <span className="ntab on"><Icon name="home" size={14} />Workspace</span>
        <span className="ntab"><Icon name="tag" size={14} />Release notes</span>
        <span className="ntab"><Icon name="pr" size={14} />Pull requests</span>
        <span className="ntab hide-sm"><Icon name="ticket" size={14} />Tickets</span>
        <span className="ntab hide-sm"><Icon name="layers" size={14} />Worktrees &amp; agents</span>
        <span className="ntab hide-sm"><Icon name="box" size={14} />Submodules</span>
        <span className="ntab hide-sm"><Icon name="chart" size={14} />Analytics</span>
      </div>

      <div className="hd-body">
        {/* left: branches, or the open file's diff */}
        <div className="hd-left">
          {file ? (
            <section aria-label="Diff" className="hd-diff">
              <div className="hd-pane-head">
                <span className="mono ellipsis">{file.path}</span>
                <Nums add={file.add} del={file.del} />
                <span style={{ flex: 1 }} />
                <span className="seg hd-seg" role="group" aria-label="Diff mode">
                  <button className={split ? 'on' : ''} onClick={() => setSplit(true)}>Split</button>
                  <button className={split ? '' : 'on'} onClick={() => setSplit(false)}>Unified</button>
                </span>
                <button className="hd-ibtn" aria-label="Close file" title="Back to branches" onClick={() => setFile(undefined)}><Icon name="close" size={13} /></button>
              </div>
              <div className="hd-code mono">
                {split
                  ? DIFF.filter(([s]) => s !== '+').map(([s, t], i) => {
                      const right = s === '-' ? DIFF.filter(([k]) => k === '+') : [[' ', t] as const];
                      return right.map(([k, r], j) => (
                        <div key={`${i}-${j}`} className="hd-split">
                          <span className={j ? 'hd-ln empty' : s === '-' ? 'hd-ln del' : 'hd-ln'}>{j ? '' : `${i + 88}  ${t}`}</span>
                          <span className={k === '+' ? 'hd-ln add' : 'hd-ln'}>{`${i + j + 88}  ${r}`}</span>
                        </div>
                      ));
                    })
                  : DIFF.map(([s, t], i) => <div key={i} className={`hd-ln ${s === '+' ? 'add' : s === '-' ? 'del' : ''}`}>{`${i + 88} ${s} ${t}`}</div>)}
              </div>
            </section>
          ) : (
            <>
              <div className="hd-head">
                <span style={{ flex: 1, fontSize: 11, fontWeight: 600, letterSpacing: '.1em', color: 'var(--muted)' }}>BRANCHES</span>
                <button className="ibtn" aria-label="Pull 2 commits" onClick={() => flash('Pulled 2 commits into main')}><Icon name="stash" size={13} />2</button>
                <button className="ibtn" aria-label="Fetch" style={{ padding: 0 }} onClick={() => flash('Fetched origin')}><Icon name="refresh" size={13} /></button>
                <span className="ibtn hide-sm" aria-hidden="true"><Icon name="plus" size={12} />Release</span>
              </div>
              <label className="hd-filter">
                <Icon name="search" size={14} />
                <span className="sr-only">Filter branches</span>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches" />
                <span className="ibtn" aria-hidden="true" style={{ height: 28, gap: 8 }}>All <Icon name="chevronDown" size={10} /></span>
              </label>
              <div className="hd-tree">
                {row('main')}
                <div className="hd-grp" aria-hidden="true"><Icon name="chevronDown" size={12} className="chev hd-right" /><span className="lbl behind">Branches falling behind</span><span className="faint" style={{ flex: 1 }}>3</span><Icon name="brush" size={13} /></div>
                <div className="hd-grp" aria-hidden="true"><Icon name="chevronDown" size={12} className="chev hd-right" /><span className="lbl shipped">Shipped</span><span className="faint">3</span></div>
              </div>
              {/* agent / shell */}
              {term ? (
                <div className="hd-term">
                  <div className="hd-term-tabs">
                    <button className={term === 'agent' ? 'on' : ''} onClick={() => setTerm('agent')}><Icon name="sparkle" size={11} />Agent</button>
                    <button className={term === 'shell' ? 'on' : ''} onClick={() => setTerm('shell')}><Icon name="terminal" size={13} />Shell</button>
                    {term === 'agent' && bs[sel].wt && <span className="hd-term-label">{running === sel && <span className="hd-pulse" />}<span className="mono">{sel}</span><span className="faint">worktree</span></span>}
                    <span style={{ flex: 1 }} />
                    <span className="hd-term-x" aria-hidden="true"><Icon name="maximize" size={13} /></span>
                    <button className="hd-term-x" aria-label="Collapse agents" onClick={() => setTerm(null)}><Icon name="chevronDown" size={13} /></button>
                  </div>
                  {term === 'agent' ? (
                    <>
                      <div className="hd-log" aria-live="polite">
                        {log.length === 0 && <div className="hd-empty">Start an agent on {sel}: it gets its own worktree, so it keeps working while you switch branches.</div>}
                        {log.map((l, i) =>
                          l.kind === 'you' ? (
                            <div key={i} className="hd-you"><span className="hd-av" style={{ background: '#b7791f', width: 22, height: 22, fontSize: 9 }}>GH</span><span className="hd-bubble">{l.text}</span></div>
                          ) : l.kind === 'steps' ? (
                            <details key={i} className="hd-steps" open>
                              <summary><span className="hd-mark" aria-hidden="true"><Icon name="sparkle" size={11} /></span><b>4 steps</b><span className="ellipsis">Read ×2 · Edit · Bash</span></summary>
                              {l.text.split('\n').map((s) => <div key={s} className="hd-step mono"><span>{s.split(' ')[0]}</span>{s.slice(s.indexOf(' ') + 1)}</div>)}
                            </details>
                          ) : l.kind === 'err' ? (
                            <div key={i} className="c-del">✕ {l.text}</div>
                          ) : l.kind === 'ai' ? (
                            <p key={i} className="hd-ai">{l.text}</p>
                          ) : i === log.length - 1 ? (
                            <span key={i} className="hd-turn">Your turn!</span>
                          ) : null,
                        )}
                        {running === sel && <span className="hd-dots" aria-label="Agent is thinking"><i /><i /><i /></span>}
                      </div>
                      <form className="hd-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
                        <span className="mono c-acc" aria-hidden="true">›</span>
                        <label htmlFor="hd-ask" className="sr-only">Ask the agent</label>
                        <input id="hd-ask" className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the agent anything…" />
                        <span className="hd-chip hd-opt" aria-hidden="true">Claude <Icon name="chevronDown" size={9} /></span>
                        <span className="hd-chip hide-sm" aria-hidden="true">Claude Opus 5.5 <Icon name="chevronDown" size={9} /></span>
                        <span className="hd-chip hide-sm" aria-hidden="true">xhigh <Icon name="chevronDown" size={9} /></span>
                        <button className="hd-send" aria-label="Send" disabled={!text.trim() || !!running}><Icon name="send" size={18} /></button>
                      </form>
                    </>
                  ) : (
                    <div className="hd-log mono hd-shell">
                      <div><span className="c-add">~/acme-web</span> <span className="c-acc">({head})</span> $ git status --short</div>
                      {bs[head].wip.map((f) => <div key={f.path}>&nbsp;M {f.path}</div>)}
                      <div><span className="c-add">~/acme-web</span> <span className="c-acc">({head})</span> $ <span className="blink">▍</span></div>
                    </div>
                  )}
                </div>
              ) : (
                <button className="hd-term-bar" onClick={() => setTerm('agent')}><Icon name="terminal" />{running ? 'Agent · running' : 'Agent'}<span style={{ flex: 1 }} /><Icon name="chevronUp" size={13} /></button>
              )}
            </>
          )}
        </div>

        {/* right: the selected branch's files */}
        <section aria-label="Changed files" className="hd-right-pane">
          <div className="hd-files-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span className="mono ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>{b.name}</span>
              {b.base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap', flex: 1 }}>from {b.base}</span>}
              <span style={{ flex: b.base ? 0 : 1 }} />
              <button className="hd-ibtn" aria-label={tree ? 'Show files as a list' : 'Show files as a tree'} title={tree ? 'List view' : 'Tree view'} onClick={() => setTree(!tree)}><Icon name={tree ? 'menu' : 'folder'} size={12} /></button>
            </div>
            <span className="seg hd-seg" role="group" aria-label="File view">
              <button className={mode === 'wip' ? 'on' : ''} onClick={() => setMode('wip')}>{wipCount ? <span className="hd-wip">WIP {wipCount}</span> : <>WIP <span className="faint">0</span></>}</button>
              <button className={mode === 'branch' ? 'on' : ''} onClick={() => setMode('branch')}>Branch <span className="faint">{b.files.length}</span></button>
              <button className={mode === 'project' ? 'on' : ''} onClick={() => setMode('project')}>Project</button>
            </span>
          </div>
          <div className="hd-files">
            {mode === 'project' ? (
              <Files list={['src/App.tsx', 'src/screens/BranchTree.tsx', 'src/screens/Workspace.tsx', 'src/styles/app.css', 'package.json'].map((p) => ({ path: p, add: 0, del: 0, s: 'M' as const }))} tree={tree} onPick={setFile} />
            ) : list.length === 0 ? (
              <div className="hd-empty">{mode === 'wip' ? (isHead || b.wt ? 'No uncommitted changes.' : 'This branch is not checked out.') : 'No changes on this branch yet.'}</div>
            ) : mode === 'wip' ? (
              <>
                <div className="hd-sec"><Icon name="chevronDown" size={12} />Unstaged <span style={{ fontWeight: 400 }}>{wipCount}</span></div>
                <Files list={list} tree={tree} onPick={setFile} />
              </>
            ) : (
              <Files list={list} tree={tree} onPick={setFile} />
            )}
          </div>
          <div className="hd-commit">
            <button className="hd-msg-toggle" aria-expanded={msgOpen} onClick={() => setMsgOpen(!msgOpen)}><Icon name="chevronDown" size={12} className="chev" />Commit message</button>
            {msgOpen && <input className="hd-summary" value={summary} disabled={!canCommit} onChange={(e) => setSummary(e.target.value)} placeholder={!isHead && !b.wt ? 'Check out this branch to commit' : !wipCount ? 'No changes to commit' : 'Summary — leave empty for AI'} aria-label="Summary" />}
            <div style={{ display: 'flex' }}>
              <button className="hd-commit-btn" disabled={!canCommit} onClick={commit}>
                <Icon name="sparkle" size={12} />Stage all &amp; Commit{wipCount > 0 && <span style={{ fontWeight: 400, opacity: 0.75 }}>{wipCount}</span>}
              </button>
              <span className="hd-commit-more" aria-hidden="true"><Icon name="more" size={14} stroke={2.4} /></span>
            </div>
          </div>
        </section>
      </div>
      {toast && <div className="hd-toast" role="status">{toast}</div>}
    </div>
  );
}
