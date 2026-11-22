import { useState, type CSSProperties } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { kindOf, kindOfBranch } from '../../../../src/lib/kinds';
import { trackersOf } from './sprintData';
import { Sprints } from './Sprints';
import { DataTable, FigStrip, NoteLayout, PageNote, type Cell } from './charts';
import { Avatar, CheckPicker, PageHead, Seg, useDemo } from './ui';
import { Weekly } from './Weekly';

/** src/screens/Analytics.tsx over made-up activity: the same numbers for the same day, so the charts hold still between visits. */

const RANGES = ['7', '14', '21', '30', '90', '365'] as const;
type Range = (typeof RANGES)[number];
const PROJECTS = ['acme-web', 'acme-api', 'design-system'];
const TEAM: Record<string, string[]> = { 'acme-web': ['Grace Hopper', 'Ana Moreau', 'Jules Laurent', 'Riya Kapoor'], 'acme-api': ['Tom Becker', 'Ana Moreau', 'Mei Lin'], 'design-system': ['Mei Lin', 'Riya Kapoor'] };
/** Each person's commit emails, grouped under one name as the person filter shows them. */
const EMAILS: Record<string, string[]> = {
  'Grace Hopper': ['grace@acme.dev', 'grace.hopper@gmail.com'], 'Ana Moreau': ['ana@acme.dev'], 'Jules Laurent': ['jules@acme.dev', 'jules@laurent.fr'],
  'Riya Kapoor': ['riya@acme.dev'], 'Tom Becker': ['tom@acme.dev'], 'Mei Lin': ['mei@acme.dev'],
};
/** Commits on a busy weekday. */
const PACE: Record<string, number> = { 'acme-web': 9, 'acme-api': 6, 'design-system': 3 };
/** [subject, branch it was made on] */
const WORK: Record<string, [string, string][]> = {
  'acme-web': [
    ['feat(tree): pulse along the branch path (WEB-212)', 'feat/branch-tree'], ['fix(fetch): prune branches deleted on origin (WEB-218)', 'fix/stale-remote'], ['feat(agents): stream steps as they run (WEB-221)', 'feat/agent-pane'],
    ['refactor(tree): measure rows once (WEB-212)', 'feat/branch-tree'], ['fix(commit): keep the draft per branch (WEB-227)', 'fix/commit-draft'], ['docs(changelog): add 0.6.0 changes', 'release/0.6.0'],
    ['test(tree): keyboard navigation', 'feat/tree-keys'], ['style(diff): theme tokens for added lines', 'feat/diff-tokens'],
    ['feat(tree): Home and End keys', 'feat/tree-keys'], ['fix(tree): long names push the row actions out', 'fix/long-names'], ['perf(tree): skip unchanged branch views', 'release/0.6.0'],
    ['feat(tickets): suggest a release when triaging', 'feat/triage'], ['fix(agents): keep the scroll at the newest step', 'feat/agent-pane'], ['chore(deps): bump vite', 'main'],
  ],
  'acme-api': [['feat(api): rate limit per token', 'feat/rate-limit'], ['fix(cart): integer cents for totals', 'fix/tax-rounding'], ['feat(webhooks): retry with backoff', 'feat/webhooks'], ['chore(deps): bump fastify', 'main'], ['fix(invoice): PDF fonts on Linux', 'fix/invoice-pdf']],
  'design-system': [['feat(tokens): dark palette', 'feat/dark-tokens'], ['docs(button): usage guidelines', 'docs/button-usage'], ['feat(date-picker): keyboard support', 'feat/date-picker'], ['fix(focus): ring on dark surfaces', 'fix/focus-ring']],
};
type RawRelease = { project: string; version: string; ago: number; leadHours: number; featureTitles: string[]; fixTitles: string[]; branches: string[] };
const RELEASES: RawRelease[] = [
  { project: 'acme-web', version: 'v0.3.0', ago: 84, leadHours: 19 * 24 + 5, featureTitles: ['Branches as a tree of releases', 'Agent pane per branch'], fixTitles: ['Windows paths with spaces'], branches: ['feat/release-tree', 'feat/agent-pane-v1', 'fix/win-paths'] },
  { project: 'design-system', version: 'v1.7.0', ago: 61, leadHours: 12 * 24, featureTitles: ['Toast component', 'Density tokens'], fixTitles: [], branches: ['feat/toast', 'feat/density'] },
  { project: 'acme-api', version: 'v2.2.0', ago: 66, leadHours: 9 * 24 + 7, featureTitles: ['Orders export'], fixTitles: ['Pagination off by one'], branches: ['feat/orders-export', 'fix/pagination'] },
  { project: 'acme-web', version: 'v0.4.0', ago: 52, leadHours: 14 * 24 + 2, featureTitles: ['Worktrees page', 'Ticket triage'], fixTitles: ['Stale ahead counts'], branches: ['feat/worktrees', 'feat/triage', 'fix/ahead-count'] },
  { project: 'acme-api', version: 'v2.3.0', ago: 31, leadHours: 11 * 24, featureTitles: ['Webhooks v2'], fixTitles: ['Refund rounding', 'Slow cart query'], branches: ['feat/webhooks-v2', 'fix/refund-rounding'] },
  { project: 'acme-web', version: 'v0.5.0', ago: 27, leadHours: 16 * 24 + 9, featureTitles: ['Publish from any branch', 'Squash merge detection'], fixTitles: ['Real parent for ahead and behind'], branches: ['feat/publish', 'feat/squash-detect', 'fix/real-parent'] },
  { project: 'design-system', version: 'v1.8.0', ago: 19, leadHours: 8 * 24 + 4, featureTitles: ['Date picker'], fixTitles: ['Focus ring contrast'], branches: ['feat/date-picker-v1', 'fix/focus-contrast'] },
  { project: 'acme-web', version: 'v0.5.1', ago: 13, leadHours: 2 * 24 + 6, featureTitles: [], fixTitles: ['Tags from other clones', 'Diff scroll on reload'], branches: ['fix/remote-tags', 'fix/diff-scroll'] },
  { project: 'acme-api', version: 'v2.3.1', ago: 9, leadHours: 20, featureTitles: [], fixTitles: ['Cart totals off by a cent'], branches: ['fix/cart-cents'] },
  { project: 'acme-web', version: 'v0.5.2', ago: 6, leadHours: 30, featureTitles: [], fixTitles: ['Worktrees in folders with spaces'], branches: ['fix/wt-spaces'] },
];

/** A seeded generator (mulberry32): the same seed, the same numbers. */
function rng(seed: string) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761), 1);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};
const weekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00`).getDay());
type DayCommit = { project: string; author: string; subject: string; branch: string };
/** The commits of `date` in `projects`, by `who` only when someone is picked. */
function commitsOn(date: string, projects: string[], who: string[] = []): DayCommit[] {
  const all = projects.flatMap((p) => {
    const r = rng(`${p}:${date}`);
    const n = weekend(date) ? Math.round(r() * PACE[p] * 0.3) : Math.round(PACE[p] * (0.4 + r()));
    // A different piece of work for each commit of the day, while they last.
    const work = [...WORK[p]].sort(() => r() - 0.5);
    // Squared: the first of the team commits most.
    return Array.from({ length: n }, (_, i) => {
      const [subject, branch] = work[i % work.length];
      return { project: p, author: TEAM[p][Math.floor(r() * r() * TEAM[p].length)], subject, branch };
    });
  });
  return who.length ? all.filter((c) => who.includes(c.author)) : all;
}
function day(date: string, projects: string[], who: string[]) {
  const list = commitsOn(date, projects, who);
  const authors = new Map<string, number>();
  for (const c of list) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
  return { date, weekend: weekend(date), total: list.length, authors: [...authors].sort((a, b) => b[1] - a[1]), subjects: list.slice(0, 3).map((c) => c.subject) };
}
const signed = (n: number, unit = '') => (n > 0 ? `+${n}${unit}` : n < 0 ? `−${-n}${unit}` : 'Same');
const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
/** What src-tauri's analytics.rs computes, over the made-up history. */
function analytics(projects: string[], n: number, who: string[]) {
  const days = Array.from({ length: n }, (_, i) => day(daysAgo(n - 1 - i), projects, who));
  const prev = Array.from({ length: n }, (_, i) => commitsOn(daysAgo(2 * n - 1 - i), projects, who).length).reduce((a, b) => a + b, 0);
  const total = days.reduce((s, d) => s + d.total, 0);
  const mine = RELEASES.filter((r) => projects.includes(r.project));
  const now = mine.filter((r) => r.ago < n);
  const before = mine.filter((r) => r.ago >= n && r.ago < 2 * n);
  const lead = [median(now.map((r) => r.leadHours / 24)), median(before.map((r) => r.leadHours / 24))];
  const period = `vs previous ${n} days`;
  const kpis = [
    { label: 'Releases shipped', value: String(now.length), delta: `${signed(now.length - before.length)} ${period}` },
    { label: 'Median lead time', value: lead[0] === undefined ? '—' : `${lead[0]} d`, delta: lead[0] === undefined ? `No release in last ${n} days` : lead[1] === undefined ? `No release to compare in previous ${n} days` : `${signed(lead[0] - lead[1], ' d')} ${period}` },
    { label: 'Merges into main and releases', value: String(Math.round(total / 6)), delta: `${signed(Math.round(total / 6) - Math.round(prev / 6))} ${period}` },
    { label: 'Total commits', value: String(total), delta: `${signed(total - prev)} ${period}` },
  ];
  return { days, kpis, releases: mine.slice(-8).map((r) => ({ ...r, shipped: daysAgo(r.ago) })) };
}
type A = ReturnType<typeof analytics>;

function niceMax(v: number) {
  for (const s of [4, 8, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100]) if (v <= s) return s;
  return Math.ceil(v / 20) * 20;
}
const lead = (h: number) => {
  if (h < 1) return 'Less than 1 h';
  const d = Math.floor(h / 24), r = h % 24;
  return d === 0 ? `${r} h` : r === 0 ? `${d} d` : `${d} d ${r} h`;
};
const fmt = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', opts);
const GROUPS = [['feat', 'Feature'], ['fix', 'Fix'], ['other', 'Other']] as const;
/** The list pane or the picked item's pane, on a phone where only one shows. */
export type Pane = 'rail' | 'detail';
type Release = A['releases'][number];
/** What the commits tab shows on the right: a day, or a release from the rail. */
type Pick = { day: string } | { release: Release };
const relKey = (r: Release) => `${r.project}:${r.version}`;
/** The demo's releases carry their day as it is. */
const shippedOn = (date: string) => date;
/** Ticket keys in a commit's subject, or in the branch it was made on, as keysIn in src/screens/Analytics.tsx finds them. */
const keysIn = (subject: string, branch: string) => [...new Set([...(subject.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? []), ...(branch.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d+/g) ?? [])])];
/** `feat(ui): x` → feat; titles without a feat or fix prefix are other. */
const groupOf = (subject: string) => {
  const k = kindOf(/^(\w+)[(!:]/.exec(subject)?.[1] ?? '');
  return k === 'feat' || k === 'fix' ? k : 'other';
};

export default function Analytics() {
  const [days, setDays] = useState<Range>('14');
  const [tab, setTab] = useState<'commits' | 'tickets'>('commits');
  const [view, setView] = useState<'sprints' | 'weekly'>('sprints');
  // The day or release shown, picked in the rail, on the chart or from a ticket's code; a ticket key to open on the tickets tab.
  const [pick, setPick] = useState<Pick | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('rail');
  // Empty means every project.
  const [ids, setIds] = useState<string[]>(['acme-web']);
  // Names of the people counted; empty means everyone.
  const [who, setWho] = useState<string[]>([]);
  const chosen = ids.length ? ids : PROJECTS;
  const people = [...new Set(chosen.flatMap((p) => TEAM[p]))].sort();
  const picked = people.filter((p) => who.includes(p));
  const by = who.length === 0 ? null : picked.length === 0 ? 'the people picked' : picked.length === 1 ? picked[0] : `${picked.length} people`;
  const a = analytics(chosen, Number(days), who);
  const multi = ids.length !== 1;
  const trackers = trackersOf(chosen);
  const tracker = trackers.join(' · ');
  const jira = trackers.includes('Jira');
  const switchTab = (t: typeof tab) => { setTab(t); setPane('rail'); };
  const exportCsv = () => {
    const rows = [['date', 'commits'], ...a.days.map((d) => [d.date, String(d.total)])];
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
    link.download = `gitnetix-activity-${days}d.csv`;
    link.click();
  };
  const views = (
    <Seg
      label="View"
      value={tab}
      onChange={switchTab}
      options={[
        ['commits', <span className="row" style={{ gap: 6, margin: 0 }}><Icon name="commit" size={12} />Commits</span>],
        ['tickets', <span className="row" style={{ gap: 6, margin: 0 }}><Icon name="ticket" size={12} />{tracker}</span>],
      ]}
    />
  );
  const picker = <CheckPicker what="projects" items={PROJECTS.map((p) => ({ id: p, name: p }))} all={ids.length === 0} picked={ids} onChange={(v) => setIds(!v || v.length === PROJECTS.length ? [] : v)} />;
  // Picks stay when the projects change, so they count again once their people are back.
  const whoPicker = <CheckPicker what="people" items={people.map((p) => ({ id: p, name: p, sub: EMAILS[p].join(', '), avatar: true }))} all={who.length === 0} picked={picked} onChange={(v) => setWho(v ? [...who.filter((p) => !people.includes(p)), ...v] : [])} />;
  const title = <h2 className="map-title hide-narrow">Analytics</h2>;
  const sub = jira && <Seg label="Tickets view" value={view} onChange={(v) => { setView(v); setPane('rail'); }} options={[['sprints', 'Sprints'], ['weekly', 'Weekly']]} />;
  const leadBar = <>{title}{views}{picker}{sub}</>;
  const openTicket = jira ? (key: string) => { setView('sprints'); switchTab('tickets'); setFocus(key); } : undefined;
  // The phone's header row: the page, or the pick once its pane is open.
  const header = (crumb?: string) => <PageHead title="Analytics" sub={pane === 'detail' && crumb ? crumb : tab === 'commits' ? 'Commits' : tracker} onBack={pane === 'detail' ? () => setPane('rail') : undefined} />;

  if (tab === 'tickets')
    return jira && view === 'sprints' ? (
      <Sprints lead={leadBar} header={header} focus={focus} onFocused={() => setFocus(null)} onDay={(d) => { switchTab('commits'); setPick({ day: d }); setPane('detail'); }} onWeekly={() => setView('weekly')} pane={pane} onPicked={() => setPane('detail')} />
    ) : (
      <Weekly ids={chosen} lead={leadBar} header={header} trackers={tracker} pane={pane} onPicked={() => setPane('detail')} />
    );
  return (
    <>
      {header(pick ? ('day' in pick ? fmt(pick.day, { weekday: 'short', month: 'short', day: 'numeric' }) : pick.release.version) : undefined)}
      <div className="map-bar ana-bar" data-detail={pane === 'detail' || undefined}>
        {title}
        {views}
        {picker}
        <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((d): [Range, string] => [d, d === '365' ? '1 y' : `${d} d`])} />
        {people.length > 1 && whoPicker}
        <span className="grow" />
        <button className="btn btn-sm hide-narrow" onClick={exportCsv}>
          <Icon name="download" size={12} />
          Export CSV
        </button>
      </div>
      <Commits
        a={a}
        multi={multi}
        by={by}
        ids={chosen}
        who={who}
        pick={pick}
        onPick={(p) => { setPick(p); setPane('detail'); }}
        pane={pane}
        onTicket={openTicket}
        onLonger={Number(days) < 30 ? () => setDays('30') : undefined}
        onEveryone={who.length ? () => setWho([]) : undefined}
      />
    </>
  );
}

/** Days grouped by week (by month past a month), newest first: each its label, the rows inside and their commits. */
function groupDays(days: A['days']) {
  const long = days.length > 31;
  const groups: { key: string; label: string; total: number; rows: { d: A['days'][number]; i: number }[] }[] = [];
  days.forEach((d, i) => {
    const t = new Date(`${d.date}T12:00:00`);
    const monday = new Date(t);
    monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const key = long ? d.date.slice(0, 7) : monday.toISOString().slice(0, 10);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const label = long ? t.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString('en-US', sunday.getMonth() === monday.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
      g = { key, label, total: 0, rows: [] };
      groups.push(g);
    }
    g.total += d.total;
    g.rows.unshift({ d, i });
  });
  if (!long && groups.length) {
    groups[groups.length - 1].label = `This week · ${groups[groups.length - 1].label}`;
    if (groups.length > 1) groups[groups.length - 2].label = `Last week · ${groups[groups.length - 2].label}`;
  }
  return groups.reverse();
}

/** The commits tab: days and releases in the rail, the figures, the chart and the picked day or release beside it. */
function Commits({ a, multi, by, ids, who, pick, onPick, pane, onTicket, onLonger, onEveryone }: {
  a: A; multi: boolean; by: string | null; ids: string[]; who: string[]; pick: Pick | null; onPick: (p: Pick) => void; pane: Pane;
  onTicket?: (key: string) => void; onLonger?: () => void; onEveryone?: () => void;
}) {
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const work = a.days.filter((d) => !d.weekend).length || 1;
  // Nothing picked yet: the latest day with a commit.
  const shown: Pick | null = pick ?? (total ? { day: [...a.days].reverse().find((d) => d.total > 0)!.date } : null);
  const day = shown && 'day' in shown ? shown.day : null;
  const rel = shown && 'release' in shown ? shown.release : null;
  const dayMax = Math.max(1, ...a.days.map((d) => d.total));
  const leadMax = Math.max(1, ...a.releases.map((r) => r.leadHours));
  const tagsOn = (iso: string) => a.releases.filter((r) => r.shipped === shippedOn(iso));
  const kpis = [...a.kpis].sort((x, y) => Number(y.label === 'Total commits') - Number(x.label === 'Total commits'));
  const figs = [
    ...kpis.slice(0, 1).map((k) => ({ label: 'Commits', value: k.value, sub: k.delta })),
    { label: 'Per working day', value: String(Math.round((total / work) * 10) / 10), sub: `${plural(work, 'working day')} shown` },
    ...kpis.slice(1).map((k) => ({ label: k.label, value: k.value, sub: k.delta })),
  ];
  const groups = groupDays(a.days);
  const inRange = a.releases.filter((r) => a.days.some((d) => r.shipped === shippedOn(d.date)));

  return (
    <div className="body split ana">
      <section className="master ana-rail" data-pane data-active={pane === 'rail'} aria-label="Days and releases">
        {total > 0 && (
          <div className="show-narrow ana-rail-head">
            <FigStrip items={figs.slice(0, 4)} />
            <Activity a={a} by={by} day={day} onDay={(d) => onPick({ day: d })} compact />
          </div>
        )}
        <div className="ana-rh">
          <h3>Days</h3>
          <span className="hint">{plural(total, 'commit')}</span>
        </div>
        {groups.map((g) => (
          <div key={g.key}>
            <div className="ana-wk">
              <span>{g.label}</span>
              {a.days.length > 31 && <span className="mono">{g.total}</span>}
            </div>
            {g.rows.map(({ d }) => (
              <button key={d.date} className="ana-row" data-soft={d.weekend || undefined} aria-pressed={d.date === day} aria-label={`${fmt(d.date, { weekday: 'long', month: 'short', day: 'numeric' })}: ${plural(d.total, 'commit')}`} onClick={() => onPick({ day: d.date })}>
                <span className="ana-row-l">{fmt(d.date, { weekday: 'short' })} <b>{d.date.slice(8).replace(/^0/, '')}</b></span>
                <span className="ana-track">
                  <span className="ana-fill" style={{ '--w': d.total / dayMax } as CSSProperties} />
                  {tagsOn(d.date).map((r) => (
                    <span key={relKey(r)} className="ana-tag mono"><Icon name="tag" size={11} />{r.version}</span>
                  ))}
                </span>
                <span className="ana-n">{d.total}</span>
              </button>
            ))}
          </div>
        ))}
        {a.releases.length > 0 && (
          <>
            <div className="ana-rh ana-sep">
              <h3>Lead time per release</h3>
              <span className="hint">first commit to tag</span>
            </div>
            {[...a.releases].reverse().map((r) => (
              <button key={relKey(r)} className="ana-row" aria-pressed={rel ? relKey(rel) === relKey(r) : false} title={multi ? r.project : undefined} onClick={() => onPick({ release: r })}>
                <span className="ana-row-l mono">{r.version}</span>
                <span className="ana-track">
                  <span className="ana-fill" style={{ '--w': r.leadHours / leadMax } as CSSProperties} />
                </span>
                <span className="ana-n">{lead(r.leadHours)}</span>
              </button>
            ))}
          </>
        )}
      </section>
      <main className="detail ana-det" data-pane data-active={pane === 'detail'}>
        {total > 0 && (
          <div className="hide-narrow ana-stack">
            <FigStrip items={figs} />
            <Activity a={a} by={by} day={day} onDay={(d) => onPick({ day: d })} />
          </div>
        )}
        {total === 0 && !pick ? (
          <PageNote
            title={`No commits${by ? ` by ${by}` : ''} in the last ${plural(a.days.length, 'day')}`}
            facts={[
              ['Days shown', `${fmt(a.days[0].date, { month: 'short', day: 'numeric' })} – ${fmt(a.days[a.days.length - 1].date, { month: 'short', day: 'numeric' })}`],
              ['Counted', by ?? 'Everyone, on every branch of the chosen projects'],
              ['Releases in these days', inRange.length ? inRange.map((r) => `${r.version} on ${fmt(r.shipped, { month: 'short', day: 'numeric' })}`).join(', ') : 'None'],
            ]}
            actions={
              (onLonger || onEveryone) && (
                <>
                  {onLonger && <button className="btn btn-sm btn-primary" onClick={onLonger}>Show 30 days</button>}
                  {onEveryone && <button className="btn btn-sm" onClick={onEveryone}>Show everyone</button>}
                </>
              )
            }
          >
            <p>The days stay in the list at zero, so a quiet stretch shows as one.</p>
          </PageNote>
        ) : day ? (
          <DayDetail date={day} ids={ids} who={who} multi={multi} tags={tagsOn(day)} onTicket={onTicket} />
        ) : rel ? (
          <ReleaseDetail r={rel} multi={multi} />
        ) : null}
      </main>
    </div>
  );
}

/** Commits per day, the picked day in ink, release tags as stations on their day. */
function Activity({ a, by, day, onDay, compact }: { a: A; by: string | null; day: string | null; onDay: (date: string) => void; compact?: boolean }) {
  const [hd, setHd] = useState(-1);
  const [asTable, setAsTable] = useState(false);
  const n = a.days.length;
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const max = niceMax(Math.max(1, ...a.days.map((d) => d.total)));
  const busiest = a.days.reduce((b, d) => (d.total > b.total ? d : b), a.days[0]);
  const labels = compact ? 5 : n <= 30 ? 6 : n <= 90 ? 7 : 12;
  // Up to a month, every day has its label and the picked one is in ink.
  const daily = !compact && n <= 31;
  const hover = hd >= 0 ? a.days[hd] : null;
  const ticks = [0, 1, 2, 3, 4].map((i) => ({ v: Math.round((max * i) / 4), top: 100 - i * 25 }));
  const stations = a.days.flatMap((d, i) => a.releases.filter((r) => r.shipped === shippedOn(d.date)).map((r) => ({ r, i })));
  return (
    <section className="ana-sec">
      {!compact && (
        <div className="ana-sh">
          <div>
            <h2>Commits per day</h2>
            <span className="hint">{by ? `By ${by}` : 'Everyone'}, last {plural(n, 'day')}. Pick a day for its commits.</span>
          </div>
          <span className="ana-key"><i />Working day</span>
          <span className="ana-key"><i data-soft />Weekend</span>
          {stations.length > 0 && <span className="ana-key"><Icon name="tag" size={11} />Release tagged</span>}
          <button className="btn btn-ghost btn-icon btn-sm" aria-pressed={asTable} aria-label={asTable ? 'Show the chart' : 'Show as a table'} title={asTable ? 'Show the chart' : 'Show as a table'} onClick={() => setAsTable(!asTable)}>
            <Icon name={asTable ? 'chart' : 'table'} size={13} />
          </button>
        </div>
      )}
      {asTable ? (
        <DataTable rows={[['Date', 'Commits', 'By'], ...a.days.map((d): Cell[] => [d.date, d.total, d.authors.map(([name, c]) => `${name} (${c})`).join('; ')])]} />
      ) : (
      <div className="chart ana-chart" role="group" aria-label={`${total} commits over the last ${n} days. Busiest day ${busiest ? fmt(busiest.date, { month: 'short', day: 'numeric' }) : ''} with ${busiest?.total ?? 0} commits.`}>
        <div className="chart-y">{ticks.map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
        <div className="chart-plot" style={{ gap: n <= 30 ? 6 : n <= 90 ? 2 : 0 }} onMouseLeave={() => setHd(-1)}>
          {ticks.map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
          {stations.map(({ r, i }) => (
            <span key={relKey(r)} className="ana-station" style={{ left: `${((i + 1) / n) * 100}%` }}>
              <b className="mono">{r.version}</b>
            </span>
          ))}
          {a.days.map((d, i) => (
            <button
              key={d.date}
              className={`chart-bar ana-col${d.weekend ? ' weekend' : ''}${d.date === day ? ' on' : ''}`}
              aria-pressed={d.date === day}
              aria-label={`${fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${plural(d.total, 'commit')}`}
             
              onMouseEnter={() => setHd(i)}
              onFocus={() => setHd(i)}
              onBlur={() => setHd(-1)}
              onClick={() => onDay(d.date)}
            >
              <span style={{ height: `${(d.total / max) * 100}%` }} />
              {d.date === day && d.total > 0 && <b className="ana-col-v mono" style={{ bottom: `calc(${(d.total / max) * 100}% + 4px)` }}>{d.total}</b>}
            </button>
          ))}
          {hover && (
            <div className="chart-tip" style={{ left: `${((hd + 0.5) / n) * 100}%`, transform: `translateX(${hd / n < 0.2 ? '0' : hd / n > 0.8 ? '-100%' : '-50%'})` }}>
              <div className="row">
                <strong className="grow">{fmt(hover.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                <span>{plural(hover.total, 'commit')}</span>
              </div>
              {hover.authors.map(([name, c]) => (
                <div key={name} className="row">
                  <Avatar name={name} size={20} decorative />
                  <span className="grow">{name}</span>
                  <span className="mono">{c}</span>
                </div>
              ))}
              {hover.subjects.map((s, i) => <span key={i} className="mono faint ellipsis" style={{ fontSize: 11 }}>{s}</span>)}
              {hover.total > hover.subjects.length && <span className="faint">+ {hover.total - hover.subjects.length} more</span>}
            </div>
          )}
        </div>
        <div className="chart-x">
          {daily && a.days.map((d, i) => (
            <span key={d.date} className={d.date === day ? 'ana-x-on' : undefined} style={{ left: `${((i + 0.5) / n) * 100}%`, transform: 'translateX(-50%)' }}>
              {i === 0 || d.date.endsWith('-01') ? fmt(d.date, { month: 'short', day: 'numeric' }) : Number(d.date.slice(8))}
            </span>
          ))}
          {!daily && Array.from({ length: labels }, (_, j) => {
            const idx = Math.round((j * (n - 1)) / (labels - 1));
            const d = a.days[idx];
            if (!d) return null;
            return (
              <span key={j} style={{ left: `${((idx + 0.5) / n) * 100}%`, transform: `translateX(${j === 0 ? '0' : j === labels - 1 ? '-100%' : '-50%'})` }}>
                {fmt(d.date, n > 90 ? { month: 'short' } : { month: 'short', day: 'numeric' })}
              </span>
            );
          })}
        </div>
      </div>
      )}
    </section>
  );
}

/** Who did what on `date`: each person's commits by type, with the branch each was made on, a link into the workspace. */
function DayDetail({ date, ids, who, multi, tags, onTicket }: { date: string; ids: string[]; who: string[]; multi: boolean; tags: Release[]; onTicket?: (key: string) => void }) {
  const { branches, openBranch } = useDemo();
  const list = commitsOn(date, ids, who);
  const people = new Map<string, DayCommit[]>();
  for (const c of list) people.set(c.author, [...(people.get(c.author) ?? []), c]);
  // The demo's map holds acme-web's branches only.
  const onMap = (c: DayCommit) => c.project === 'acme-web' && !!branches[c.branch];
  // The day in the workspace: the release branch of a version tagged that day, else the branch with the most commits.
  const open = list.filter(onMap);
  const busiest = [...open.reduce((m, c) => m.set(c.branch, (m.get(c.branch) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1])[0]?.[0];
  const target = open.find((c) => tags.some((r) => /^release[/-]/.test(c.branch) && c.branch.endsWith(r.version.replace(/^v/, '')))) ?? open.find((c) => c.branch === busiest);
  return (
    <section className="ana-sec" aria-label="Commits of the day">
      <div className="ana-dh">
        <h3>{fmt(date, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
        <span className="muted">{plural(list.length, 'commit')}{people.size > 1 ? ` · ${people.size} people` : ''}</span>
        {tags.map((r) => <span key={relKey(r)} className="ana-pill"><Icon name="tag" size={12} /><span className="mono">{r.version}</span> tagged</span>)}
        {target && (
          <>
            <span className="grow" />
            <button className="btn btn-sm" title={`Opens ${target.branch}`} onClick={() => openBranch(target.branch)}>
              <Icon name="branch" size={12} />
              Open in the workspace
            </button>
          </>
        )}
      </div>
      {list.length === 0 && <p className="muted">{who.length ? 'No commits by the people picked this day.' : 'No commits this day.'}</p>}
      <div className="ana-day">
        {[...people].sort((x, y) => y[1].length - x[1].length).map(([name, of]) => (
          <div key={name} className="ana-person">
            <div className="ana-person-h">
              <Avatar name={name} size={22} decorative />
              <strong className="grow">{name}</strong>
              <span className="hint">{plural(of.length, 'commit')}</span>
            </div>
            {[...of].sort((x, y) => GROUPS.findIndex(([k]) => k === groupOf(x.subject)) - GROUPS.findIndex(([k]) => k === groupOf(y.subject))).map((c, i) => (
              <div key={i} className="ana-cm">
                <span className="faint">{GROUPS.find(([k]) => k === groupOf(c.subject))![1]}</span>
                <span className="mono ellipsis ana-cm-s" title={c.subject}>{c.subject}</span>
                <span className="ana-cm-t">
                  {onTicket && keysIn(c.subject, c.branch).map((k) => (
                    <button key={k} className="spr-chip" title={`See ${k} on the tickets tab`} onClick={() => onTicket(k)}>{k}</button>
                  ))}
                </span>
                {onMap(c) ? (
                  <button className="mono ellipsis ana-cm-b ana-link" title={`Open ${c.branch} in the workspace`} onClick={() => openBranch(c.branch)}><Icon name="branch" size={11} /><span className="ellipsis">{multi ? `${c.project} · ` : ''}{c.branch}</span></button>
                ) : (
                  <span className="mono faint ellipsis ana-cm-b" title={c.branch}>{multi ? `${c.project} · ` : ''}{c.branch}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** What a release shipped: its features, its fixes and the branches merged in. */
function ReleaseDetail({ r, multi }: { r: Release; multi: boolean }) {
  const lists = [['Features', r.featureTitles], ['Fixes', r.fixTitles], ['Branches merged', r.branches]] as const;
  return (
    <section className="ana-sec" aria-label={`Release ${r.version}`}>
      <div className="ana-dh">
        <h3 className="mono">{r.version}</h3>
        <span className="muted">{multi ? `${r.project} · ` : ''}Shipped {fmt(r.shipped, { month: 'short', day: 'numeric' })} · {lead(r.leadHours)} from its first commit</span>
      </div>
      <div className="ana-day">
        {lists.map(([label, list]) => (
          <div key={label} className="ana-person">
            <div className="ana-person-h">
              <strong className="grow">{label}</strong>
              <span className="hint">{list.length}</span>
            </div>
            {list.length === 0 && <span className="faint">{label === 'Branches merged' ? 'No merge commit names a branch (rebased or fast-forwarded in)' : 'None'}</span>}
            {list.map((t, i) => {
              const k = label === 'Branches merged' ? kindOfBranch(t) : null;
              return (
                <div key={i} className="ana-cm" style={{ gridTemplateColumns: k ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
                  {k && <span className="faint">{k}</span>}
                  <span className="mono ellipsis ana-cm-s" title={t}>{t}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
