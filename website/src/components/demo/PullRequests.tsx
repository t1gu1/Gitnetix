import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { Avatar, Busy, Empty, EmptyState, Markdown, Modal, Seg, useDemo, useLater } from './ui';

/** src/screens/PullRequests.tsx on a made-up GitHub repo: merge, close, review, comment, react, resolve; checks finish as you watch. */

type Tab = 'open' | 'review' | 'closed';
type Vote = 'approve' | 'changes' | 'comment' | 'pending';
type Check = { name: string; status: 'pass' | 'fail' | 'run' | 'wait' };
type Reaction = { content: string; count: number; mine: boolean };
type Comment = { id: string; author: string; body: string; ago: string; reactions: Reaction[] };
type Thread = { id: string; file?: string; snippet?: string[]; comments: Comment[]; resolvable: boolean; resolved: boolean; review?: Exclude<Vote, 'pending'> };
type Pr = { number: number; title: string; body: string; author: string; mine?: boolean; review?: boolean; state: 'open' | 'draft' | 'merged' | 'closed'; head: string; base: string; ago: string; conflict?: boolean; checks: Check[]; reviewers: { login: string; vote: Vote }[]; threads: Thread[] };

const LOGIN = 'grace-hopper';
const GROUPS: Pr['state'][] = ['open', 'draft', 'merged', 'closed'];
const EMOJI: [string, string, string][] = [
  ['THUMBS_UP', '👍', 'Thumbs up'],
  ['THUMBS_DOWN', '👎', 'Thumbs down'],
  ['LAUGH', '😄', 'Laugh'],
  ['HOORAY', '🎉', 'Hooray'],
  ['HEART', '❤️', 'Heart'],
  ['ROCKET', '🚀', 'Rocket'],
];
const emojiOf = (content: string) => EMOJI.find((e) => e[0] === content)?.[1];
const initials = (name: string) => name.split('-').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const pass = (...names: string[]): Check[] => names.map((name) => ({ name, status: 'pass' }));
const say = (id: string, author: string, body: string, ago: string, reactions: Reaction[] = []): Comment => ({ id, author, body, ago, reactions });

const PRS: Pr[] = [
  {
    number: 148, title: 'Branch tree: keyboard navigation', author: LOGIN, mine: true, state: 'open', head: 'feat/tree-keys', base: 'release/0.6.0', ago: '2 h ago',
    body: 'Arrow keys move through the branch tree, like a file list.\n\n- **↑ / ↓** move between rows, **← / →** fold and unfold child branches\n- **Enter** checks the branch out\n- Focus stays on the row after a checkout\n\nCloses WEB-189',
    checks: [...pass('lint', 'typecheck'), { name: 'test (ubuntu-latest)', status: 'run' }, { name: 'test (windows-latest)', status: 'wait' }],
    reviewers: [{ login: 'ana-moreau', vote: 'approve' }, { login: 'jules-laurent', vote: 'pending' }],
    threads: [
      { id: 't1', review: 'approve', resolvable: false, resolved: false, comments: [say('c1', 'ana-moreau', 'Feels right with the arrows. One nit inline, approving anyway.', '1 h ago', [{ content: 'HOORAY', count: 1, mine: false }])] },
      {
        id: 't2', file: 'src/screens/BranchTree.tsx:214', resolvable: true, resolved: false,
        snippet: ['   case "ArrowDown":', '+    focusRow(rows[i + 1]);', '+    break;', '+  case "Home":'],
        comments: [say('c2', 'ana-moreau', 'Could `Home` and `End` jump to the trunk and to the last release?', '1 h ago', [{ content: 'THUMBS_UP', count: 2, mine: false }])],
      },
    ],
  },
  {
    number: 144, title: 'Diff view: theme tokens for added and removed lines', author: LOGIN, mine: true, state: 'draft', head: 'feat/diff-tokens', base: 'release/0.6.0', ago: 'yesterday',
    body: 'Moves the diff colors to theme tokens, so every theme paints its own added and removed lines.\n\nStill to do: the light themes.',
    checks: pass('lint', 'typecheck', 'test (ubuntu-latest)'), reviewers: [], threads: [],
  },
  {
    number: 147, title: 'Prune branches deleted on origin', author: 'jules-laurent', review: true, state: 'open', head: 'fix/stale-remote', base: 'release/0.6.0', ago: '35 min ago',
    body: 'Branches deleted on origin stayed in the tree until a full refresh.\n\n- The background fetch passes `--prune`\n- The branch cache drops refs that left origin\n\nFixes WEB-218',
    checks: [...pass('lint', 'typecheck'), { name: 'test (ubuntu-latest)', status: 'fail' }],
    reviewers: [{ login: LOGIN, vote: 'pending' }, { login: 'riya-kapoor', vote: 'comment' }],
    threads: [
      {
        id: 't3', file: 'crates/core/src/git.rs:88', resolvable: true, resolved: false,
        snippet: ['-    self.run(&["fetch", "origin"]).await?;', '+    self.run(&["fetch", "--prune", "origin"]).await?;'],
        comments: [
          say('c3', 'riya-kapoor', 'Does `--prune` drop tags too? Some people still check out old tags.', '30 min ago'),
          say('c4', 'jules-laurent', 'Only branches: tags need `--prune-tags`. Adding a test for it.', '22 min ago', [{ content: 'THUMBS_UP', count: 1, mine: false }]),
        ],
      },
    ],
  },
  {
    number: 151, title: 'Agent pane: stream steps as they happen', author: 'riya-kapoor', review: true, state: 'open', conflict: true, head: 'feat/agent-pane', base: 'main', ago: '3 h ago',
    body: 'Steps show up in the agent pane while the agent works, instead of all at once at the end.\n\n- Steps stream over the event channel\n- The newest group stays open\n\nCloses WEB-221',
    checks: pass('lint', 'typecheck', 'test (ubuntu-latest)'),
    reviewers: [{ login: LOGIN, vote: 'pending' }],
    threads: [{ id: 't4', resolvable: false, resolved: false, comments: [say('c5', 'riya-kapoor', 'Grace, this one touches the terminal too. Could you have a look?', '3 h ago')] }],
  },
  { number: 141, title: 'Release 0.5.2', author: 'ana-moreau', state: 'merged', head: 'release/0.5.2', base: 'main', ago: '6 days ago', body: 'Hotfix release: worktrees in folders with spaces open again on Windows.', checks: pass('lint', 'test (ubuntu-latest)'), reviewers: [{ login: LOGIN, vote: 'approve' }], threads: [] },
  { number: 139, title: 'Squash merge detection', author: LOGIN, mine: true, state: 'merged', head: 'feat/squash-detect', base: 'release/0.5.0', ago: '3 weeks ago', body: 'Branches whose ticket key shows up in a later squash commit count as merged.', checks: pass('lint', 'test (ubuntu-latest)'), reviewers: [{ login: 'ana-moreau', vote: 'approve' }], threads: [] },
  { number: 137, title: 'Experiment: commit graph view', author: LOGIN, mine: true, state: 'closed', head: 'poc/graph', base: 'main', ago: 'Sep 12, 2026', body: 'A classic commit graph next to the tree, to compare. Closed: the tree reads better.', checks: [], reviewers: [], threads: [] },
];

function stateOf(p: Pr): [string, string] {
  if (p.state === 'merged') return ['Merged', 'c-mod'];
  if (p.state === 'closed') return ['Closed', 'faint'];
  if (p.conflict) return ['Conflict', 'c-del'];
  if (p.state === 'draft') return ['Draft', 'muted'];
  if (p.checks.some((c) => c.status === 'run')) return ['Checks running', 'c-acc'];
  if (p.checks.some((c) => c.status === 'wait')) return ['Checks waiting', 'c-acc'];
  if (p.reviewers.some((r) => r.vote === 'approve') && !p.checks.some((c) => c.status === 'fail')) return ['Ready to merge', 'c-add'];
  return ['Open', 'c-add'];
}
const inTab = (p: Pr, t: Tab) =>
  t === 'closed' ? p.state === 'merged' || (!!p.mine && p.state === 'closed') : t === 'review' ? !!p.review && p.state !== 'merged' && p.state !== 'closed' : !!p.mine && (p.state === 'open' || p.state === 'draft');
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

export default function PullRequests() {
  const { flash, sel: branch, branches } = useDemo();
  const later = useLater();
  const [prs, setPrs] = useState(PRS);
  const [tab, setTab] = useState<Tab>('open');
  const [sel, setSel] = useState<number>();
  const [creating, setCreating] = useState(false);
  const list = prs.filter((p) => inTab(p, tab));
  const current = prs.find((p) => p.number === (sel ?? list[0]?.number));
  const update = (n: number) => (f: (p: Pr) => Pr) => setPrs((ps) => ps.map((p) => (p.number === n ? f(p) : p)));
  // CI moves on as you watch: running checks pass, waiting ones start.
  useEffect(() => {
    const t = setInterval(() => setPrs((ps) => (ps.some(pending) ? ps.map((p) => ({ ...p, checks: p.checks.map((c) => ({ ...c, status: c.status === 'run' ? 'pass' : c.status === 'wait' ? 'run' : c.status })) })) : ps)), 5000);
    return () => clearInterval(t);
  }, []);
  const b = branches[branch];
  const unpushed = b && b.role !== 'trunk' && b.ahead === 0 ? `${branch} has no commits ahead of its base yet.` : undefined;
  const create = () => {
    const open = prs.find((p) => p.head === branch && (p.state === 'open' || p.state === 'draft'));
    if (open) {
      setTab('open');
      setSel(open.number);
      return flash(`#${open.number} is already open for ${branch}`);
    }
    setCreating(true);
    later(1500, () => {
      const number = Math.max(...prs.map((p) => p.number)) + 1;
      const ours = branch === 'feat/branch-tree';
      setPrs((ps) => [
        {
          number, author: LOGIN, mine: true, state: 'open', head: branch, base: b?.base ?? 'main', ago: 'just now', reviewers: [], threads: [],
          title: ours ? 'Animate the path to the checked-out branch' : titleOf(branch),
          body: ours
            ? 'A light runs along the branch path, from `main` to the branch you have checked out.\n\n- Restarts when you switch branch\n- Stays still when the system asks for reduced motion\n\nCloses WEB-212'
            : `${titleOf(branch)}, as described in its commits.\n\n- ${plural(b?.ahead ?? 1, 'commit')} on top of ${b?.base ?? 'main'}`,
          checks: [{ name: 'lint', status: 'run' }, { name: 'typecheck', status: 'wait' }, { name: 'test (ubuntu-latest)', status: 'wait' }],
        },
        ...ps,
      ]);
      setCreating(false);
      setTab('open');
      setSel(number);
      flash(`Opened #${number}`);
    });
  };

  return (
    <>
      <section aria-label="Pull request list" className="master" style={{ '--master-w': '380px' } as CSSProperties}>
        <div className="master-tools">
          <Seg
            grid
            label="Filter"
            value={tab}
            onChange={(t) => { setTab(t); setSel(undefined); }}
            options={(['open', 'review', 'closed'] as Tab[]).map((t) => [t, <>{{ open: 'Open', review: 'To review', closed: 'Closed' }[t]} <span className="faint">{prs.filter((p) => inTab(p, t)).length}</span></>])}
          />
          {unpushed && <div className="err-box warn">{unpushed}</div>}
          <button className="btn" disabled={creating || !!unpushed} onClick={create}>
            <Busy on={creating}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
            <span className="ellipsis">New PR from {branch}</span>
          </button>
        </div>
        <div className="scroll" style={{ flex: '1 1 auto', paddingBottom: 12 }}>
          {list.length === 0 && <Empty>Nothing here.</Empty>}
          {GROUPS.map((s) => ({ s, items: list.filter((p) => p.state === s) }))
            .filter((g) => g.items.length)
            .map(({ s, items }) => {
              const [label, cls] = stateOf(items[0]);
              return (
                <div key={s}>
                  <div className="group-head" style={{ fontSize: 13, fontWeight: 700 }}>
                    <span className={cls}>{label}</span>
                    <span>{items.length}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    {items.map((p) => (
                      <button key={p.number} className="item-btn" style={{ gap: 1, padding: '7px 12px' }} aria-pressed={p.number === current?.number} onClick={() => setSel(p.number)}>
                        <span className="row" style={{ gap: 8, margin: '0 0 2px', fontSize: 11.5 }}>
                          <Avatar name={p.author} />
                          <span className="mono faint">#{p.number}</span>
                          <span className={cls} style={{ fontSize: 13 }}>{label}</span>
                          <span className="faint ellipsis grow">{p.mine ? 'You' : p.author}</span>
                          <span className="faint">{p.ago}</span>
                        </span>
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{p.title}</span>
                        <span className="mono faint ellipsis" style={{ fontSize: 11.5, marginTop: 8 }}>{p.head} → {p.base}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </section>
      <main className="detail">
        {current ? <Detail key={current.number} p={current} set={update(current.number)} /> : <EmptyState icon="pr" title="No pull request selected">Pick one from the list to read its description, checks and reviews.</EmptyState>}
      </main>
    </>
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
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [checksOpen, setChecksOpen] = useState(false);
  const [busy, setBusy] = useState<'merge' | 'gen'>();
  const open = p.state === 'open' || p.state === 'draft';
  const [label, cls] = stateOf(p);
  const failing = p.checks.filter((c) => c.status === 'fail').length;
  const running = p.checks.filter((c) => c.status === 'run').length;
  const waiting = p.checks.filter((c) => c.status === 'wait').length;
  const pend = [running && `${running} running`, waiting && `${waiting} waiting`].filter(Boolean).join(', ');
  const unresolved = p.threads.filter((t) => t.resolvable && !t.resolved).length;
  const approvals = p.reviewers.filter((r) => r.vote === 'approve').length;
  const changes = p.reviewers.filter((r) => r.vote === 'changes').length;
  const votes = [approvals && plural(approvals, 'approval'), changes && `${changes} changes requested`].filter(Boolean).join(' · ');
  const threads = filter === 'open' ? p.threads.filter((t) => t.resolvable && !t.resolved) : p.threads;
  const setThread = (id: string, f: (t: Thread) => Thread) => set((x) => ({ ...x, threads: x.threads.map((t) => (t.id === id ? f(t) : t)) }));
  const startEdit = (t = p.title, b = p.body) => {
    setTitle(t);
    setBody(b);
    setEditing(true);
  };

  return (
    <div className="detail-inner">
      <div className="col" style={{ gap: 2, marginBottom: -4 }}>
        {editing ? (
          <div className="field">
            <label htmlFor="pr-title">Title</label>
            <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', margin: 0 }}>
            <h1 className="grow">{p.title}</h1>
            {open && (
              <button className="btn btn-ghost btn-icon" style={{ marginBlock: -3 }} aria-label="Edit title and description" onClick={() => startEdit()}>
                <Icon name="edit" />
              </button>
            )}
          </div>
        )}
        <div className="row wrap muted" style={{ fontSize: 12.5, margin: 0 }}>
          <span className={`pill ${cls}`}>{label}</span>
          <span className="mono">#{p.number} · {p.head} → {p.base}</span>
          <span className="faint">·</span>
          <span>{p.mine ? 'Opened by you' : `Opened by ${p.author}`} · {p.ago}</span>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6, margin: 0 }}>
        {open && !p.conflict && p.state !== 'draft' && (
          <button
            className="btn btn-primary"
            disabled={!!busy || running + waiting > 0}
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
            Merge into {p.base}
          </button>
        )}
        {p.conflict && open && (
          <button className="btn btn-primary" onClick={() => openBranch(p.head)}>
            <Icon name="sparkle" size={12} />
            Resolve conflicts with AI
          </button>
        )}
        {open && <button className="btn" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>Review</button>}
        {open && (
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => {
              setBusy('gen');
              later(1300, () => {
                setBusy(undefined);
                startEdit(p.title.replace(/^.*?: /, '').replace(/^./, (c) => c.toUpperCase()), rewrite(p.body));
              });
            }}
          >
            <Busy on={busy === 'gen'}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
            Rewrite with AI
          </button>
        )}
        <button className="btn" onClick={() => flash(`Opens #${p.number} on GitHub`)}>
          <Icon name="external" size={12} />
          Open on GitHub
        </button>
        {open && (
          <button className="btn btn-danger" onClick={() => setConfirmClose(true)}>
            <Icon name="close" size={12} />
            Close pull request
          </button>
        )}
        {p.state === 'closed' && <button className="btn" onClick={() => { set((x) => ({ ...x, state: 'open' })); flash(`Reopened #${p.number}`); }}>Reopen</button>}
        {unresolved > 0 && open && <span className="c-acc" style={{ fontSize: 12.5 }}>{plural(unresolved, 'unresolved conversation')}</span>}
      </div>

      {confirmClose && (
        <Modal
          title={`Close #${p.number}?`}
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn btn-md" onClick={() => setConfirmClose(false)}>Cancel</button>
              <button className="btn btn-md btn-danger" onClick={() => { set((x) => ({ ...x, state: 'closed' })); setConfirmClose(false); flash(`Closed #${p.number}`); }}>
                {deleteBranch ? 'Close and delete branch' : 'Close without merging'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {deleteBranch ? (
              <>Abandons the pull request on GitHub and deletes <span className="mono">{p.head}</span> here and on origin, with its worktree. Commits not merged elsewhere are lost.</>
            ) : (
              <>Abandons the pull request on GitHub. The branch <span className="mono">{p.head}</span> and its commits stay, and you can reopen it later.</>
            )}
          </p>
          <label className="check">
            <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
            <span>Also delete <span className="mono">{p.head}</span>, locally and on origin</span>
          </label>
        </Modal>
      )}

      {reviewOpen && <ReviewForm p={p} set={set} onDone={() => setReviewOpen(false)} />}

      {p.checks.length > 0 && (
        <section className="section">
          <div className="row" style={{ margin: 0 }}>
            <h2>Checks</h2>
            <span className={failing ? 'c-del' : pend ? 'c-acc' : 'c-add'} style={{ fontSize: 12.5 }}>
              {failing ? `${failing} failing` : pend ? `${p.checks.length - running - waiting} of ${p.checks.length} passed, ${pend}` : `All ${p.checks.length} passing`}
            </span>
            <span className="grow" />
            <button className="btn btn-sm" aria-expanded={checksOpen} onClick={() => setChecksOpen(!checksOpen)}>
              <Icon name="chevronDown" size={12} className="chev" />
              {checksOpen ? 'Hide' : 'Show all'}
            </button>
          </div>
          {checksOpen && (
            <ul className="list">
              {p.checks.map((c) => (
                <li key={c.name}>
                  <div className="list-row" style={{ minHeight: 40 }}>
                    <span className="pulse" style={{ animation: c.status === 'run' ? undefined : 'none', background: c.status === 'pass' ? 'var(--add-fg)' : c.status === 'fail' ? 'var(--del-fg)' : c.status === 'wait' ? 'var(--faint)' : 'var(--accent)' }} />
                    <span className="grow">{c.name}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{{ pass: 'Passed', fail: 'Failed', wait: 'Waiting', run: 'Running' }[c.status]}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="section">
        <h2>
          Reviewers
          {votes && <span className="faint" style={{ fontSize: 13, fontWeight: 400, marginLeft: 8 }}>({votes})</span>}
        </h2>
        {p.reviewers.length === 0 ? (
          <span className="muted">No reviewers yet.</span>
        ) : (
          <div className="row wrap" style={{ gap: 12, margin: '4px 0 0' }}>
            {p.reviewers.map((r) => (
              <span key={r.login} className="row" style={{ gap: 8, margin: 0 }}>
                <span className="avatar" aria-hidden="true">{initials(r.login)}</span>
                <span>{r.login}</span>
                <span className={r.vote === 'approve' ? 'c-add' : r.vote === 'changes' ? 'c-acc' : 'faint'} style={{ fontSize: 12 }}>
                  {{ approve: 'Approved', changes: 'Changes requested', comment: 'Commented', pending: 'Review requested' }[r.vote]}
                </span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="row">
          <h2>Description</h2>
          <span className="grow" />
          {open && !editing && (
            <button className="btn btn-sm" onClick={() => startEdit()}>
              <Icon name="edit" size={12} />
              Edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="col">
            <label htmlFor="pr-body" className="sr-only">Description</label>
            <textarea id="pr-body" className="textarea mono" rows={12} style={{ fontSize: 12.5 }} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="row wrap">
              <span className="grow" />
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!title.trim()} onClick={() => { set((x) => ({ ...x, title, body })); setEditing(false); flash('Saved to GitHub'); }}>Save to GitHub</button>
            </div>
          </div>
        ) : p.body ? (
          <div className="card" style={{ padding: '6px 16px' }}>
            <Markdown text={p.body} />
          </div>
        ) : (
          <span className="muted">No description.</span>
        )}
      </section>

      <section className="section" aria-label="Conversation" style={{ gap: 6 }}>
        <div className="row wrap" style={{ marginBottom: 6 }}>
          <h2>Conversation</h2>
          <span className="faint" style={{ fontSize: 12 }}>{p.threads.length ? `${unresolved} unresolved · ${p.threads.length} total` : ''}</span>
          <span className="grow" />
          <Seg label="Show" value={filter} onChange={setFilter} options={[['all', 'All'], ['open', 'Unresolved']]} />
        </div>
        {threads.map((t) => <ThreadView key={t.id} t={t} set={(f) => setThread(t.id, f)} />)}
        {threads.length === 0 && <span className="muted">{p.threads.length === 0 ? 'No comments yet.' : 'Every conversation is resolved.'}</span>}
        <NewComment onSend={(text) => set((x) => ({ ...x, threads: [...x.threads, { id: `n${Date.now()}`, resolvable: false, resolved: false, comments: [say(`n${Date.now()}`, LOGIN, text, 'just now')] }] }))} />
      </section>
    </div>
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
    flash('Review posted to GitHub');
    onDone();
  };
  return (
    <section aria-label="Submit review" className="col card" style={{ padding: 16, gap: 12 }}>
      <div className="row">
        <h2 className="grow">Submit review</h2>
        <span className="hint">Posted to GitHub as a review</span>
      </div>
      <div className="field">
        <label htmlFor="pr-review-text">Summary <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
        <textarea id="pr-review-text" className="textarea" rows={3} placeholder="Overall feedback for the author…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ fontSize: 12, paddingBottom: 6 }}>Review type</legend>
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
      {p.mine && <span className="hint">You opened this pull request, so GitHub only lets you comment on it.</span>}
      <div className="row wrap">
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

function ThreadView({ t, set }: { t: Thread; set: (f: (t: Thread) => Thread) => void }) {
  const later = useLater();
  const [open, setOpen] = useState(!t.resolved);
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => setOpen(!t.resolved), [t.resolved]);
  const first = t.comments[0];
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
      <article className="thread row" style={{ padding: '8px 14px', gap: 10 }}>
        <span className="pill c-add">Resolved</span>
        {t.file && <span className="mono faint" style={{ fontSize: 11.5 }}>{t.file}</span>}
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
    <article className="thread">
      {t.file && (
        <>
          <div className="thread-file">
            <Icon name="branch" size={12} />
            {t.file}
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
          <span className="avatar" aria-hidden="true">{initials(c.author)}</span>
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500 }}>{c.author}</span>
              {t.review && <span className={`pill ${t.review === 'approve' ? 'c-add' : t.review === 'changes' ? 'c-acc' : 'faint'}`}>{{ approve: 'Approved', changes: 'Requested changes', comment: 'Reviewed' }[t.review]}</span>}
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
              <div className="comment-body">{c.body}</div>
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
                setDraft(t.file ? 'Good catch, thanks. Done in the last commit.' : 'Thanks! Looking at it this afternoon.');
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
