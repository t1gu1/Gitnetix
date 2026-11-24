import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { withPrefix, withTicket } from '../../../../src/lib/kinds';
import { Avatar, Busy, Choice, EmptyState, Markdown, Menu, PageHead, Seg, useDemo, useLater, useMenu } from './ui';

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
  /** What tickets.activity tells: how long it has had its status, when it was opened and by whom. */
  since: string;
  opened: string;
  by: string;
};
type Suggestion = { release: string; kind: 'feat' | 'fix'; reason: string };

/** Each status's name, in the list's order: the work under way first, then what waits, then what's done. */
const STATUS: Record<Status, string> = {
  progress: 'In progress',
  review: 'In review',
  ready: 'Ready to merge',
  todo: 'To do',
  done: 'Done',
};
const RANK: Record<string, number> = { Highest: 0, High: 1, Medium: 2, Low: 3 };
/** A ticket's status as a station ring: empty to do, filling up through review, green once ready or done. */
const Ring = ({ t }: { t: Ticket }) => <span className="tk-ring" data-status={t.status} title={t.statusLabel} aria-hidden="true" />;
/** A ticket's priority: the alert icon when urgent, else bars filled by how urgent it is; `bare` leaves its name to the tooltip. */
function Prio({ t, bare }: { t: Ticket; bare?: boolean }) {
  if (!t.priority) return null;
  const rank = RANK[t.priority] ?? 4;
  return (
    <span className={`tk-prio ${['c-del', 'tk-prio-high', 'tk-prio-medium'][rank] ?? 'faint'}`} title={`Priority · ${t.priority}`}>
      {rank === 0 ? <Icon name="alert" size={11} /> : <span className="tk-bars" aria-hidden="true">{[1, 2, 3].map((b) => <i key={b} data-on={b <= 4 - rank || undefined} />)}</span>}
      {bare ? <span className="sr-only">{t.priority}</span> : t.priority}
    </span>
  );
}
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
    key: 'WEB-212', since: 'for 2 days', opened: '6 days ago', by: 'Ana Moreau', kind: 'Story', title: 'Animate the path to the checked-out branch', status: 'progress', assignee: ME, mine: true, sprint: true, release: '0.6.0', branch: 'feat/branch-tree',
    priority: 'High', timeRemaining: '3h', timeEstimate: '1d', parentKey: 'WEB-180', parentTitle: 'Branch tree polish', fixVersions: ['0.6.0'], comments: 3,
    description: 'When you check a branch out, a soft light should run along the path, from `main` down to the branch, so you see at once where you are.\n\nIt restarts on every switch, and stays still when the system asks for **reduced motion**.',
    criteria: [{ text: 'The pulse starts at the trunk and ends on the checked-out row', done: true }, { text: 'It restarts when you switch branch', done: true }, { text: 'Reduced motion turns it off', done: false }],
  }),
  jira({
    key: 'WEB-218', since: 'for 5 h', opened: '4 days ago', by: 'Riya Kapoor', kind: 'Bug', title: 'Branches deleted on origin stay in the tree', status: 'review', assignee: 'Jules Laurent', mine: false, sprint: true, release: '0.6.0', branch: 'fix/stale-remote',
    priority: 'Highest', timeRemaining: '2h', timeEstimate: '4h', parentKey: 'WEB-170', parentTitle: 'Fetch and sync', fixVersions: ['0.6.0'], comments: 5,
    description: 'After someone deletes a branch on GitHub, it stays in the tree until the app restarts.\n\n1. Delete a branch on origin\n2. Wait for the background fetch\n3. The branch is still listed',
    criteria: [{ text: 'A deleted branch leaves the tree on the next fetch', done: true }, { text: 'Tags are left alone', done: false }],
  }),
  jira({
    key: 'WEB-221', since: 'for 3 days', opened: '3 days ago', by: 'Ana Moreau', kind: 'Story', title: 'Stream agent steps in the workspace', status: 'todo', assignee: 'Riya Kapoor', mine: false, sprint: true, release: '', branch: 'feat/agent-pane',
    priority: 'Medium', timeEstimate: '3d', parentKey: 'WEB-195', parentTitle: 'Agents', fixVersions: [], comments: 1,
    description: 'Show the agent\'s steps while it works, not all at once when it is done. The newest group of steps stays open.',
    criteria: [{ text: 'Steps appear as they run', done: false }, { text: 'Older groups fold', done: false }],
  }),
  jira({
    key: 'WEB-224', since: 'for 1 day', opened: 'yesterday', by: 'Grace Hopper', kind: 'Story', title: 'Filter branches by author', status: 'progress', assignee: ME, mine: true, sprint: true, release: '', branch: 'feat/author-filter',
    priority: 'Medium', timeEstimate: '1d', parentKey: 'WEB-180', parentTitle: 'Branch tree polish', fixVersions: [], comments: 0,
    description: "Let me narrow the tree to my branches, or to a teammate's, from the filter's menu.",
    criteria: [{ text: 'An author list in the filter menu', done: false }, { text: 'Branches of other authors fold away, their parents stay', done: false }],
  }),
  jira({
    key: 'WEB-227', since: 'for 2 days', opened: '2 days ago', by: 'Jules Laurent', kind: 'Bug', title: 'Commit box loses its draft when switching branch', status: 'todo', assignee: ME, mine: true, sprint: true, release: '',
    priority: 'High', timeEstimate: '2h', fixVersions: [], comments: 2,
    description: 'Type a commit message, switch branch and come back: the message is gone. It should stay with its branch.',
    criteria: [],
  }),
  jira({
    key: 'WEB-205', since: 'for 1 day', opened: '9 days ago', by: 'Ana Moreau', kind: 'Task', title: 'Date the changelog when a release ships', status: 'done', assignee: ME, mine: true, sprint: true, release: '0.6.0',
    priority: 'Low', timeRemaining: '0m', timeEstimate: '3h', parentKey: 'WEB-150', parentTitle: 'Publish from any branch', fixVersions: ['0.6.0'], comments: 1,
    description: 'Shipping moves the `Unreleased` section under the new version, with the date of the day.',
    criteria: [{ text: 'Unreleased becomes [0.6.0] with the date', done: true }, { text: 'An empty Unreleased section stays', done: true }],
  }),
  {
    key: 'WS-31', since: 'for 4 days', opened: '8 days ago', by: 'Grace Hopper', source: 'trello', place: 'Website', whereLabel: 'Website · Doing', kind: 'Card', title: 'Landing page: a demo people can click', status: 'progress', statusLabel: 'Doing', assignee: ME, mine: true, release: '', comments: 2,
    description: 'Under the hero: the app itself, with every page clickable and made-up data to play with.',
    criteria: [{ text: 'Every page opens', done: true }, { text: 'Agents run in their worktrees', done: true }, { text: 'Works on a phone', done: false }],
  },
  {
    key: 'Q4-8', since: 'for 6 days', opened: '6 days ago', by: 'Ana Moreau', source: 'asana', place: 'Q4 roadmap', whereLabel: 'Q4 roadmap · Next up', kind: 'Task', title: 'Pairing page for the phone app', status: 'todo', statusLabel: 'Next up', assignee: 'Ana Moreau', mine: false, release: '', comments: 0,
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
  const { flash, addBranch, tkPick } = useDemo();
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
  // A ticket picked on the branch map: open it, whoever's it is.
  useEffect(() => {
    if (!tkPick) return;
    setMine(false);
    setPlace('all');
    setSearch('');
    setSel(tkPick.key);
    setPane('detail');
  }, [tkPick]);
  const term = search.trim().toLowerCase();
  // Active sprint is Jira's: it hides Trello and Asana. The trackers menu counts before the search.
  const counted = all.filter((t) => (!mine || t.mine) && (!sprint || t.sprint));
  const base = counted.filter((t) => !term || `${t.key} ${t.title}`.toLowerCase().includes(term));
  const places = [...new Set(all.map((x) => x.place))].sort();
  const visible = base.filter((t) => place === 'all' || t.place === place);
  const groups =
    group === 'release'
      ? [{ id: '0.6.0', label: 'Next · v0.6.0' }, { id: '', label: 'Unplanned' }]
      : (Object.keys(STATUS) as Status[]).map((s) => ({ id: s, label: STATUS[s] }));
  const grouped = groups.map((g) => ({ ...g, items: visible.filter((t) => (group === 'release' ? t.release === g.id : t.status === g.id)) })).filter((g) => g.items.length);
  const t = all.find((x) => x.key === sel) ?? visible[0];
  const unplanned = visible.filter((x) => !x.release && x.status !== 'done');
  // Titles start at the same place on every row, as in the app.
  const keyW = Math.min(14, Math.max(4, ...visible.map((x) => x.key.length))) + 1;
  const set = (key: string, p: Partial<Ticket>) => setAll((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const triage = () => {
    setBusy('triage');
    later(1500, () => {
      setBusy(undefined);
      setSuggestions(Object.fromEntries(unplanned.map((x) => [x.key, SUGGEST[x.key] ?? { release: '0.6.0', kind: /bug|fix/i.test(x.kind) ? 'fix' : 'feat', reason: 'Fits the scope of v0.6.0, the next release.' }])));
      flash(`AI suggested a release for ${plural(unplanned.length, 'ticket')}`);
    });
  };

  return (
    <>
      <PageHead title="Tickets" sub={['acme-web', place === 'all' ? '' : place].filter(Boolean).join(' · ')} onBack={pane === 'detail' ? () => setPane('list') : undefined} />
      <div className="map-bar tk-bar" data-detail={pane === 'detail' || undefined}>
        <h2 className="map-title hide-narrow">Tickets</h2>
        <Choice
          className="select menu-select tk-trackers"
          label="Tracker"
          value={place}
          options={[
            { value: 'all', label: `All trackers · ${counted.length}` },
            ...places.map((p) => ({ value: p, label: `${p} · ${counted.filter((x) => x.place === p).length}` })),
            { value: ADD, label: 'Connect another tracker…' },
          ]}
          onChange={(v) => (v === ADD ? flash('Jira, Trello and Asana connect in the menu, under Integrations') : setPlace(v))}
        />
        <Seg<'mine' | 'all'> label="Whose tickets" value={mine ? 'mine' : 'all'} onChange={(v) => setMine(v === 'mine')} options={[['mine', 'Mine'], ['all', 'Everyone']]} />
        <button className="map-toggle" aria-pressed={sprint} title="Jira tickets in an open sprint; hides Trello and Asana" onClick={() => setSprint(!sprint)}>
          <span className="map-box" aria-hidden><Icon name="check" size={10} stroke={2.4} /></span>
          <span>Active sprint</span>
        </button>
        <Seg label="Group by" value={group} onChange={setGroup} options={[['status', 'By status'], ['release', 'By release']]} />
        <span className="grow" />
        <div className="pr-search">
          <Icon name="search" size={13} className="faint" />
          <label htmlFor="tk-q" className="sr-only">Search tickets</label>
          <input id="tk-q" className="input" placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-sm btn-icon" aria-label="Sync now" title={`Sync now · synced ${synced}`} onClick={() => { setBusy('sync'); later(900, () => { setBusy(undefined); setSynced('just now'); }); }}>
          <Busy on={busy === 'sync'}><Icon name="refresh" size={14} /></Busy>
        </button>
        {unplanned.length > 0 && (
          <button className="btn btn-sm tk-triage" aria-label={`Triage ${unplanned.length} unplanned with AI`} disabled={busy === 'triage'} onClick={triage}>
            <Busy on={busy === 'triage'}><Icon name="sparkle" size={12} /></Busy>
            <span>
              Triage {unplanned.length}
              <span className="hide-narrow"> unplanned</span>
            </span>
          </button>
        )}
      </div>
      <div className="body split">
        <section className="master" style={{ '--master-w': '360px', '--key-w': `${keyW}ch` } as CSSProperties} data-pane data-active={pane === 'list'} aria-label="Ticket list">
          <div className="scroll tk-list">
            {grouped.map((g) => (
              <div key={g.id || 'none'}>
                <div className="group-head">
                  <span>{g.label}</span>
                  <span className="mono">{g.items.length}</span>
                </div>
                <div className="col" style={{ gap: 1 }}>
                  {g.items.map((x) => (
                    <button key={x.key} className="item-btn tk-row" aria-pressed={x.key === t?.key} onClick={() => { setSel(x.key); setPane('detail'); }}>
                      <Ring t={x} />
                      <span className="mono tk-row-key">{x.key}</span>
                      <span className="tk-row-title">{x.title}</span>
                      <span className="sr-only">{x.statusLabel}</span>
                      {suggestions[x.key] && !x.release && <Icon name="sparkle" size={11} className="c-acc" />}
                      <Prio t={x} bare />
                      {!mine && (
                        <span className="tk-row-who">
                          <Avatar name={x.assignee} size={18} />
                          <span className="tk-row-name" aria-hidden="true">{x.assignee.split(/\s+/)[0]}</span>
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {grouped.length === 0 && (
              <div className="tk-none">
                <strong>{term ? `No tickets match “${search.trim()}”.` : 'No tickets match these filters.'}</strong>
                <p className="hint">
                  {term ? 'Search reads keys and titles' : 'Nothing left'}
                  {mine ? ' of your tickets' : ''}
                  {sprint ? ' in the active sprint' : ''}
                  {place !== 'all' ? ` in ${place}` : ''}.
                </p>
                <div className="row wrap">
                  {term && <button className="btn btn-sm" onClick={() => setSearch('')}>Clear search</button>}
                  {mine && <button className="btn btn-sm" onClick={() => setMine(false)}>{term ? "Search everyone's tickets" : "Show everyone's tickets"}</button>}
                  {place !== 'all' && <button className="btn btn-sm" onClick={() => setPlace('all')}>Show all trackers</button>}
                </div>
              </div>
            )}
          </div>
        </section>
        <main className="detail tk-detail" data-pane data-active={pane === 'detail'}>
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
                set(t.key, { branch: name, release: '0.6.0', status: 'progress', statusLabel: MOVES[t.source].find(([s]) => s === 'progress')![1], since: 'for 1 min' });
                flash(`Created ${name} off release/0.6.0`);
              }}
            />
          ) : visible.length ? (
            <EmptyState icon="ticket" title="No ticket selected">Pick one from the list to see its details and start a branch from it.</EmptyState>
          ) : null}
        </main>
      </div>
    </>
  );
}

/** The ticket as a page, with its way to a release beside it: src/screens/Tickets.tsx TicketDetail and WorkLine. */
function TicketDetail({ t, set, suggestion, onDismiss, onStart }: { t: Ticket; set: (p: Partial<Ticket>) => void; suggestion?: Suggestion; onDismiss: () => void; onStart: (kind: 'feat' | 'fix') => void }) {
  const { flash, go, openBranch, branches } = useDemo();
  const later = useLater();
  const [moving, setMoving] = useState<string>();
  const kind = /bug|fix/i.test(t.kind) ? 'fix' : 'feat';
  const done = t.criteria.filter((c) => c.done).length;
  const b = t.branch ? branches[t.branch] : undefined;
  // Ticket, branch, pull request, release, shipped: white up to where it stands, the next outlined, the ones after dashed.
  const reached = [true, !!t.branch, false, false, false];
  const next = reached.indexOf(false);
  const stop = (i: number) => (i < next ? { 'data-on': true } : i === next ? { 'data-next': true } : { 'data-later': true });
  const line = (i: number) => (i + 1 < next ? 'on' : i + 1 > next ? 'later' : undefined);
  const station = (i: number, name: string, body: ReactNode, big?: boolean) => (
    <li className="tk-stn" data-link={i < 4 ? line(i) : undefined}>
      <span className="tk-stop" {...stop(i)} data-big={big || undefined} />
      <div className="tk-stn-body">
        <span className="label" data-on={reached[i] || undefined}>{name}</span>
        {body}
      </div>
    </li>
  );
  return (
    <div className="tk-page">
      <div className="tk-read">
        <div className="tk-col">
          <header className="tk-head">
            <h1>{t.title}</h1>
            <button className="btn btn-sm tk-open" onClick={() => flash(`Opens ${t.key} in ${SRC[t.source]}`)}>
              <Icon name="external" size={11} />
              Open in {SRC[t.source]}
            </button>
            <div className="tk-props">
              <span className="mono faint tk-key">{t.key}</span>
              <Choice
                id="tk-status"
                className="select menu-select"
                label="Status"
                lead={<Ring t={t} />}
                value=""
                options={[{ value: '', label: moving ? `Moving to ${moving}…` : t.statusLabel, lead: <Ring t={t} /> }, ...MOVES[t.source].filter(([, n]) => n !== t.statusLabel).map(([s, n]) => ({ value: s, label: n, lead: <span className="tk-ring" data-status={s} aria-hidden="true" /> }))]}
                onChange={(to) => {
                  const name = MOVES[t.source].find(([s]) => s === to)?.[1];
                  if (!name) return;
                  setMoving(name);
                  later(700, () => {
                    setMoving(undefined);
                    set({ status: to as Status, statusLabel: name, since: 'for 1 min' });
                    flash('Status changed');
                  });
                }}
              />
              <Prio t={t} />
              <span className="tk-kind">{t.kind}</span>
              <span className="tk-who" title="Assignee">
                <Avatar name={t.assignee} size={18} />
                {t.assignee}
              </span>
            </div>
          </header>
          <div className="tk-body">
            <section className="section tk-desc">
              <h2 className="sr-only">Description</h2>
              <Markdown text={t.description} />
            </section>
            {t.criteria.length > 0 && (
              <section className="section">
                <h2>Acceptance criteria <span className="mono">{done} of {t.criteria.length}</span></h2>
                <ul className="tk-criteria">
                  {t.criteria.map((c, i) => (
                    <li key={i}>
                      <span className="tk-ring" data-status={c.done ? 'done' : 'todo'} aria-hidden="true" />
                      <span className={c.done ? 'muted' : ''}>{c.text}</span>
                      <span className="sr-only">{c.done ? '(done)' : '(not done)'}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="section">
              <h2>Comments</h2>
              <p className="hint">{t.comments === 0 ? `No comments in ${SRC[t.source]}.` : `${plural(t.comments, 'comment')} in ${SRC[t.source]}, shown here in the app.`}</p>
            </section>
          </div>
        </div>
      </div>
      <aside className="tk-side" aria-label="Work">
        <h2 className="label">Work</h2>
        <ol className="tk-work">
          {station(
            0,
            'Ticket',
            <>
              <span className="tk-stn-text">{t.statusLabel} {t.since}</span>
              <span className="tk-stn-meta">Opened {t.opened} by {t.by}</span>
            </>,
          )}
          {station(
            1,
            'Branch',
            t.branch ? (
              <>
                <span className="mono tk-stn-name">{t.branch}</span>
                {b && <span className="tk-stn-meta">{[plural(b.ahead, 'commit'), b.wip.length > 0 && `WIP ${plural(b.wip.length, 'file')}`, b.base && `off ${b.base}`].filter(Boolean).join(' · ')}</span>}
                <span className="tk-stn-acts">
                  <button className="btn btn-sm btn-primary" disabled={!b} title={b ? undefined : 'Not in this project'} onClick={() => openBranch(t.branch!)}>Go to branch</button>
                </span>
              </>
            ) : (
              <>
                <span className="tk-stn-text">No branch yet</span>
                <span className="tk-stn-meta">{t.release ? 'Branches off release/0.6.0. AI names the branch from this ticket.' : 'Pick a release first, or choose one when you start. AI names the branch from this ticket.'}</span>
                <span className="tk-stn-acts">
                  <button className="btn btn-sm btn-primary" onClick={() => onStart(kind)}>
                    <Icon name="plus" size={11} />
                    Start a branch
                  </button>
                </span>
              </>
            ),
          )}
          {station(
            2,
            'Pull request',
            t.branch ? (
              <span className="tk-stn-acts">
                <button className="btn btn-sm" onClick={() => go('prs')}>Pull requests</button>
              </span>
            ) : (
              <span className="tk-stn-meta faint">Opens from the branch</span>
            ),
          )}
          {station(
            3,
            'Release',
            t.release ? (
              <>
                <span className="tk-stn-num">
                  {t.release}
                  <span className="tag">Next</span>
                </span>
                <span className="tk-stn-meta mono">release/{t.release}</span>
              </>
            ) : suggestion ? (
              <div className="col note-box tk-suggest">
                <span className="row" style={{ gap: 6, fontWeight: 500 }}>
                  <Icon name="sparkle" size={12} className="c-acc" />
                  Suggested: {suggestion.kind === 'fix' ? 'a fix' : 'a feature'} in v{suggestion.release}
                </span>
                <span className="muted">{suggestion.reason}</span>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm" onClick={onDismiss}>Dismiss</button>
                  <button className="btn btn-sm btn-primary" onClick={() => set({ release: suggestion.release })}>Accept</button>
                </div>
              </div>
            ) : (
              <span className="tk-stn-meta">Unplanned · pick one below</span>
            ),
            true,
          )}
          {station(4, 'Shipped', <span className="tk-stn-meta faint">Not yet</span>)}
        </ol>
        <dl className="tk-kvs">
          <div>
            <dt><label htmlFor="tk-rel">Release</label></dt>
            <dd>
              <Choice id="tk-rel" className="select menu-select" label="Release" value={t.release} options={[{ value: '0.6.0', label: 'v0.6.0 · Next' }, { value: '', label: 'Unplanned' }]} onChange={(v) => set({ release: v })} />
            </dd>
          </div>
          {t.source === 'jira' && (
            <>
              <div>
                <dt><label htmlFor="tk-fix">Fix versions</label></dt>
                <dd><FixVersions t={t} onSave={(v) => { set({ fixVersions: v }); flash('Fix versions changed'); }} /></dd>
              </div>
              <div>
                <dt>Parent</dt>
                <dd>
                  {t.parentKey ? (
                    <a className="ellipsis" href="#" title={`Open ${t.parentKey} in Jira`} onClick={(e) => { e.preventDefault(); flash(`Opens ${t.parentKey} in Jira`); }}>
                      <span className="mono faint">{t.parentKey}</span> {t.parentTitle}
                    </a>
                  ) : (
                    <span className="faint">None</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Time left</dt>
                <dd className={t.timeRemaining || t.timeEstimate ? '' : 'faint'}>{t.timeRemaining && t.timeEstimate ? `${t.timeRemaining} of ${t.timeEstimate}` : t.timeEstimate ? `? of ${t.timeEstimate}` : 'Not estimated'}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Tracker</dt>
            <dd className="muted">{SRC[t.source]} · {t.place}</dd>
          </div>
        </dl>
      </aside>
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
      <button id="tk-fix" className="select menu-select" aria-haspopup="menu" aria-expanded={!!m.at} aria-label="Fix versions" onClick={(e) => { if (m.at) return close(); setDraft(fix); m.toggle(e); }}>
        <span className="ellipsis">{(m.at ? draft : fix).join(', ') || 'No fix versions'}</span>
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
