import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { KINDS, kindOfBranch, withPrefix, withTicket, type Kind } from '../../../../src/lib/kinds';
import { blocks } from '../../../../src/lib/agentLog';
import { AgentInput, AgentLog, AgentPicker, DiscardModal, FinishCard, RETRY, keyOf, pathOf, shown, type Pick, type Session } from './agents';
import { Choice, Empty, EmptyState, Menu, Modal, Seg, useDemo, useLater, type MenuItem } from './ui';

/**
 * src/screens/Worktrees.tsx: every worktree of every project with its agent. Agents stream their steps, ask questions you answer
 * with a click, and end with the merge options; the workspace's agents show up here too.
 */

const STATUS: Record<ReturnType<typeof shown>, [string, string]> = {
  running: ['Running', 'c-acc'],
  waiting: ['Waiting for you', 'c-add'],
  paused: ['Paused', 'muted'],
  failed: ['Failed', 'c-del'],
  done: ['Done', 'c-add'],
  stopped: ['Stopped', 'faint'],
  idle: ['No agent', 'faint'],
};
type Filter = 'all' | 'running' | 'needs';
// Statuses left out only show under "All".
const GROUP: Partial<Record<string, Exclude<Filter, 'all'>>> = { running: 'running', waiting: 'needs', done: 'needs', failed: 'needs' };
const match = (s: string, f: Filter) => f === 'all' || GROUP[s] === f;
const PROJECTS = ['acme-web', 'acme-api', 'design-system'];
/** The other projects' branches; acme-web's are the workspace's. */
const OTHER: Record<string, string[]> = { 'acme-api': ['main', 'release/2.4.0', 'feat/webhooks', 'fix/invoice-pdf'], 'design-system': ['main', 'feat/date-picker', 'fix/focus-ring'] };
/** What the backend names a branch after when no name is given: the request's first words. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-');
const requestOf = (s: Session) => blocks(s.lines).find((b) => b.kind === 'you')?.text.split('\n')[0];

export default function Worktrees() {
  const { agents } = useDemo();
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string>();
  const [starting, setStarting] = useState<string>();
  // Right-click or "…" selects the row and opens its actions: they and their modals live in its Detail.
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; alignRight?: boolean } | null>(null);
  // The agent at work when you arrive carries on now that someone is watching.
  useEffect(() => agents.wake(), []);
  const openMenu = (s: Session, e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Keyboard-opened context menus report (0, 0): anchor to the element instead.
    const b = e.currentTarget.getBoundingClientRect();
    const fromKey = e.type === 'contextmenu' && e.clientX === 0 && e.clientY === 0;
    setSel(s.key);
    if (e.type !== 'contextmenu') setMenu(menu?.key === s.key ? null : { key: s.key, x: b.right, y: b.bottom + 2, alignRight: true });
    else setMenu({ key: s.key, x: fromKey ? b.left : e.clientX, y: fromKey ? b.bottom + 2 : e.clientY });
  };
  const rows = agents.sessions.map((s) => ({ s, st: shown(s) }));
  const cur = rows.find((r) => r.s.key === sel) ?? rows[0];
  // Projects with matching rows first; the rest sink to the bottom as bare headers.
  const groups = PROJECTS.map((name) => ({ name, items: rows.filter((r) => r.s.project === name && match(r.st, filter)) }))
    .filter((g) => g.items.length || filter === 'all')
    .sort((a, b) => +!a.items.length - +!b.items.length);

  return (
    <>
      <section className="master" style={{ '--master-w': '340px' } as CSSProperties} aria-label="Worktrees">
        <div className="master-tools">
          <Seg<Filter>
            grid
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={(['all', 'running', 'needs'] as Filter[]).map((f) => [f, <>{{ all: 'All', running: 'Running', needs: 'Needs you' }[f]} <span className="faint">{rows.filter((r) => match(r.st, f)).length}</span></>])}
          />
        </div>
        <div className="scroll" style={{ flex: '1 1 auto', paddingBottom: 12 }}>
          {groups.map((g) => (
            <div key={g.name} className="wt-group" data-empty={!g.items.length || undefined}>
              <div className="wt-group-head">
                <span className="ellipsis grow">{g.name}</span>
                <span className="faint">{g.items.length || 'No worktrees'}</span>
                <button className="btn btn-ghost btn-sm btn-icon" aria-label={`New agent session in ${g.name}`} title="New agent session" onClick={() => setStarting(g.name)}>
                  <Icon name="plus" size={12} />
                </button>
              </div>
              {g.items.map(({ s, st }) => {
                const [label, cls] = STATUS[st];
                const sub = requestOf(s);
                const more = `More actions for ${s.branch}`;
                return (
                  <div key={s.key} className="wt-item" onContextMenu={(e) => openMenu(s, e)}>
                    <button className="item-btn wt-row" aria-pressed={s.key === cur?.s.key} title={pathOf(s)} onClick={() => setSel(s.key)}>
                      <span className="row" style={{ gap: 8 }}>
                        <span className="mono ellipsis grow">{s.branch}</span>
                        {s.add + s.del > 0 && <span className="mono wt-stat"><span className="c-add">+{s.add}</span> <span className="c-del">−{s.del}</span></span>}
                      </span>
                      <span className="row wt-base" style={{ gap: 6 }}>
                        <span className="faint ellipsis">from {s.base}</span>
                        {s.behind > 0 && <span className="c-warn mono" style={{ flex: 'none' }} title={`${s.base} has ${plural(s.behind, 'commit')} that ${s.branch} doesn't. Update or rebase to catch up.`}>↓{s.behind}</span>}
                      </span>
                      <span className="row wt-meta">
                        <span className={st === 'running' ? 'pulse' : `wt-dot ${cls}`} />
                        <span className={cls} style={{ flex: 'none' }}>{label}</span>
                        {sub && <span className="faint">·</span>}
                        <span className="faint ellipsis grow">{sub}</span>
                        {s.ago && <span className="faint" style={{ flex: 'none' }}>{s.ago}</span>}
                      </span>
                    </button>
                    {/* Like a branch's "…", but alone: it takes the whole height. */}
                    <span className="tree-acts">
                      <span className="acts">
                        <button className="act act-main" aria-label={more} title={more} aria-haspopup="menu" onClick={(e) => openMenu(s, e)}>
                          <Icon name="more" size={14} />
                        </button>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {!groups.some((g) => g.items.length) && filter !== 'all' && <Empty>{filter === 'running' ? 'No agent running.' : 'Nothing waiting on you.'}</Empty>}
        </div>
        <div className="master-tools" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          <button className="btn btn-primary" style={{ height: 48, fontSize: 13.5 }} onClick={() => setStarting('acme-web')}>
            <Icon name="sparkle" size={13} />
            New agent session
          </button>
        </div>
      </section>
      <main className="detail wt-pane">
        {cur ? (
          <Detail key={cur.s.key} s={cur.s} menu={menu?.key === cur.s.key ? menu : undefined} onMenuClose={() => setMenu(null)} />
        ) : (
          <EmptyState icon="layers" title="No worktree selected">Pick one from the list, or start a new agent session to give a branch its own folder and agent.</EmptyState>
        )}
      </main>
      {starting && <StartModal initial={starting} onClose={() => setStarting(undefined)} onStarted={setSel} />}
    </>
  );
}

function Detail({ s, menu, onMenuClose }: { s: Session; menu?: { x: number; y: number; alignRight?: boolean }; onMenuClose: () => void }) {
  const { agents, flash, openBranch, setBranch, commit, finish } = useDemo();
  const later = useLater();
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [view, setView] = useState<'agent' | 'shell'>('agent');
  const [merging, setMerging] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const busy = s.status === 'running' || s.status === 'paused';
  const web = s.project === 'acme-web';
  const send = (t: string) => {
    setText('');
    if (s.status === 'idle') agents.start(s, t, s.ai);
    else agents.send(s.key, t);
  };
  // The row's "…" / right-click menu: the terminal fills the pane, so these are the worktree's only action buttons.
  const items = ([
    s.status === 'waiting' && {
      id: 'commit', label: 'Commit & Push changes', icon: 'sparkle', disabled: !(s.add + s.del),
      run: () => {
        const message = `${s.branch.split('/')[0]}: ${s.branch.split('/').pop()!.replace(/-/g, ' ')}`;
        if (web) commit(s.branch);
        flash(`AI wrote: ${message}`);
        later(1800, () => flash(`Pushed ${s.branch}`));
      },
    },
    s.status === 'failed' && { id: 'retry', label: 'Fix and retry with AI', icon: 'sparkle', run: () => agents.send(s.key, RETRY) },
    s.status === 'running' && { id: 'pause', label: 'Pause', icon: 'pause', run: () => agents.pause(s.key) },
    s.status === 'paused' && { id: 'resume', label: 'Resume', icon: 'play', run: () => agents.resume(s.key) },
    busy && { id: 'stop', label: 'Stop agent', icon: 'stop', run: () => agents.stop(s.key) },
    web && { id: 'open', label: 'Open in workspace', icon: 'external', run: () => openBranch(s.branch) },
    { id: 'copyName', label: 'Copy workspace name', icon: 'copy', run: () => navigator.clipboard?.writeText(pathOf(s).split('/').pop()!).then(() => flash('Copied')) },
    'sep',
    { id: 'continue', label: 'Continue on branch', icon: 'swap', run: () => finish(s.key, 'continue', true) },
    {
      id: 'rebase', label: <>Rebase onto <span className="mono">{s.base}</span></>, icon: 'branch', hint: s.behind ? `${s.behind} behind` : undefined, disabled: busy,
      run: () => {
        agents.update(s.key, { behind: 0 });
        if (web) setBranch(s.branch, { behind: 0 });
        flash(`Rebased onto ${s.base}`);
      },
    },
    { id: 'merge', label: 'Merge…', icon: 'merged', run: () => setMerging(true) },
    { id: 'discard', label: 'Cancel and Delete all…', icon: 'trash', danger: true, run: () => setDiscarding(true) },
  ] as (MenuItem | false)[]).filter((x): x is MenuItem => !!x);
  const edited = [...new Set(s.lines.filter((l) => l.text.startsWith('Edit ')).map((l) => l.text.slice(5)))];
  const prompt = <><span className="c-add">{pathOf(s)}</span> <span className="c-acc">({s.branch})</span>{' $ '}</>;

  return (
    <div className="detail-inner" style={{ flex: 1, minHeight: 0 }}>
      <div className="col card term-max" style={{ flex: '1 1 320px', minHeight: 280, gap: 0, overflow: 'hidden', background: 'var(--term)' }}>
        <div className="term-tabs">
          <button type="button" className="term-tab" style={{ borderLeft: 0 }} aria-pressed={view === 'agent'} onClick={() => setView('agent')}>
            <Icon name="sparkle" size={12} />
            Agent
          </button>
          <button type="button" className="term-tab" style={{ borderRight: '1px solid var(--line)' }} aria-pressed={view === 'shell'} onClick={() => setView('shell')}>
            <Icon name="terminal" size={12} />
            Shell
          </button>
          <span className="grow" />
          <span className="hint row hide-narrow" style={{ padding: '0 14px' }}>Keeps running when you switch project</span>
        </div>
        {view === 'shell' ? (
          <div className="term-log hd-shell">
            <div>{prompt}git status --short</div>
            {(s.add + s.del > 0 ? edited : []).map((f) => <div key={f}>&nbsp;M {f}</div>)}
            <div>{prompt}<span className="blink">▍</span></div>
          </div>
        ) : (
          <>
            <AgentLog s={s} empty="No agent session on this checkout." picks={picks} onPicks={setPicks} actions={s.add + s.del > 0 && <FinishCard s={s} />} />
            <AgentInput
              id="wt-ask"
              value={text}
              onChange={setText}
              picks={picks}
              onPicks={setPicks}
              onSend={send}
              onStop={busy ? () => agents.stop(s.key) : undefined}
              picker={<AgentPicker value={s.ai} onChange={(ai) => agents.update(s.key, { ai })} />}
              placeholder={busy ? 'Agent is working…' : s.status !== 'idle' ? `Message the agent on ${s.branch}…` : 'Start a session: describe what the agent should do…'}
            />
          </>
        )}
      </div>
      {merging && <MergeModal s={s} onClose={() => setMerging(false)} />}
      {discarding && <DiscardModal s={s} onClose={() => setDiscarding(false)} />}
      {menu && <Menu {...menu} label={`Actions for ${s.branch}`} items={items} onClose={onMenuClose} />}
    </div>
  );
}

/** MergeModal in src/screens/Workspace.tsx: how to merge, then the worktree goes. */
function MergeModal({ s, onClose }: { s: Session; onClose: () => void }) {
  const { finish } = useDemo();
  const [rebase, setRebase] = useState(false);
  const [squash, setSquash] = useState(false);
  const [del, setDel] = useState(true);
  const [push, setPush] = useState(true);
  return (
    <Modal
      title="Merge"
      sub={<span className="mono">{s.branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary btn-md" onClick={() => { finish(s.key, 'merge', false, `${del ? ' · branch deleted' : ''}${push ? ' · pushed' : ''}`); onClose(); }}>Merge into {s.base}</button>
        </>
      }
    >
      <Seg grid label="How to merge" value={rebase ? 'rebase' : 'merge'} onChange={(v) => setRebase(v === 'rebase')} options={[['merge', 'Merge commit'], ['rebase', 'Rebase & fast-forward']]} />
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        {rebase ? (
          <>Replays <span className="mono">{s.branch}</span> on top of <span className="mono">{s.base}</span>, then fast-forwards {s.base} to it: no merge commit.</>
        ) : (
          <>Creates a merge commit on <span className="mono">{s.base}</span>.</>
        )}{' '}
        Where {s.base} is checked out, it must have no uncommitted changes. Nothing changes when the merge would conflict: rebase onto {s.base} and resolve first.
      </p>
      <div className="col" style={{ gap: 0 }}>
        <label className="check">
          <input type="checkbox" checked={squash} onChange={() => setSquash(!squash)} />
          <span>Squash <span className="mono">{s.branch}</span> into one renamed commit first</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={del} onChange={() => setDel(!del)} />
          <span>Delete <span className="mono">{s.branch}</span> after merging, locally and on origin</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={push} onChange={() => setPush(!push)} />
          <span>Push <span className="mono">{s.base}</span> to origin after merging</span>
        </label>
      </div>
    </Modal>
  );
}

/** StartModal in src/screens/Worktrees.tsx: a branch, an agent, a request; each session gets its own worktree. */
function StartModal({ initial, onClose, onStarted }: { initial: string; onClose: () => void; onStarted: (key: string) => void }) {
  const { agents, branches, head, addBranch, agentOn } = useDemo();
  const [pid, setPid] = useState(initial);
  const [picked, setPicked] = useState('');
  const [pickedMode, setMode] = useState<'existing' | 'new'>();
  const [pickedFrom, setFrom] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('feat');
  const [ticket, setTicket] = useState('');
  const [request, setRequest] = useState('');
  const [ai, setAi] = useState(agents.pick);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState('');
  const chooser = useRef<HTMLInputElement>(null);
  const web = pid === 'acme-web';
  const all = web ? Object.keys(branches) : OTHER[pid];
  const taken = agents.sessions.filter((s) => s.project === pid).map((s) => s.branch);
  // The default branch is reserved, and a branch already in a worktree has its agent.
  const free = all.filter((b) => b !== 'main' && !taken.includes(b));
  const branch = free.includes(picked) ? picked : (free[0] ?? '');
  // Checked out on a trunk or release branch: offer a new branch off it.
  const on = web && branches[head]?.role !== 'branch' ? head : undefined;
  const mode = pickedMode ?? (on || !free.length ? 'new' : 'existing');
  const from = all.includes(pickedFrom) ? pickedFrom : (on ?? 'main');
  const fresh = mode === 'new';
  const ready = !!(fresh ? from : branch) && !!request.trim();
  const go = () => {
    if (!ready) return;
    const req = [request.trim(), files.length ? `Attached files:\n${files.map((f) => `- ${f}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const target = fresh ? withTicket(withPrefix(name.trim() || slug(request), kindOfBranch(name) ?? kind), ticket) : branch;
    if (web) {
      if (fresh) addBranch(target, from);
      const err = agentOn(target, req, fresh ? from : undefined, ai);
      if (err) return setError(err);
    } else agents.start({ project: pid, branch: target, base: fresh ? from : 'main' }, req, ai);
    agents.setPick(ai);
    onStarted(keyOf(pid, target));
    onClose();
  };
  return (
    <Modal
      title="New agent session"
      sub={fresh ? <>Runs in a new worktree on a branch off <strong className="c-acc">{from}</strong></> : branch && <>Runs in its own worktree on <strong className="c-acc">{branch}</strong></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={go}>
            <Icon name="play" size={12} />
            Start
          </button>
        </>
      }
    >
      <Seg grid label="Branch" value={mode} onChange={setMode} options={[['existing', 'Existing branch'], ['new', 'New branch']]} />
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div className="field grow">
          <span>Project</span>
          <Choice className="select menu-select" label="Project" value={pid} options={PROJECTS.map((p) => ({ value: p, label: p }))} onChange={(v) => { setPid(v); setPicked(''); setFrom(''); setMode(undefined); setError(''); }} />
        </div>
        <div className="field grow">
          <span>{fresh ? 'Branches off' : 'Branch'}</span>
          <Choice className="select menu-select" label={fresh ? 'Branches off' : 'Branch'} value={fresh ? from : branch} options={(fresh ? all : free).map((b) => ({ value: b, label: b }))} onChange={fresh ? setFrom : setPicked} />
        </div>
        {/* Linked to the branch: the agent gets the ticket's content from Jira, Trello or Asana. */}
        <div className="field" style={{ flex: '0 1 140px', minWidth: 0 }}>
          <label htmlFor="ag-ticket">Ticket <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input id="ag-ticket" className="input mono" placeholder="WEB-224" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </div>
      </div>
      {fresh && <Seg<Kind> grid cols={6} label="Type" value={kind} onChange={setKind} options={KINDS.map((k) => [k.id, k.label])} />}
      {fresh && (
        <div className="field">
          <label htmlFor="ag-name">Branch name <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          {/* Git names can't hold spaces: each one becomes a dash as you type. */}
          <input id="ag-name" className="input mono" placeholder="Leave empty to name it from the request" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '-'))} />
        </div>
      )}
      {!fresh && !free.length && <p className="hint c-del">main is reserved: create a new branch to start an agent session.</p>}
      {!fresh && web && branch === head && <p className="hint">{branch} is checked out in the main checkout: it is switched off it first, which needs no uncommitted changes there.</p>}
      <div className="field">
        <span>Agent</span>
        <AgentPicker field value={ai} onChange={setAi} />
      </div>
      <div className="field">
        <label htmlFor="ag-req">What should the agent do?</label>
        <textarea id="ag-req" className="textarea" rows={5} value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && go()} autoFocus />
        {files.length > 0 && (
          <div className="ag-files">
            {files.map((f, i) => (
              <span key={f} className="ag-file">
                <Icon name="file" size={15} />
                <span className="ellipsis">{f}</span>
                <button type="button" className="ag-file-x" aria-label={`Remove ${f}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="close" size={10} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => chooser.current?.click()}>
            <Icon name="attach" size={12} />
            Attach files
          </button>
          <span className="hint">⌘↵ to start</span>
        </div>
        <input ref={chooser} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...[...(e.target.files ?? [])].map((f) => f.name)]); e.target.value = ''; }} />
      </div>
      {error && <div className="err-box">{error}</div>}
    </Modal>
  );
}
