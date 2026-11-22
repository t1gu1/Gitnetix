import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { Avatar, Busy, Choice, Empty, EmptyState, Markdown, Menu, Modal, PageHead, Seg, useDemo, useLater, useMenu, type MenuItem } from './ui';

/** src/screens/PullRequests.tsx on a made-up GitHub repo: merge, close, review, comment, react, resolve; checks finish as you watch. */

type Tab = 'open' | 'review' | 'closed';
type View = 'conversation' | 'files';
type Who = 'mine' | 'others' | 'all';
type Vote = 'approve' | 'changes' | 'comment' | 'pending';
type Check = { name: string; status: 'pass' | 'fail' | 'run' | 'wait' };
type Reaction = { content: string; count: number; mine: boolean };
type Comment = { id: string; author: string; body: string; ago: string; reactions: Reaction[] };
type Thread = { id: string; path?: string; line?: number; snippet?: string[]; comments: Comment[]; resolvable: boolean; resolved: boolean; review?: Exclude<Vote, 'pending'> };
/** A changed file and its one hunk: lines starting with ' ', '+' or '-', the first new one numbered `start`. */
type PrFile = { path: string; s: 'A' | 'M' | 'D'; start: number; lines: string[] };
type Pr = { number: number; title: string; body: string; author: string; mine?: boolean; review?: boolean; state: 'open' | 'draft' | 'merged' | 'closed'; head: string; base: string; ago: string; conflict?: boolean; checks: Check[]; reviewers: { login: string; vote: Vote }[]; threads: Thread[]; files: PrFile[] };

const LOGIN = 'grace-hopper';
const HOST = 'GitHub';
const REPO = 'acme/acme-web';
const GROUPS: Pr['state'][] = ['open', 'draft', 'merged', 'closed'];
const GROUP_LABEL: Record<Pr['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const EMOJI: [string, string, string][] = [
  ['THUMBS_UP', '👍', 'Thumbs up'],
  ['THUMBS_DOWN', '👎', 'Thumbs down'],
  ['LAUGH', '😄', 'Laugh'],
  ['HOORAY', '🎉', 'Hooray'],
  ['HEART', '❤️', 'Heart'],
  ['ROCKET', '🚀', 'Rocket'],
];
const emojiOf = (content: string) => EMOJI.find((e) => e[0] === content)?.[1];
const pass = (...names: string[]): Check[] => names.map((name) => ({ name, status: 'pass' }));
const say = (id: string, author: string, body: string, ago: string, reactions: Reaction[] = []): Comment => ({ id, author, body, ago, reactions });
const file = (path: string, start: number, lines: string[], s: PrFile['s'] = 'M'): PrFile => ({ path, s, start, lines });

const PRS: Pr[] = [
  {
    number: 148, title: 'Branch tree: keyboard navigation', author: LOGIN, mine: true, state: 'open', head: 'feat/tree-keys', base: 'release/0.6.0', ago: '2 h ago',
    body: 'Arrow keys move through the branch tree, like a file list.\n\n- **↑ / ↓** move between rows, **← / →** fold and unfold child branches\n- **Enter** checks the branch out\n- Focus stays on the row after a checkout\n\nCloses WEB-189',
    checks: [...pass('lint', 'typecheck'), { name: 'test (ubuntu-latest)', status: 'run' }, { name: 'test (windows-latest)', status: 'wait' }],
    reviewers: [{ login: 'ana-moreau', vote: 'approve' }, { login: 'jules-laurent', vote: 'pending' }],
    threads: [
      { id: 't1', review: 'approve', resolvable: false, resolved: false, comments: [say('c1', 'ana-moreau', 'Feels right with the arrows. One nit inline, approving anyway.', '1 h ago', [{ content: 'HOORAY', count: 1, mine: false }])] },
      {
        id: 't2', path: 'src/screens/BranchTree.tsx', line: 217, resolvable: true, resolved: false,
        snippet: ['     case "ArrowDown":', '+      focusRow(rows[i + 1]);', '+      break;', '+    case "Home":'],
        comments: [say('c2', 'ana-moreau', 'Could `Home` and `End` jump to the trunk and to the last release?', '1 h ago', [{ content: 'THUMBS_UP', count: 2, mine: false }])],
      },
    ],
    files: [
      file('src/screens/BranchTree.tsx', 210, ['   switch (e.key) {', '     case "ArrowUp":', '-      focusRow(rows[i - 1]);', '+      focusRow(rows[Math.max(i - 1, 0)]);', '       break;', '     case "ArrowDown":', '+      focusRow(rows[i + 1]);', '+      break;', '+    case "Home":', '+      focusRow(rows[0]);', '       break;', '   }']),
      file('src/lib/keys.ts', 1, ['+export const NAV_KEYS = ["ArrowUp", "ArrowDown", "Home", "End"];', '+', '+export const isNav = (k: string) => NAV_KEYS.includes(k);'], 'A'),
      file('src/styles/app.css', 2250, [' .tree-row:focus-visible {', '+  outline-offset: -2px;', ' }']),
    ],
  },
  {
    number: 144, title: 'Diff view: theme tokens for added and removed lines', author: LOGIN, mine: true, state: 'draft', head: 'feat/diff-tokens', base: 'release/0.6.0', ago: 'yesterday',
    body: 'Moves the diff colors to theme tokens, so every theme paints its own added and removed lines.\n\nStill to do: the light themes.',
    checks: pass('lint', 'typecheck', 'test (ubuntu-latest)'), reviewers: [], threads: [],
    files: [
      file('src/styles/app.css', 120, [' :root {', '-  --diff-add: #1f3b2a;', '-  --diff-del: #3b1f22;', '+  --diff-add: var(--add-bg);', '+  --diff-del: var(--del-bg);', ' }']),
      file('src/lib/themes.ts', 48, ['   add: mix(fg, green, 0.2),', '+  addBg: mix(bg, green, 0.12),', '+  delBg: mix(bg, red, 0.12),']),
    ],
  },
  {
    number: 147, title: 'Prune branches deleted on origin', author: 'jules-laurent', review: true, state: 'open', head: 'fix/stale-remote', base: 'release/0.6.0', ago: '35 min ago',
    body: 'Branches deleted on origin stayed in the tree until a full refresh.\n\n- The background fetch passes `--prune`\n- The branch cache drops refs that left origin\n\nFixes WEB-218',
    checks: [...pass('lint', 'typecheck'), { name: 'test (ubuntu-latest)', status: 'fail' }],
    reviewers: [{ login: LOGIN, vote: 'pending' }, { login: 'riya-kapoor', vote: 'comment' }],
    threads: [
      {
        id: 't3', path: 'crates/core/src/git.rs', line: 87, resolvable: true, resolved: false,
        snippet: ['-    self.run(&["fetch", "origin"]).await?;', '+    self.run(&["fetch", "--prune", "origin"]).await?;'],
        comments: [
          say('c3', 'riya-kapoor', 'Does `--prune` drop tags too? Some people still check out old tags.', '30 min ago'),
          say('c4', 'jules-laurent', 'Only branches: tags need `--prune-tags`. Adding a test for it.', '22 min ago', [{ content: 'THUMBS_UP', count: 1, mine: false }]),
        ],
      },
    ],
    files: [
      file('crates/core/src/git.rs', 86, ['     pub async fn fetch(&self) -> Result<()> {', '-        self.run(&["fetch", "origin"]).await?;', '+        self.run(&["fetch", "--prune", "origin"]).await?;', '+        self.refs.retain(|r| !r.gone);', '         Ok(())', '     }']),
      file('crates/core/tests/fetch.rs', 1, ['+#[tokio::test]', '+async fn prune_drops_gone_branches() {', '+    let repo = Fixture::with_remote().await;', '+    repo.delete_on_origin("old").await;', '+    repo.fetch().await.unwrap();', '+    assert!(!repo.has_branch("origin/old"));', '+}'], 'A'),
    ],
  },
  {
    number: 151, title: 'Agent pane: stream steps as they happen', author: 'riya-kapoor', review: true, state: 'open', conflict: true, head: 'feat/agent-pane', base: 'main', ago: '3 h ago',
    body: 'Steps show up in the agent pane while the agent works, instead of all at once at the end.\n\n- Steps stream over the event channel\n- The newest group stays open\n\nCloses WEB-221',
    checks: pass('lint', 'typecheck', 'test (ubuntu-latest)'),
    reviewers: [{ login: LOGIN, vote: 'pending' }],
    threads: [{ id: 't4', resolvable: false, resolved: false, comments: [say('c5', 'riya-kapoor', 'Grace, this one touches the terminal too. Could you have a look?', '3 h ago')] }],
    files: [
      file('src/components/AgentLog.tsx', 60, ['   const steps = useSteps(session);', '-  return <Steps list={steps} />;', '+  return <Steps list={steps} open={steps.length - 1} live />;']),
      file('src/api/events.ts', 14, ['   switch (e.kind) {', '+    case "step":', '+      return push(e.session, e.step);']),
    ],
  },
  { number: 141, title: 'Release 0.5.2', author: 'ana-moreau', state: 'merged', head: 'release/0.5.2', base: 'main', ago: '6 days ago', body: 'Hotfix release: worktrees in folders with spaces open again on Windows.', checks: pass('lint', 'test (ubuntu-latest)'), reviewers: [{ login: LOGIN, vote: 'approve' }], threads: [], files: [file('CHANGELOG.md', 1, [' # Changelog', ' ', '+## 0.5.2', '+', '+- Worktrees in folders with spaces open again on Windows.'])] },
  { number: 139, title: 'Squash merge detection', author: LOGIN, mine: true, state: 'merged', head: 'feat/squash-detect', base: 'release/0.5.0', ago: '3 weeks ago', body: 'Branches whose ticket key shows up in a later squash commit count as merged.', checks: pass('lint', 'test (ubuntu-latest)'), reviewers: [{ login: 'ana-moreau', vote: 'approve' }], threads: [], files: [file('src/lib/merged.ts', 30, ['   if (b.mergedInto) return true;', '+  if (squashed(b.ticket, log)) return true;', '   return false;'])] },
  { number: 137, title: 'Experiment: commit graph view', author: LOGIN, mine: true, state: 'closed', head: 'poc/graph', base: 'main', ago: 'Sep 12, 2026', body: 'A classic commit graph next to the tree, to compare. Closed: the tree reads better.', checks: [], reviewers: [], threads: [], files: [file('src/screens/Graph.tsx', 1, ['+export function Graph() {', '+  return <canvas className="graph" />;', '+}'], 'A')] },
];

const COMMITS_SHOWN = 6;
/** The code a new pull request shows for the selected branch's files (the path pulse of feat/branch-tree); others get a line saying what changed. */
const HUNKS: Record<string, PrFile> = Object.fromEntries([
  file('src/screens/BranchTree.tsx', 88, [' export function BranchTree({ o, selected }: Props) {', '   const rows = useRows(o);', '+  const path = usePath(rows, o.currentBranch);', '+  const pulse = usePulse(path);', '   return (', '     <Tree rows={rows} selected={selected}>', '+      <PathLine d={path} pulse={pulse} />', '     </Tree>']),
  file('src/lib/path.ts', 1, ['+/** The rows from the trunk down to `branch`, as an SVG path through their dots. */', '+export function usePath(rows: Row[], branch: string) {', '+  const chain = lineage(rows, branch);', '+  return chain.map((r, i) => `${i ? "L" : "M"}${r.x} ${r.y}`).join("");', '+}'], 'A'),
  file('src/styles/app.css', 2310, [' .tree-path {', '+  stroke-dasharray: 2 4;', '+  animation: path-run 1.6s linear infinite;', ' }']),
].map((f) => [f.path, f]));

const inTab = (p: Pr, t: Tab, who: Who) =>
  t === 'review'
    ? !!p.review && p.state !== 'merged' && p.state !== 'closed'
    : (who === 'all' || !!p.mine === (who === 'mine')) && (t === 'closed' ? p.state === 'merged' || p.state === 'closed' : p.state === 'open' || p.state === 'draft');
const pending = (p: Pr) => p.checks.some((c) => c.status === 'run' || c.status === 'wait');
/** A title from the branch name: feat/tree-keys → Tree keys. */
const titleOf = (branch: string) => branch.replace(/^\w+\//, '').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** What "Rewrite with AI" makes of a description: the Standard PR template's sections. */
function rewrite(body: string) {
  const lines = body.split('\n').filter((l) => l.trim());
  const points = lines.filter((l) => l.startsWith('- '));
  const ref = lines.find((l) => /^(Closes|Fixes) /.test(l));
  return ['## Summary', lines.find((l) => !l.startsWith('- ') && l !== ref) ?? '', ...(points.length ? ['', '## Changes', ...points] : []), '', '## Testing', '- Unit tests pass', '- Tried by hand on macOS and Linux', ...(ref ? ['', ref] : [])].join('\n');
}
/** "Improve": a capital, a full stop, and "I" for "i". */
const tidy = (s: string) => s.trim().replace(/^./, (c) => c.toUpperCase()).replace(/\bi\b/g, 'I').replace(/([^.!?])$/, '$1.');
const nums = (f: PrFile) => [f.lines.filter((l) => l[0] === '+').length, f.lines.filter((l) => l[0] === '-').length];
/** Branches to pick as a base or head: every one but `not` (branchOptions in the app). */
const branchOptions = (branches: Record<string, { name: string; merged?: boolean }>, not: string | null) =>
  Object.values(branches).filter((b) => b.name !== not && !b.merged).map((b) => ({ value: b.name, label: b.name }));

export default function PullRequests() {
  const { flash, sel: branch, branches } = useDemo();
  const later = useLater();
  const [prs, setPrs] = useState(PRS);
  const [tab, setTab] = useState<Tab>('open');
  const [who, setWho] = useState<Who>('mine');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<number>();
  // On the phone: the list, or the picked pull request in its place.
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [asking, setAsking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const term = search.trim().toLowerCase();
  const items = prs.filter((p) => !term || `#${p.number} ${p.title} ${p.head} ${p.author}`.toLowerCase().includes(term));
  const list = items.filter((p) => inTab(p, tab, who));
  const current = prs.find((p) => p.number === (sel ?? list[0]?.number));
  const update = (n: number) => (f: (p: Pr) => Pr) => setPrs((ps) => ps.map((p) => (p.number === n ? f(p) : p)));
  // CI moves on as you watch: running checks pass, waiting ones start.
  useEffect(() => {
    const t = setInterval(() => setPrs((ps) => (ps.some(pending) ? ps.map((p) => ({ ...p, checks: p.checks.map((c) => ({ ...c, status: c.status === 'run' ? 'pass' : c.status === 'wait' ? 'run' : c.status })) })) : ps)), 5000);
    return () => clearInterval(t);
  }, []);
  const opened = (n: number) => {
    setSel(n);
    setPane('detail');
  };
  const create = (from: string, to: string) => {
    setAsking(false);
    setCreating(true);
    later(1500, () => {
      const number = Math.max(...prs.map((p) => p.number)) + 1;
      const b = branches[from];
      const ours = from === 'feat/branch-tree';
      setPrs((ps) => [
        {
          number, author: LOGIN, mine: true, state: 'open', head: from, base: to, ago: 'just now', reviewers: [], threads: [],
          title: ours ? 'Animate the path to the checked-out branch' : titleOf(from),
          body: ours
            ? 'A light runs along the branch path, from `main` to the branch you have checked out.\n\n- Restarts when you switch branch\n- Stays still when the system asks for reduced motion\n\nCloses WEB-212'
            : `${titleOf(from)}, as described in its commits.\n\n- ${plural(b?.ahead ?? 1, 'commit')} on top of ${to}`,
          checks: [{ name: 'lint', status: 'run' }, { name: 'typecheck', status: 'wait' }, { name: 'test (ubuntu-latest)', status: 'wait' }],
          files: (b?.files ?? []).map((f) => (ours && HUNKS[f.path]) || file(f.path, 1, [` // ${f.path.slice(f.path.lastIndexOf('/') + 1)}`, `+// ${plural(f.add, 'line')} added on ${from}`], f.s === 'A' ? 'A' : f.s === 'D' ? 'D' : 'M')),
        },
        ...ps,
      ]);
      setCreating(false);
      setTab('open');
      setWho('mine');
      opened(number);
      flash(`Opened #${number}`);
    });
  };

  return (
    <>
      <PageHead title="Pull requests" sub={`acme-web · ${HOST} ${REPO}`} onBack={pane === 'detail' ? () => setPane('list') : undefined} />
      {/* The branch map's toolbar: the title, the filters, then search, sync and the new pull request. On a phone the detail pane goes without it. */}
      <div className="map-bar pr-bar" data-detail={pane === 'detail' || undefined}>
        <h2 className="map-title hide-narrow">Pull requests</h2>
        <span className="pr-where mono ellipsis hide-narrow">{HOST} · {REPO}</span>
        <Seg
          label="Filter"
          value={tab}
          onChange={(t) => { setTab(t); setSel(undefined); }}
          options={(['open', 'review', 'closed'] as Tab[]).map((t) => [t, <>{{ open: 'Open', review: 'To review', closed: 'Closed' }[t]} <span className="faint">{items.filter((p) => inTab(p, t, who)).length}</span></>])}
        />
        {tab !== 'review' && <Seg label="Author" value={who} onChange={(w) => { setWho(w); setSel(undefined); }} options={[['mine', 'Mine'], ['others', 'Others'], ['all', 'All']]} />}
        <span className="grow" />
        <div className="pr-search">
          <Icon name="search" size={13} className="faint" />
          <label htmlFor="pr-q" className="sr-only">Search pull requests</label>
          <input id="pr-q" className="input" placeholder="Search by number, title, branch or author" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-sm btn-icon" aria-label="Sync now" title="Sync now" onClick={() => { setSyncing(true); later(700, () => { setSyncing(false); flash(`Synced with ${HOST}`); }); }}>
          <Busy on={syncing}><Icon name="refresh" size={14} /></Busy>
        </button>
        <button className="btn btn-sm btn-primary pr-new-btn" aria-disabled={creating || undefined} title={creating ? undefined : 'Pick its branches; AI writes its title and description'} onClick={() => !creating && setAsking(true)}>
          <Busy on={creating}><Icon name="sparkle" size={13} /></Busy>
          <span>{creating ? 'Opening pull request…' : 'New pull request'}</span>
          {!creating && <span className="pr-new-from mono ellipsis">{branch}</span>}
        </button>
      </div>
      {asking && <NewPrModal start={branch} prs={prs} onClose={() => setAsking(false)} onShow={(n) => { setAsking(false); setTab('open'); opened(n); }} onCreate={create} />}
      <div className="body split">
        <section aria-label="Pull request list" className="master" style={{ '--master-w': '380px' } as CSSProperties} data-pane data-active={pane === 'list'}>
          <div className="scroll pr-list">
            {list.length === 0 && <Empty>{term ? 'No pull requests match this search.' : 'Nothing here.'}</Empty>}
            {GROUPS.map((s) => ({ s, items: list.filter((p) => p.state === s) }))
              .filter((g) => g.items.length)
              .map(({ s, items }) => (
                <div key={s}>
                  <div className="group-head">
                    <span>{GROUP_LABEL[s]}</span>
                    <span className="mono">{items.length}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    {items.map((p) => <PrRow key={p.number} p={p} active={p.number === current?.number} onPick={() => opened(p.number)} />)}
                  </div>
                </div>
              ))}
          </div>
          <div className="pr-legend" aria-hidden="true">
            <span className="label">Legend</span>
            <span className="pr-legend-keys">
              {(tab === 'closed' ? (['merged', 'closed'] as const) : (['open', 'draft'] as const)).map((s) => (
                <span key={s}><span className="pr-ring" data-state={s} />{GROUP_LABEL[s]}</span>
              ))}
            </span>
          </div>
        </section>
        <main className="detail" data-pane data-active={pane === 'detail'}>
          {current ? <Detail key={current.number} p={current} set={update(current.number)} /> : <EmptyState icon="pr" title="No pull request selected">Pick one from the list to read its description, checks and reviews.</EmptyState>}
        </main>
      </div>
    </>
  );
}

/** A row of the list: its state as a station ring, the title, then number, author and branch (and its base, when it is not main). */
function PrRow({ p, active, onPick }: { p: Pr; active: boolean; onPick: () => void }) {
  return (
    <button className="item-btn pr-row" aria-pressed={active} onClick={onPick}>
      <span className="pr-ring" data-state={p.state} />
      <span className="pr-row-text">
        <span className="pr-row-title">{p.title}</span>
        <span className="pr-row-meta">
          <span className="mono">#{p.number}</span>
          <span>{p.mine ? 'You' : p.author}</span>
          <span className="mono pr-row-route">
            {p.head}
            {p.base !== 'main' && <> <span className="pr-arrow">→</span> {p.base}</>}
          </span>
        </span>
      </span>
      <span className="pr-row-age">{p.ago}</span>
    </button>
  );
}

/** A new pull request: the branch it comes from (the selected one) and the one it merges into (its parent), each one to
 *  change. Under them, the commits it would bring, or why it can't open. */
function NewPrModal({ start, prs, onClose, onShow, onCreate }: { start: string; prs: Pr[]; onClose: () => void; onShow: (n: number) => void; onCreate: (from: string, to: string) => void }) {
  const { branches, logOf } = useDemo();
  const [from, setFrom] = useState(start);
  // Null: the From branch's parent, following it when From changes.
  const [picked, setPicked] = useState<string | null>(null);
  const b = branches[from];
  const to = picked ?? b?.base ?? 'main';
  const self = to === from;
  const already = prs.find((p) => p.head === from && (p.state === 'open' || p.state === 'draft'));
  const list = b ? logOf(b).slice(0, b.ahead).map((c): [string, string, string] => [c.sha, c.subject, c.when]) : [];
  const blocked = self
    ? `${from} can't merge into itself: pick another branch to merge into.`
    : b?.push && b.ahead - b.push <= 0 && to === b.base
      ? `Push commits to ${from} before opening a pull request.`
      : !b?.ahead
        ? `${from} has no commits that ${to} doesn't have.`
        : undefined;
  return (
    <Modal
      title="New pull request"
      sub="AI writes its title and description from the changes."
      onClose={onClose}
      width={580}
      footer={
        <>
          <span className="grow" />
          <button className="btn btn-md" onClick={onClose}>Back</button>
          <button className="btn btn-md btn-primary" disabled={!!already || !!blocked} onClick={() => onCreate(from, to)}>
            <Icon name="sparkle" size={13} />
            Open pull request
          </button>
        </>
      }
    >
      <div className="pr-new">
        <div className="pr-from-to">
          <div className="field">
            <label htmlFor="pr-from">From</label>
            <Choice id="pr-from" className="select menu-select mono" label="From" value={from} options={branchOptions(branches, null)} onChange={(v) => { setFrom(v); setPicked(null); }} />
          </div>
          <span className="pr-arrow" aria-hidden="true">→</span>
          <div className="field">
            <label htmlFor="pr-to">To</label>
            <Choice id="pr-to" className="select menu-select mono" label="To" value={to} options={branchOptions(branches, from)} onChange={setPicked} />
          </div>
        </div>
        {already ? (
          <div className="pr-already">
            <span>#{already.number} is already open from <span className="mono">{from}</span> into <span className="mono">{already.base}</span>. Commits you push to it show there.</span>
            <button className="btn btn-sm" onClick={() => onShow(already.number)}>Show #{already.number}</button>
          </div>
        ) : blocked ? (
          <div className="err-box warn">{blocked}</div>
        ) : (
          <div className="pr-preview">
            <div className="pr-preview-head">
              <span className="label">{plural(b.ahead, 'commit')}</span>
            </div>
            {list.slice(0, COMMITS_SHOWN).map(([sha, subject, when]) => (
              <div key={sha} className="pr-preview-row">
                <span className="mono faint">{sha}</span>
                <span className="ellipsis">{subject}</span>
                <span className="mono faint">{when}</span>
              </div>
            ))}
            {b.ahead > COMMITS_SHOWN && <span className="pr-preview-more">and {plural(b.ahead - COMMITS_SHOWN, 'more commit')}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Detail({ p, set }: { p: Pr; set: (f: (p: Pr) => Pr) => void }) {
  const { flash, openBranch } = useDemo();
  const later = useLater();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [retarget, setRetarget] = useState<string | null>(null);
  const [rewriteIt, setRewriteIt] = useState(true);
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [view, setView] = useState<View>('conversation');
  // A conversation to see in the code: the files view opens on its file and line.
  const [focus, setFocus] = useState<Thread | null>(null);
  const [busy, setBusy] = useState<'merge' | 'gen' | 'move'>();
  const more = useMenu();
  const open = p.state === 'open' || p.state === 'draft';
  const running = p.checks.filter((c) => c.status === 'run' || c.status === 'wait').length;
  const unresolved = p.threads.filter((t) => t.resolvable && !t.resolved).length;
  const threads = filter === 'open' ? p.threads.filter((t) => t.resolvable && !t.resolved) : p.threads;
  // A short description sits above the conversation, a long one beside it.
  const short = p.body.length < 400 && p.body.split('\n').length <= 6;
  const setThread = (id: string, f: (t: Thread) => Thread) => set((x) => ({ ...x, threads: x.threads.map((t) => (t.id === id ? f(t) : t)) }));
  const startEdit = (t = p.title, b = p.body) => {
    setTitle(t);
    setBody(b);
    setEditing(true);
  };
  const gen = () => {
    setBusy('gen');
    later(1300, () => {
      setBusy(undefined);
      startEdit(p.title.replace(/^.*?: /, '').replace(/^./, (c) => c.toUpperCase()), rewrite(p.body));
    });
  };

  // What moves it on, at the end of its line: merge it, resolve its conflicts, or reopen it.
  const action =
    open && !p.conflict && p.state !== 'draft' ? (
      <button
        className="btn btn-primary btn-sm"
        disabled={busy === 'merge' || running > 0}
        onClick={() => {
          setBusy('merge');
          later(900, () => {
            setBusy(undefined);
            set((x) => ({ ...x, state: 'merged', ago: 'just now' }));
            flash(`Merged #${p.number}`);
          });
        }}
      >
        {busy === 'merge' && <span className="spinner" />}
        {busy === 'merge' ? `Merging into ${p.base}…` : `Merge into ${p.base}`}
      </button>
    ) : open && p.conflict ? (
      <button className="btn btn-primary btn-sm" onClick={() => openBranch(p.head)}>
        <Icon name="sparkle" size={12} />
        Resolve conflicts with AI
      </button>
    ) : p.state === 'closed' ? (
      <button className="btn btn-primary btn-sm" onClick={() => { set((x) => ({ ...x, state: 'open' })); flash(`Reopened #${p.number}`); }}>Reopen</button>
    ) : null;

  return (
    <div className="detail-inner pr-detail">
      <header className="pr-strip">
        <div className="pr-strip-top">
          {editing ? (
            <div className="field grow">
              <label htmlFor="pr-title">Title</label>
              <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          ) : (
            <div className="pr-title">
              <h1>{p.title}</h1>
              {open && (
                <button className="btn btn-ghost btn-icon btn-sm pr-wide" aria-label="Edit title and description" onClick={() => startEdit()}>
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          )}
          <div className="pr-meta">
            <span className="mono faint">#{p.number}</span>
            <span className="pr-meta-by">
              <Avatar name={p.author} size={16} />
              {p.mine ? 'Opened by you' : `Opened by ${p.author}`} · updated {p.ago}
            </span>
          </div>
          <span className="grow" />
          <div className="pr-actions">
            {open && <button className="btn btn-sm" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>Review</button>}
            {open && (
              <button className="btn btn-sm" disabled={busy === 'gen'} onClick={gen}>
                <Busy on={busy === 'gen'}><Icon name="sparkle" size={12} /></Busy>
                Rewrite with AI
              </button>
            )}
            <button className="btn btn-sm pr-wide" onClick={() => flash(`Opens #${p.number} on ${HOST}`)}>
              <Icon name="external" size={12} />
              Open on {HOST}
            </button>
            {open && (
              <button className="btn btn-sm btn-icon btn-danger pr-wide" aria-label="Close pull request" title="Close pull request" onClick={() => setConfirmClose(true)}>
                <Icon name="prClosed" size={14} />
              </button>
            )}
            {/* Narrow, the rest goes in a menu. */}
            <button className="btn btn-sm btn-icon pr-narrow" aria-label="More actions" aria-haspopup="menu" aria-expanded={!!more.at} onClick={(e) => more.toggle(e, true)}>
              <Icon name="more" size={14} />
            </button>
            {more.at && (
              <Menu
                {...more.at}
                alignRight
                label="More actions"
                onClose={more.close}
                items={[
                  { id: 'open', label: `Open on ${HOST}`, icon: 'external', run: () => flash(`Opens #${p.number} on ${HOST}`) },
                  ...(open
                    ? ([
                        { id: 'edit', label: 'Edit title and description', icon: 'edit', run: () => startEdit() },
                        'sep',
                        { id: 'close', label: 'Close pull request', icon: 'prClosed', danger: true, run: () => setConfirmClose(true) },
                      ] as MenuItem[])
                    : []),
                ]}
              />
            )}
          </div>
        </div>
        <PrLine
          p={p}
          action={action}
          onBase={open ? setRetarget : undefined}
          onUnresolved={() => {
            setView('conversation');
            setFocus(null);
            setFilter('open');
          }}
        />
      </header>

      {confirmClose && (
        <Modal
          title={`Close #${p.number}?`}
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn btn-md" autoFocus onClick={() => setConfirmClose(false)}>Back</button>
              <button className="btn btn-md btn-danger" onClick={() => { set((x) => ({ ...x, state: 'closed' })); setConfirmClose(false); flash(`Closed #${p.number}`); }}>
                {deleteBranch ? 'Close and delete branch' : 'Close without merging'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {deleteBranch ? (
              <>Abandons the pull request on {HOST} and deletes <span className="mono">{p.head}</span> here and on origin, with its worktree. Commits not merged elsewhere are lost.</>
            ) : (
              <>Abandons the pull request on {HOST}. The branch <span className="mono">{p.head}</span> and its commits stay, and you can reopen it later.</>
            )}
          </p>
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
            <span>Also delete <span className="mono">{p.head}</span>, locally and on origin</span>
          </label>
        </Modal>
      )}

      {retarget && (
        <Modal
          title={`Change #${p.number}'s target to ${retarget}?`}
          sub={<>From <span className="mono">{p.base}</span> to <span className="mono">{retarget}</span> on {HOST}.</>}
          onClose={() => setRetarget(null)}
          width={480}
          footer={
            <>
              <span className="grow" />
              <button className="btn btn-md" onClick={() => setRetarget(null)}>Back</button>
              <button
                className="btn btn-md btn-primary"
                disabled={busy === 'move'}
                onClick={() => {
                  setBusy('move');
                  later(700, () => {
                    setBusy(undefined);
                    set((x) => ({ ...x, base: retarget }));
                    flash(`#${p.number} now merges into ${retarget}`);
                    setRetarget(null);
                    // Rewritten into the editor: saved only once looked at.
                    if (rewriteIt) gen();
                  });
                }}
              >
                {busy === 'move' && <span className="spinner" />}
                Change target
              </button>
            </>
          }
        >
          <label className="check pr-rewrite">
            <input type="checkbox" checked={rewriteIt} onChange={() => setRewriteIt(!rewriteIt)} />
            <span>
              Rewrite the title and description with AI
              <small>They were written from the changes against {p.base}. You see the new ones before they are saved.</small>
            </span>
          </label>
        </Modal>
      )}

      {reviewOpen && (
        <div className="pr-review">
          <ReviewForm p={p} set={set} onDone={() => setReviewOpen(false)} />
        </div>
      )}

      <div className="pr-tabs" role="tablist" aria-label="Show">
        {(['conversation', 'files'] as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => { setView(v); setFocus(null); }}>
            <Icon name={v === 'files' ? 'file' : 'comment'} size={13} />
            {v === 'files' ? 'Files changed' : 'Conversation'}
            <span className="faint mono">{v === 'files' ? p.files.length : p.threads.length}</span>
          </button>
        ))}
      </div>

      {view === 'files' && <PrFiles key={focus?.id} p={p} focus={focus} setThread={setThread} />}

      {view === 'conversation' && (
        <div className="pr-conv" data-stacked={short || undefined}>
          <section className="pr-desc" aria-label="Description">
            <div className="pr-sec-head">
              <h2>Description</h2>
              <span className="grow" />
              {open && !editing && (
                <button className="btn btn-sm btn-ghost" onClick={() => startEdit()}>
                  <Icon name="edit" size={12} />
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <div className="col">
                <label htmlFor="pr-body" className="sr-only">Description</label>
                <textarea id="pr-body" className="textarea mono" rows={14} style={{ fontSize: 12.5 }} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="row wrap">
                  <span className="grow" />
                  <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={!title.trim()} onClick={() => { set((x) => ({ ...x, title, body })); setEditing(false); flash(`Saved to ${HOST}`); }}>Save to {HOST}</button>
                </div>
              </div>
            ) : p.body ? (
              <div className="pr-body"><Markdown text={p.body} /></div>
            ) : (
              <span className="muted">No description.</span>
            )}
          </section>

          <section className="pr-talk" aria-label="Conversation">
            <div className="pr-sec-head">
              <h2>Conversation</h2>
              <span className="hint">{p.threads.length ? `${unresolved} unresolved of ${p.threads.length}` : ''}</span>
              <span className="grow" />
              <Seg label="Show" value={filter} onChange={setFilter} options={[['all', 'All'], ['open', 'Unresolved']]} />
            </div>
            {threads.length > 0 && (
              <div className="pr-rail">
                {threads.map((t) => (
                  <div key={t.id} className="pr-rail-item" data-open={(t.resolvable && !t.resolved) || undefined}>
                    <ThreadView t={t} set={(f) => setThread(t.id, f)} onShowCode={t.path ? () => { setFocus(t); setView('files'); } : undefined} />
                  </div>
                ))}
              </div>
            )}
            {threads.length === 0 && <span className="muted">{p.threads.length === 0 ? 'No comments yet.' : 'Every conversation is resolved.'}</span>}
            <div className="pr-talk-new">
              <NewComment onSend={(text) => set((x) => ({ ...x, threads: [...x.threads, { id: `n${Date.now()}`, resolvable: false, resolved: false, comments: [say(`n${Date.now()}`, LOGIN, text, 'just now')] }] }))} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const CHECK_ORDER = { fail: 0, run: 1, wait: 2, pass: 3 };
const CHECK_WORD = { pass: 'Passed', fail: 'Failed', run: 'Running', wait: 'Waiting' };
const VOTE_WORD = { approve: 'Approved', changes: 'Changes requested', comment: 'Commented', pending: 'Review requested' };
type Gate = { key: 'checks' | 'review' | 'talk'; label: string; value: ReactNode; state: 'pass' | 'fail' | 'wait'; running?: boolean };

/** The pull request as a line of the branch map: its branch's box, a station for each gate it passes (checks, review,
 *  conversations), then its base. The route runs solid up to the first gate not passed. After the base: what holds it
 *  back, and `action`. */
function PrLine({ p, action, onBase, onUnresolved }: { p: Pr; action: ReactNode; onBase?: (base: string) => void; onUnresolved: () => void }) {
  const { branches } = useDemo();
  const [pop, setPop] = useState<'checks' | 'review' | null>(null);
  const line = useRef<HTMLDivElement>(null);
  // Closed by a press anywhere else or Escape, like a menu.
  useEffect(() => {
    if (!pop) return;
    const down = (e: PointerEvent) => !line.current?.contains(e.target as Node) && setPop(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null);
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [pop]);
  const count = (s: string) => p.checks.filter((c) => c.status === s).length;
  const [passed, failing, waits] = [count('pass'), count('fail'), count('run') + count('wait')];
  const approvals = p.reviewers.filter((r) => r.vote === 'approve').length;
  const asked = p.reviewers.filter((r) => r.vote === 'changes').map((r) => r.login);
  const unresolved = p.threads.filter((t) => t.resolvable && !t.resolved).length;
  const checks = [...p.checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
  const sentence =
    p.state === 'merged' ? `Merged into ${p.base}.`
    : p.state === 'closed' ? 'Closed without merging.'
    : p.conflict ? `Conflicts with ${p.base}: resolve them on ${p.head} to merge it.`
    : failing ? `${plural(failing, 'check')} failing.`
    : waits ? `Merge waits for ${plural(waits, 'check')} still running.`
    : p.state === 'draft' ? `A draft: mark it ready for review on ${HOST} to merge it.`
    : asked.length ? `${asked.join(', ')} asked for changes.`
    : approvals ? `Ready to merge into ${p.base}.`
    : p.reviewers.length ? 'Waiting for a review.'
    : 'No review asked for yet.';
  const gates: Gate[] = [
    ...(p.checks.length ? [{ key: 'checks', label: 'Checks', value: <>{passed}<small>/{p.checks.length}</small></>, state: failing ? 'fail' : waits ? 'wait' : 'pass', running: waits > 0 } as Gate] : []),
    { key: 'review', label: 'Review', value: <>{approvals}<small>/{p.reviewers.length}</small></>, state: asked.length ? 'fail' : approvals ? 'pass' : 'wait' },
    { key: 'talk', label: 'Unresolved', value: unresolved, state: unresolved ? 'wait' : 'pass' },
  ];
  const merged = p.state === 'merged';
  const shut = p.state === 'closed';
  // How far the route runs: through every gate passed in a row (all of them once merged, none once closed).
  const reach = merged ? gates.length : shut ? -1 : (gates.findIndex((g) => g.state !== 'pass') + 1 || gates.length + 1) - 1;
  const seg = (i: number) => <span className="pr-seg" data-on={(i <= reach && !shut) || undefined} />;
  // Its branch here: its type and how far behind its base it is.
  const bv = branches[p.head];
  const kind = bv?.role === 'branch' && bv.kind;
  return (
    <div className="pr-line" ref={line}>
      <span className="pr-line-head">
        <span className="pr-line-box" data-draft={p.state === 'draft' || undefined}>
          {kind && <span className="map-kind">{kind}</span>}
          <span className="mono ellipsis" title={p.head}>{kind ? p.head.slice(kind.length + 1) : p.head}</span>
        </span>
        {bv && bv.base === p.base && bv.behind > 0 && (
          <span className="pr-chip mono" title={`${plural(bv.behind, 'commit')} of ${p.base} not in ${p.head} yet`}>
            <span className="c-del">↓{bv.behind}</span>
          </span>
        )}
      </span>
      {gates.map((g, i) => (
        <Fragment key={g.key}>
          {seg(i)}
          <span className="pr-gate-wrap">
            <button
              className="pr-gate"
              aria-expanded={g.key === 'talk' ? undefined : pop === g.key}
              aria-label={g.key === 'talk' ? `${plural(unresolved, 'unresolved conversation')}, show them` : undefined}
              onClick={() => (g.key === 'talk' ? onUnresolved() : setPop(pop === g.key ? null : g.key))}
            >
              <span className="pr-stn" data-state={g.state === 'pass' ? 'pass' : g.state === 'fail' ? 'fail' : i === reach ? 'now' : undefined} />
              <span className="label">{g.label}</span>
              <b>{g.value}</b>
              {g.running && <span className="pulse pr-check-dot run" />}
            </button>
            {pop === 'checks' && g.key === 'checks' && (
              <div className="pr-pop" role="group" aria-label="Checks">
                <ul className="pr-status-list">
                  {checks.map((c) => (
                    <li key={c.name}>
                      <button className="pr-status-row" title="Open its logs" onClick={() => setPop(null)}>
                        <span className={`pulse pr-check-dot ${c.status}`} />
                        <span className="grow ellipsis">{c.name}</span>
                        <span className={c.status === 'fail' ? 'c-del' : 'muted'}>{CHECK_WORD[c.status]}</span>
                        <Icon name="external" size={11} className="faint" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pop === 'review' && g.key === 'review' && (
              <div className="pr-pop" role="group" aria-label="Reviewers">
                {p.reviewers.length === 0 ? (
                  <span className="hint">No reviewers yet.</span>
                ) : (
                  <ul className="pr-status-list">
                    {p.reviewers.map((r) => (
                      <li key={r.login} className="pr-status-row">
                        <Avatar name={r.login} size={18} />
                        <span className="grow ellipsis">{r.login}</span>
                        <span className={r.vote === 'changes' ? 'c-warn' : r.vote === 'approve' ? 'c-current' : 'faint'}>
                          {r.vote === 'approve' && <Icon name="check" size={11} />}
                          {VOTE_WORD[r.vote]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </span>
        </Fragment>
      ))}
      {seg(gates.length)}
      <span className="pr-line-base">
        <span className="pr-stn" data-main data-state={merged ? 'pass' : undefined} />
        {onBase ? <BasePick head={p.head} base={p.base} onPick={onBase} /> : p.base}
      </span>
      <span className="pr-line-say">{sentence}</span>
      {action}
    </div>
  );
}

/** The base on the line, a branch picker while it is open: MenuChoice with className pr-base-pick. */
function BasePick({ head, base, onPick }: { head: string; base: string; onPick: (b: string) => void }) {
  const { branches } = useDemo();
  return <Choice className="pr-base-pick" label={`Merges into ${base}: change it`} value={base} options={branchOptions(branches, head)} onChange={(b) => b !== base && onPick(b)} />;
}

/** Files changed: the list, then the picked file's diff with the conversations on its lines under them. */
function PrFiles({ p, focus, setThread }: { p: Pr; focus: Thread | null; setThread: (id: string, f: (t: Thread) => Thread) => void }) {
  const { flash } = useDemo();
  const [sel, setSel] = useState(focus?.path);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const f = p.files.find((x) => x.path === sel) ?? p.files[0];
  // The conversation picked in the conversation list, brought into view.
  useEffect(() => {
    if (focus) document.getElementById(`pr-thread-${focus.id}`)?.scrollIntoView({ block: 'center' });
  }, []);
  if (!f) return <EmptyState icon="pr" title="No changes">This pull request changes no files.</EmptyState>;
  const here = p.threads.filter((t) => t.path === f.path);
  // Numbered rows: old and new line numbers, as DiffView counts them from the hunk's start.
  let [o, n] = [f.start, f.start];
  const rows = f.lines.map((l) => {
    const k = l[0] as ' ' | '+' | '-';
    const r = { k, t: l.slice(1), o: k === '+' ? undefined : o, n: k === '-' ? undefined : n };
    if (k !== '+') o++;
    if (k !== '-') n++;
    return r;
  });
  const drawn = new Set(rows.map((r) => r.n));
  const elsewhere = here.filter((t) => t.line == null || !drawn.has(t.line));
  const notes = (line?: number) => {
    const ts = here.filter((t) => line != null && t.line === line);
    return ts.length ? <div className="diff-note"><div className="col" style={{ gap: 8 }}>{ts.map((t) => <ThreadView key={t.id} t={t} inline set={(g) => setThread(t.id, g)} />)}</div></div> : null;
  };
  const cls = (k: string) => (k === '+' ? ' add' : k === '-' ? ' del' : '');
  const sign = (k: string) => (k === '+' ? '+' : k === '-' ? '−' : '');
  const header = `@@ -${f.start},${rows.filter((r) => r.k !== '+').length} +${f.start},${rows.filter((r) => r.k !== '-').length} @@`;
  // Split: removed lines on the left facing the added ones on the right, the rest on both sides.
  const pairs: [(typeof rows)[number] | null, (typeof rows)[number] | null][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].k === ' ') {
      pairs.push([rows[i], rows[i]]);
      continue;
    }
    let j = i;
    const [dels, adds]: (typeof rows)[] = [[], []];
    while (rows[j]?.k === '-') dels.push(rows[j++]);
    while (rows[j]?.k === '+') adds.push(rows[j++]);
    for (let m = 0; m < Math.max(dels.length, adds.length); m++) pairs.push([dels[m] ?? null, adds[m] ?? null]);
    i = j - 1;
  }
  const cut = f.path.lastIndexOf('/');
  const ln = { '--ln': String(Math.max(o, n) - 1).length } as CSSProperties;
  return (
    <section className="pr-files" aria-label="Files changed">
      <nav className="pr-files-list" aria-label="Changed files">
        {p.files.map((x) => {
          const [add, del] = nums(x);
          const threads = p.threads.filter((t) => t.path === x.path).length;
          const c = x.path.lastIndexOf('/');
          return (
            <button key={x.path} className="file-btn" aria-pressed={x === f} onClick={() => setSel(x.path)}>
              <span className={`file-st ${{ A: 'c-add', D: 'c-del', M: 'c-mod' }[x.s]}`}>{x.s}</span>
              <span className="grow ellipsis" title={x.path}>
                <span>{x.path.slice(c + 1)}</span> <span className="faint" style={{ fontSize: 11.5 }}>{x.path.slice(0, Math.max(c, 0))}</span>
              </span>
              {threads > 0 && (
                <span className="pr-file-threads" aria-label={plural(threads, 'conversation')}>
                  <Icon name="comment" size={11} />
                  {threads}
                </span>
              )}
              <span className="row mono file-nums">
                <span className="c-add">{add > 0 && `+${add}`}</span>
                <span className="c-del">{del > 0 && `−${del}`}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="pr-code">
        <div className="code-file pr-code-bar">
          <span className="code-path mono ellipsis grow" title={f.path}>
            <span className="faint">{f.path.slice(0, cut + 1)}</span>
            <b>{f.path.slice(cut + 1)}</b>
          </span>
          <span className="hint ellipsis hide-narrow">Click a line number to comment</span>
          <Seg label="Diff mode" value={mode} onChange={setMode} options={[['unified', 'Unified'], ['split', 'Split']]} />
        </div>
        {elsewhere.length > 0 && (
          <div className="pr-elsewhere">
            {elsewhere.map((t) => <ThreadView key={t.id} t={t} set={(g) => setThread(t.id, g)} />)}
          </div>
        )}
        <div className="diff" onClick={(e) => (e.target as HTMLElement).closest('.ln') && flash(`In the app, a click on a line number comments on that line, posted to ${HOST}`)}>
          <div className="diff-pane">
            <div className="diff-pane-scroll">
              {mode === 'split' ? (
                <div className="diff-split" style={ln}>
                  <div className="diff-split-row">
                    {[0, 1].map((j) => (
                      <div key={j} className="diff-half hunk">
                        <span className="ln" />
                        <span className="sg" />
                        <span className="tx">{header}</span>
                      </div>
                    ))}
                  </div>
                  {pairs.map(([l, r], i) => (
                    <Fragment key={i}>
                      <div className="diff-split-row">
                        {[l && { ...l, num: l.o }, r && { ...r, num: r.n }].map((x, j) => (
                          <div key={j} className={`diff-half${x ? cls(x.k) : ' blank'}`}>
                            <span className="ln">{x?.num}</span>
                            <span className="sg">{x && sign(x.k)}</span>
                            <span className="tx">{x?.t}</span>
                          </div>
                        ))}
                      </div>
                      {notes(r?.n)}
                    </Fragment>
                  ))}
                </div>
              ) : (
                <div className="diff-u" style={ln}>
                  <div className="diff-row hunk">
                    <span className="ln" />
                    <span className="ln" />
                    <span className="sg" />
                    <span className="tx">{header}</span>
                  </div>
                  {rows.map((r, i) => (
                    <Fragment key={i}>
                      <div className={`diff-row${cls(r.k)}`}>
                        <span className="ln">{r.o}</span>
                        <span className="ln">{r.n}</span>
                        <span className="sg">{sign(r.k)}</span>
                        <span className="tx">{r.t}</span>
                      </div>
                      {notes(r.n)}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewForm({ p, set, onDone }: { p: Pr; set: (f: (p: Pr) => Pr) => void; onDone: () => void }) {
  const { flash } = useDemo();
  const later = useLater();
  // GitHub refuses votes from a PR's author.
  const opts: [Exclude<Vote, 'pending'>, string, string][] = p.mine
    ? [['comment', 'Comment', 'General feedback, no explicit approval.']]
    : [
        ['comment', 'Comment', 'General feedback, no explicit approval.'],
        ['approve', 'Approve', 'Ready to merge.'],
        ['changes', 'Request changes', 'Must be addressed before merging.'],
      ];
  const [vote, setVote] = useState(opts[0][0]);
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const submit = () => {
    set((x) => ({
      ...x,
      reviewers: [...x.reviewers.filter((r) => r.login !== LOGIN), { login: LOGIN, vote }],
      threads: [...x.threads, { id: `r${Date.now()}`, review: vote, resolvable: false, resolved: false, comments: [say(`r${Date.now()}`, LOGIN, text.trim() || { approve: 'Approved.', changes: 'Changes requested.', comment: '' }[vote], 'just now')] }],
    }));
    flash(`Review posted to ${HOST}`);
    onDone();
  };
  return (
    <section aria-label="Submit review" className="col card" style={{ padding: 16, gap: 12 }}>
      <div className="row wrap" style={{ margin: '0 0 4px', alignItems: 'baseline', rowGap: 2 }}>
        <h2 className="grow" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Submit review</h2>
        <span className="hint">Posted to {HOST} as a review</span>
      </div>
      <div className="field">
        <label htmlFor="pr-review-text">Summary <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
        <textarea id="pr-review-text" className="textarea" rows={3} placeholder="Overall feedback for the author…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ fontSize: 12, fontWeight: 500, padding: '0 0 6px' }}>Review type</legend>
        {opts.map(([v, t, s]) => (
          <button key={v} type="button" className="radio-card" aria-pressed={vote === v} onClick={() => setVote(v)}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      {p.mine && <span className="hint">You opened this pull request, so {HOST} only lets you comment on it.</span>}
      <div className="row wrap" style={{ margin: 0 }}>
        <button
          className="btn"
          disabled={drafting}
          onClick={() => {
            setDrafting(true);
            later(1100, () => {
              setDrafting(false);
              setText(p.conflict ? 'The streaming reads well. It conflicts with main in the terminal pane, so it needs a rebase before it can go in.' : 'Small, focused change with tests. One question inline about tags; otherwise good to go.');
            });
          }}
        >
          <Busy on={drafting}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
          Draft with AI
        </button>
        <span className="grow" />
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={vote === 'comment' && !text.trim()} onClick={submit}>Submit review</button>
      </div>
    </section>
  );
}

/** `inline`: drawn in the diff under its line, so without its file and code. `onShowCode` opens it in the files view. */
function ThreadView({ t, set, inline, onShowCode }: { t: Thread; set: (f: (t: Thread) => Thread) => void; inline?: boolean; onShowCode?: () => void }) {
  const later = useLater();
  const [open, setOpen] = useState(!t.resolved);
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setOpen(!t.resolved), [t.resolved]);
  const first = t.comments[0];
  const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ''}` : null;
  const setComment = (id: string, f: (c: Comment) => Comment) => set((x) => ({ ...x, comments: x.comments.map((c) => (c.id === id ? f(c) : c)) }));
  const react = (id: string, content: string, add: boolean) =>
    setComment(id, (c) => {
      const had = c.reactions.find((r) => r.content === content);
      if (add && had?.mine) return c;
      const reactions = had ? c.reactions.map((r) => (r === had ? { ...r, mine: add, count: r.count + (add ? 1 : -1) } : r)) : [...c.reactions, { content, count: 1, mine: true }];
      return { ...c, reactions: reactions.filter((r) => r.count > 0) };
    });

  if (!open) {
    return (
      <article id={`pr-thread-${t.id}`} className="thread row" style={{ padding: '8px 14px', gap: 10 }}>
        <span className="tag">Resolved</span>
        {where && !inline && <span className="mono faint" style={{ fontSize: 11.5 }}>{where}</span>}
        <span className="ellipsis grow muted">{first ? `${first.author}: ${first.body}` : ''}</span>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Show</button>
      </article>
    );
  }
  const send = () => {
    if (!draft.trim()) return;
    set((x) => ({ ...x, comments: [...x.comments, say(`c${Date.now()}`, LOGIN, draft.trim(), 'just now')] }));
    setDraft('');
  };
  return (
    <article id={`pr-thread-${t.id}`} className="thread">
      {where && !inline && (
        <>
          <div className="thread-file">
            <Icon name="file" size={12} />
            <span className="grow ellipsis">{where}</span>
            {onShowCode && (
              <button className="btn btn-ghost btn-sm" onClick={onShowCode}>
                <Icon name="file" size={11} />
                Show in code
              </button>
            )}
          </div>
          {t.snippet && (
            <div className="snippet">
              {t.snippet.map((l, i) => <div key={i} className={l.startsWith('+') ? 'c-add' : l.startsWith('-') ? 'c-del' : 'muted'}>{l}</div>)}
            </div>
          )}
        </>
      )}
      {t.comments.map((c) => (
        <div key={c.id} className="comment">
          <Avatar name={c.author} size={28} />
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500 }}>{c.author}</span>
              {t.review && <span className={`tag ${t.review === 'changes' ? 'c-warn' : ''}`}>{{ approve: 'Approved', changes: 'Requested changes', comment: 'Reviewed' }[t.review]}</span>}
              <span className="faint grow" style={{ fontSize: 12 }}>{c.ago}</span>
              {c.author === LOGIN && editing?.id !== c.id && (
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Edit comment" onClick={() => setEditing({ id: c.id, text: c.body })}>
                  <Icon name="edit" size={12} />
                </button>
              )}
            </div>
            {editing?.id === c.id ? (
              <div className="col" style={{ gap: 6 }}>
                <label htmlFor={`edit-${c.id}`} className="sr-only">Edit comment</label>
                <textarea id={`edit-${c.id}`} className="textarea" rows={3} autoFocus value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} />
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" disabled={!editing.text.trim()} title="Fix spelling and grammar and smooth the wording" onClick={() => setEditing({ id: c.id, text: tidy(editing.text) })}>
                    <Icon name="sparkle" size={11} className="c-acc" />
                    Improve
                  </button>
                  <span className="grow" />
                  <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn btn-sm btn-primary" disabled={!editing.text.trim() || editing.text === c.body} onClick={() => { setComment(c.id, (x) => ({ ...x, body: editing.text })); setEditing(null); }}>Save</button>
                </div>
              </div>
            ) : (
              <div className="comment-body"><Markdown text={c.body} /></div>
            )}
            <div className="row wrap" style={{ gap: 6, position: 'relative' }}>
              {c.reactions.map((r) => (
                <button key={r.content} className="reaction" aria-pressed={r.mine} aria-label={`${r.content} ${r.count}${r.mine ? ', you reacted' : ''}`} onClick={() => react(c.id, r.content, !r.mine)}>
                  <span>{emojiOf(r.content)}</span>
                  <span>{r.count}</span>
                </button>
              ))}
              <button className="reaction" aria-label="Add reaction" aria-expanded={picker === c.id} onClick={() => setPicker(picker === c.id ? null : c.id)}>
                <Icon name="smile" size={13} stroke={1.3} />
              </button>
              {picker === c.id && (
                <div role="group" aria-label="Pick a reaction" className="row card" style={{ gap: 2, padding: 4 }}>
                  {EMOJI.map(([content, e, label]) => (
                    <button key={content} className="btn btn-ghost btn-sm" aria-label={label} onClick={() => { react(c.id, content, true); setPicker(null); }}>{e}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      <div className="col" style={{ padding: '10px 14px 14px', borderTop: '1px solid var(--line)' }}>
        <label htmlFor={`reply-${t.id}`} className="sr-only">Reply</label>
        <textarea id={`reply-${t.id}`} className="textarea" rows={2} placeholder="Reply…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row wrap">
          <button
            className="btn btn-sm"
            disabled={drafting}
            title={draft.trim() ? 'Fix spelling and grammar and smooth the wording of your reply' : undefined}
            onClick={() => {
              if (draft.trim()) return setDraft(tidy(draft));
              setDrafting(true);
              later(1000, () => {
                setDrafting(false);
                setDraft(t.path ? 'Good catch, thanks. Done in the last commit.' : 'Thanks! Looking at it this afternoon.');
              });
            }}
          >
            <Busy on={drafting}><Icon name="sparkle" size={11} className="c-acc" /></Busy>
            {draft.trim() ? 'Improve reply' : 'Draft reply'}
          </button>
          <span className="grow" />
          {t.resolvable && !t.resolved && (
            <button className="btn btn-sm" onClick={() => set((x) => ({ ...x, resolved: true }))}>
              <Icon name="check" size={11} />
              Resolve
            </button>
          )}
          {t.resolved && (
            <>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
              <button className="btn btn-sm" onClick={() => set((x) => ({ ...x, resolved: false }))}>Reopen</button>
            </>
          )}
          <button className="btn btn-sm btn-primary" disabled={!draft.trim()} onClick={send}>Reply</button>
        </div>
      </div>
    </article>
  );
}

function NewComment({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="col" style={{ marginTop: 10 }}>
      <label htmlFor="pr-new-comment" className="sr-only">New comment</label>
      <textarea id="pr-new-comment" className="textarea" rows={3} placeholder="Leave a comment on this pull request…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => { onSend(text.trim()); setText(''); }}>Comment</button>
      </div>
    </div>
  );
}
