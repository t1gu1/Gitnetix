import { useState, type CSSProperties } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { withPrefix, withTicket } from '../../../../src/lib/kinds';
import { Avatar, Busy, Choice, Empty, EmptyState, Markdown, Menu, PageHead, Seg, useDemo, useLater, useMenu } from './ui';

/** src/screens/Tickets.tsx on a made-up Jira project, a Trello board and an Asana project: filter, triage, move, plan, start a branch. */

type Status = 'todo' | 'progress' | 'review' | 'ready' | 'done';
type Ticket = {
  key: string;
  source: 'jira' | 'trello' | 'asana';
  place: string;
  whereLabel: string;
  title: string;
  kind: string;
  status: Status;
  statusLabel: string;
  assignee: string;
  mine: boolean;
  /** In Jira's open sprint. */
  sprint?: boolean;
  release: string;
  branch?: string;
  description: string;
  criteria: { text: string; done: boolean }[];
  comments: number;
  priority?: string;
  timeRemaining?: string;
  timeEstimate?: string;
  parentKey?: string;
  parentTitle?: string;
  fixVersions?: string[];
};
type Suggestion = { release: string; kind: 'feat' | 'fix'; reason: string };

const STATUS: Record<Status, [string, string]> = {
  todo: ['To do', 'muted'],
  progress: ['In progress', 'c-mod'],
  review: ['In review', 'c-acc'],
  ready: ['Ready to merge', 'c-add'],
  done: ['Done', 'c-add'],
};
const SRC = { jira: 'Jira', trello: 'Trello', asana: 'Asana' };
/** Where a ticket can move: Jira transitions, Trello lists, Asana sections. */
const MOVES: Record<Ticket['source'], [Status, string][]> = {
  jira: [['todo', 'To Do'], ['progress', 'In Progress'], ['review', 'In Review'], ['ready', 'Ready to merge'], ['done', 'Done']],
  trello: [['todo', 'To do'], ['progress', 'Doing'], ['done', 'Done']],
  asana: [['todo', 'Next up'], ['progress', 'In progress'], ['done', 'Done']],
};
const VERSIONS = [['0.5.2', true], ['0.6.0', false], ['0.7.0', false]] as const;
const ME = 'Grace Hopper';
const ADD = '\0add';

const jira = (t: Omit<Ticket, 'source' | 'place' | 'whereLabel' | 'statusLabel'> & { statusLabel?: string }): Ticket => ({
  source: 'jira', place: 'WEB', whereLabel: 'Sprint 14', statusLabel: MOVES.jira.find(([s]) => s === t.status)![1], ...t,
});
const TICKETS: Ticket[] = [
  jira({
    key: 'WEB-212', kind: 'Story', title: 'Animate the path to the checked-out branch', status: 'progress', assignee: ME, mine: true, sprint: true, release: '0.6.0', branch: 'feat/branch-tree',
    priority: 'High', timeRemaining: '3h', timeEstimate: '1d', parentKey: 'WEB-180', parentTitle: 'Branch tree polish', fixVersions: ['0.6.0'], comments: 3,
    description: 'When you check a branch out, a soft light should run along the orange path, from `main` down to the branch, so you see at once where you are.\n\nIt restarts on every switch, and stays still when the system asks for **reduced motion**.',
    criteria: [{ text: 'The pulse starts at the trunk and ends on the checked-out row', done: true }, { text: 'It restarts when you switch branch', done: true }, { text: 'Reduced motion turns it off', done: false }],
  }),
  jira({
    key: 'WEB-218', kind: 'Bug', title: 'Branches deleted on origin stay in the tree', status: 'review', assignee: 'Jules Laurent', mine: false, sprint: true, release: '0.6.0', branch: 'fix/stale-remote',
    priority: 'Highest', timeRemaining: '2h', timeEstimate: '4h', parentKey: 'WEB-170', parentTitle: 'Fetch and sync', fixVersions: ['0.6.0'], comments: 5,
    description: 'After someone deletes a branch on GitHub, it stays in the tree until the app restarts.\n\n1. Delete a branch on origin\n2. Wait for the background fetch\n3. The branch is still listed',
    criteria: [{ text: 'A deleted branch leaves the tree on the next fetch', done: true }, { text: 'Tags are left alone', done: false }],
  }),
  jira({
    key: 'WEB-221', kind: 'Story', title: 'Stream agent steps in the workspace', status: 'todo', assignee: 'Riya Kapoor', mine: false, sprint: true, release: '', branch: 'feat/agent-pane',
    priority: 'Medium', timeEstimate: '3d', parentKey: 'WEB-195', parentTitle: 'Agents', fixVersions: [], comments: 1,
    description: 'Show the agent\'s steps while it works, not all at once when it is done. The newest group of steps stays open.',
    criteria: [{ text: 'Steps appear as they run', done: false }, { text: 'Older groups fold', done: false }],
  }),
  jira({
    key: 'WEB-224', kind: 'Story', title: 'Filter branches by author', status: 'todo', assignee: ME, mine: true, sprint: true, release: '',
    priority: 'Medium', timeEstimate: '1d', parentKey: 'WEB-180', parentTitle: 'Branch tree polish', fixVersions: [], comments: 0,
    description: "Let me narrow the tree to my branches, or to a teammate's, from the filter's menu.",
    criteria: [{ text: 'An author list in the filter menu', done: false }, { text: 'Branches of other authors fold away, their parents stay', done: false }],
  }),
  jira({
    key: 'WEB-227', kind: 'Bug', title: 'Commit box loses its draft when switching branch', status: 'todo', assignee: ME, mine: true, sprint: true, release: '',
    priority: 'High', timeEstimate: '2h', fixVersions: [], comments: 2,
    description: 'Type a commit message, switch branch and come back: the message is gone. It should stay with its branch.',
    criteria: [],
  }),
  jira({
    key: 'WEB-205', kind: 'Task', title: 'Date the changelog when a release ships', status: 'done', assignee: ME, mine: true, sprint: true, release: '0.6.0',
    priority: 'Low', timeRemaining: '0m', timeEstimate: '3h', parentKey: 'WEB-150', parentTitle: 'One-click release', fixVersions: ['0.6.0'], comments: 1,
    description: 'Shipping moves the `Unreleased` section under the new version, with the date of the day.',
    criteria: [{ text: 'Unreleased becomes [0.6.0] with the date', done: true }, { text: 'An empty Unreleased section stays', done: true }],
  }),
  {
    key: 'WS-31', source: 'trello', place: 'Website', whereLabel: 'Website · Doing', kind: 'Card', title: 'Landing page: a demo people can click', status: 'progress', statusLabel: 'Doing', assignee: ME, mine: true, release: '', comments: 2,
    description: 'Under the hero: the app itself, with every page clickable and made-up data to play with.',
    criteria: [{ text: 'Every page opens', done: true }, { text: 'Agents run in their worktrees', done: true }, { text: 'Works on a phone', done: false }],
  },
  {
    key: 'Q4-8', source: 'asana', place: 'Q4 roadmap', whereLabel: 'Q4 roadmap · Next up', kind: 'Task', title: 'Pairing page for the phone app', status: 'todo', statusLabel: 'Next up', assignee: 'Ana Moreau', mine: false, release: '', comments: 0,
    description: 'A page that explains the QR pairing, with a short video.',
    criteria: [],
  },
];
const SUGGEST: Record<string, Suggestion> = {
  'WEB-224': { release: '0.6.0', kind: 'feat', reason: 'Small and about the branch tree, like the rest of v0.6.0; its parent WEB-180 ships there.' },
  'WEB-227': { release: '0.6.0', kind: 'fix', reason: 'A bug people hit every day in the commit box: worth fixing before v0.6.0 ships.' },
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-');

export default function Tickets() {
  const { flash, addBranch } = useDemo();
  const later = useLater();
  const [all, setAll] = useState(TICKETS);
  const [mine, setMine] = useState(true);
  const [sprint, setSprint] = useState(true);
  const [place, setPlace] = useState('all');
  const [group, setGroup] = useState<'release' | 'status'>('status');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string>();
  // On the phone: the list, or the picked ticket in its place.
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [busy, setBusy] = useState<'sync' | 'triage'>();
  const [synced, setSynced] = useState('2 min ago');
  const term = search.trim().toLowerCase();
  // Active sprint is Jira's: it hides Trello and Asana.
  const base = all.filter((t) => (!mine || t.mine) && (!sprint || t.sprint) && (!term || `${t.key} ${t.title}`.toLowerCase().includes(term)));
  const places = [...new Set(all.map((x) => x.place))].sort();
  const visible = base.filter((t) => place === 'all' || t.place === place);
  const groups =
    group === 'release'
      ? [{ id: '0.6.0', label: 'Next · v0.6.0' }, { id: '', label: 'Unplanned' }]
      : (Object.keys(STATUS) as Status[]).map((s) => ({ id: s, label: STATUS[s][0] }));
  const grouped = groups.map((g) => ({ ...g, items: visible.filter((t) => (group === 'release' ? t.release === g.id : t.status === g.id)) })).filter((g) => g.items.length);
  const t = all.find((x) => x.key === sel) ?? visible[0];
  const unplanned = visible.filter((x) => !x.release && x.status !== 'done');
  const set = (key: string, p: Partial<Ticket>) => setAll((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));

  return (
    <>
      <PageHead title="Tickets" sub={['acme-web', place === 'all' ? '' : place].filter(Boolean).join(' · ')} onBack={pane === 'detail' ? () => setPane('list') : undefined} />
      <section className="master" style={{ '--master-w': '360px' } as CSSProperties} data-pane data-active={pane === 'list'} aria-label="Ticket list">
        <div className="master-tools">
          <label htmlFor="tk-q" className="sr-only">Search tickets</label>
          <div className="row" style={{ gap: 6, margin: 0 }}>
            <input id="tk-q" className="input grow" placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="btn btn-icon" aria-label="Sync now" title={`Sync now · synced ${synced}`} onClick={() => { setBusy('sync'); later(900, () => { setBusy(undefined); setSynced('just now'); }); }}>
              <Busy on={busy === 'sync'}><Icon name="refresh" size={13} /></Busy>
            </button>
          </div>
          <Choice
            className="select menu-select"
            style={{ height: 30, width: '100%' }}
            label="Tracker"
            value={place}
            options={[
              { value: 'all', label: `All trackers · ${base.length}` },
              ...places.map((p) => ({ value: p, label: `${p} · ${base.filter((x) => x.place === p).length}` })),
              { value: ADD, label: 'Connect another tracker…' },
            ]}
            onChange={(v) => (v === ADD ? flash('Jira, Trello and Asana connect in Settings → Tools') : setPlace(v))}
          />
          <div className="row wrap">
            <Seg label="Group by" value={group} onChange={setGroup} options={[['release', 'By release'], ['status', 'By status']]} />
            <label className="check" style={{ minHeight: 28 }}>
              <input type="checkbox" checked={mine} onChange={() => setMine(!mine)} />
              <span>Assigned to me</span>
            </label>
            <label className="check" style={{ minHeight: 28 }} title="Jira tickets in an open sprint; hides Trello and Asana">
              <input type="checkbox" checked={sprint} onChange={() => setSprint(!sprint)} />
              <span>Active sprint</span>
            </label>
          </div>
        </div>
        <div className="scroll" style={{ flex: '1 1 auto', paddingBottom: 12 }}>
          {grouped.map((g) => (
            <div key={g.id || 'none'}>
              <div className="group-head" style={{ fontSize: 13, fontWeight: 700 }}>
                <span className={group === 'status' ? STATUS[g.id as Status][1] : undefined}>{g.label}</span>
                <span>{g.items.length}</span>
              </div>
              <div className="col" style={{ gap: 2 }}>
                {g.items.map((x) => (
                  <button key={x.key} className="item-btn" style={{ gap: 1, padding: '7px 12px' }} aria-pressed={x.key === t?.key} onClick={() => { setSel(x.key); setPane('detail'); }}>
                    <span className="row" style={{ gap: 8, margin: '0 0 2px', fontSize: 11.5 }}>
                      <Avatar name={x.assignee} />
                      <span className="mono faint">{x.key}</span>
                      <span className={STATUS[x.status][1]} style={{ fontSize: 13 }}>{x.statusLabel}</span>
                      <span className="faint ellipsis grow">{x.kind}</span>
                      {suggestions[x.key] && !x.release && <Icon name="sparkle" size={11} className="c-acc" />}
                      <span className="faint">{SRC[x.source]}</span>
                    </span>
                    <span className="ellipsis" style={{ fontWeight: 500 }}>{x.title}</span>
                    <span className="mono faint ellipsis" style={{ fontSize: 11.5, marginTop: 8 }}>{x.branch ?? 'No branch'}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {grouped.length === 0 && <Empty>No tickets match these filters.</Empty>}
        </div>
        {unplanned.length > 0 && (
          <div className="master-tools" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
            <button
              className="btn btn-primary"
              style={{ height: 48, fontSize: 13.5 }}
              disabled={busy === 'triage'}
              onClick={() => {
                setBusy('triage');
                later(1500, () => {
                  setBusy(undefined);
                  setSuggestions(Object.fromEntries(unplanned.map((x) => [x.key, SUGGEST[x.key] ?? { release: '0.6.0', kind: /bug|fix/i.test(x.kind) ? 'fix' : 'feat', reason: 'Fits the scope of v0.6.0, the next release.' }])));
                  flash(`AI suggested a release for ${plural(unplanned.length, 'ticket')}`);
                });
              }}
            >
              <Busy on={busy === 'triage'}><Icon name="sparkle" size={13} /></Busy>
              Triage {unplanned.length} unplanned with AI
            </button>
          </div>
        )}
      </section>
      <main className="detail" data-pane data-active={pane === 'detail'}>
        {t ? (
          <TicketDetail
            key={t.key}
            t={t}
            set={(p) => set(t.key, p)}
            suggestion={!t.release ? suggestions[t.key] : undefined}
            onDismiss={() => setSuggestions(({ [t.key]: _, ...rest }) => rest)}
            onStart={(kind) => {
              const name = withTicket(withPrefix(slug(t.title), kind), t.key);
              addBranch(name, 'release/0.6.0');
              set(t.key, { branch: name, release: '0.6.0', status: 'progress', statusLabel: MOVES[t.source].find(([s]) => s === 'progress')![1] });
              flash(`Created ${name} off release/0.6.0`);
            }}
          />
        ) : (
          <EmptyState icon="ticket" title="No ticket selected">Pick one from the list to see its details and start a branch from it.</EmptyState>
        )}
      </main>
    </>
  );
}

function TicketDetail({ t, set, suggestion, onDismiss, onStart }: { t: Ticket; set: (p: Partial<Ticket>) => void; suggestion?: Suggestion; onDismiss: () => void; onStart: (kind: 'feat' | 'fix') => void }) {
  const { flash, go, openBranch, branches } = useDemo();
  const later = useLater();
  const [moving, setMoving] = useState<string>();
  const kind = /bug|fix/i.test(t.kind) ? 'fix' : 'feat';
  const done = t.criteria.filter((c) => c.done).length;
  return (
    <div className="detail-inner">
      <div className="col" style={{ gap: 8 }}>
        <div className="row wrap muted" style={{ fontSize: 12.5 }}>
          <span className="row" style={{ gap: 6, color: 'var(--fg)' }} title="Assignee"><Avatar name={t.assignee} />{t.assignee}</span>
          <span className="faint">·</span>
          <span className="mono">{t.key}</span>
          <span className="faint">·</span>
          <span>{t.kind}</span>
          <span className="faint">·</span>
          <span>{t.whereLabel}</span>
          <span className="grow" />
          <button className="btn btn-sm" onClick={() => flash(`Opens ${t.key} in ${SRC[t.source]}`)}>
            <Icon name="external" size={11} />
            Open in {SRC[t.source]}
          </button>
        </div>
        <h1>{t.title}</h1>
      </div>
      <div className="kv tk-kv">
        {t.source === 'jira' && (
          <>
            <div>
              <span>Parent</span>
              {t.parentKey ? (
                <a className="ellipsis" href="#" title={`Open ${t.parentKey} in Jira`} onClick={(e) => { e.preventDefault(); flash(`Opens ${t.parentKey} in Jira`); }}>
                  <span className="mono">{t.parentKey}</span> {t.parentTitle}
                </a>
              ) : (
                <span className="faint">None</span>
              )}
            </div>
            <div><span>Priority</span><span>{t.priority}</span></div>
            <div>
              <span>Time left</span>
              <span className={t.timeRemaining || t.timeEstimate ? '' : 'faint'}>{t.timeRemaining && t.timeEstimate ? `${t.timeRemaining} of ${t.timeEstimate}` : t.timeEstimate ? `? of ${t.timeEstimate}` : 'Not estimated'}</span>
            </div>
            <div>
              <label htmlFor="tk-fix">Fix versions</label>
              <FixVersions t={t} onSave={(v) => { set({ fixVersions: v }); flash('Fix versions changed'); }} />
            </div>
          </>
        )}
        <div>
          <label htmlFor="tk-rel">Release</label>
          <Choice id="tk-rel" className="select menu-select" style={{ height: 30, width: '100%' }} label="Release" value={t.release} options={[{ value: '0.6.0', label: 'v0.6.0 · Next' }, { value: '', label: 'Unplanned' }]} onChange={(v) => set({ release: v })} />
        </div>
        <div>
          <label htmlFor="tk-status">Status</label>
          <Choice
            id="tk-status"
            className="select menu-select"
            style={{ height: 30, width: '100%' }}
            label="Status"
            value=""
            options={[{ value: '', label: moving ? `Moving to ${moving}…` : t.statusLabel }, ...MOVES[t.source].filter(([, n]) => n !== t.statusLabel).map(([s, n]) => ({ value: s, label: n }))]}
            onChange={(to) => {
              const name = MOVES[t.source].find(([s]) => s === to)?.[1];
              if (!name) return;
              setMoving(name);
              later(700, () => {
                setMoving(undefined);
                set({ status: to as Status, statusLabel: name });
                flash('Status changed');
              });
            }}
          />
        </div>
      </div>
      {suggestion && (
        <div className="col note-box" style={{ gap: 8, borderColor: 'var(--accent)' }}>
          <span className="row" style={{ gap: 6, fontWeight: 500 }}>
            <Icon name="sparkle" size={12} className="c-acc" />
            AI suggests: {suggestion.kind === 'fix' ? 'a fix' : 'a feature'} in v{suggestion.release}
          </span>
          <span className="muted">{suggestion.reason}</span>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={onDismiss}>Dismiss</button>
            <button className="btn btn-sm btn-primary" onClick={() => set({ release: suggestion.release })}>Accept</button>
          </div>
        </div>
      )}
      <section className="section">
        <h2>Work</h2>
        {t.branch ? (
          <div className="row wrap card" style={{ padding: 14 }}>
            <Icon name="branch" />
            <span className="mono grow">{t.branch}</span>
            <button className="btn btn-sm" onClick={() => go('prs')}>Pull requests</button>
            <button className="btn btn-sm" disabled={!branches[t.branch]} title={branches[t.branch] ? undefined : 'Not in this project'} onClick={() => openBranch(t.branch!)}>Go to branch</button>
          </div>
        ) : (
          <div className="row wrap card" style={{ padding: 14 }}>
            <span className="col grow" style={{ gap: 2 }}>
              <span>No branch yet</span>
              <span className="hint">{t.release ? 'Branches off release/0.6.0. AI names the branch from this ticket.' : 'Pick a release first, or choose one when you start.'}</span>
            </span>
            <button className="btn btn-primary" onClick={() => onStart(kind)}>
              <Icon name="plus" size={12} />
              Start {kind === 'fix' ? 'fix' : 'feature'}
            </button>
          </div>
        )}
      </section>
      <section className="section">
        <h2>Description</h2>
        <Markdown text={t.description} />
      </section>
      {t.criteria.length > 0 && (
        <section className="section">
          <h2>Acceptance criteria <span className="faint" style={{ fontWeight: 400 }}>{done} of {t.criteria.length}</span></h2>
          <ul className="list">
            {t.criteria.map((c, i) => (
              <li key={i} className="list-row" style={{ minHeight: 40 }}>
                <span className={c.done ? 'c-add' : 'faint'} aria-hidden="true"><Icon name={c.done ? 'check' : 'stop'} size={12} /></span>
                <span className={c.done ? 'muted' : ''}>{c.text}</span>
                <span className="sr-only">{c.done ? '(done)' : '(not done)'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="hint">{t.comments === 0 ? `No comments in ${SRC[t.source]}.` : `${plural(t.comments, 'comment')} in ${SRC[t.source]}.`}</div>
    </div>
  );
}

/** Jira fix versions, toggled in a menu that stays open and saved when it closes. */
function FixVersions({ t, onSave }: { t: Ticket; onSave: (v: string[]) => void }) {
  const m = useMenu();
  const [draft, setDraft] = useState<string[]>([]);
  const fix = t.fixVersions ?? [];
  const close = () => {
    m.close();
    if (draft.length !== fix.length || draft.some((n) => !fix.includes(n))) onSave(VERSIONS.map(([v]) => v).filter((v) => draft.includes(v)));
  };
  return (
    <>
      <button id="tk-fix" className="select menu-select" style={{ height: 30, width: '100%' }} aria-haspopup="menu" aria-expanded={!!m.at} aria-label="Fix versions" onClick={(e) => { if (m.at) return close(); setDraft(fix); m.toggle(e); }}>
        <span className="ellipsis">{(m.at ? draft : fix).join(', ') || 'None'}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {m.at && (
        <Menu
          {...m.at}
          label="Fix versions"
          onClose={close}
          items={VERSIONS.map(([v, released]) => ({ id: v, label: released ? `${v} (released)` : v, icon: null, keep: true, hint: draft.includes(v) && <Icon name="check" size={13} />, run: () => setDraft((d) => (d.includes(v) ? d.filter((n) => n !== v) : [...d, v])) }))}
        />
      )}
    </>
  );
}
