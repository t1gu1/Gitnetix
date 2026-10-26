import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { kindOf, kindOfBranch } from '../../../../src/lib/kinds';
import { Empty, Modal, Seg } from './ui';

/** src/screens/Analytics.tsx over made-up activity: the same numbers for the same day, so the charts hold still between visits. */

const RANGES = ['7', '14', '21', '30', '90', '365'] as const;
type Range = (typeof RANGES)[number];
const PROJECTS = ['acme-web', 'acme-api', 'design-system'];
const TEAM: Record<string, string[]> = { 'acme-web': ['Grace Hopper', 'Ana Moreau', 'Jules Laurent', 'Riya Kapoor'], 'acme-api': ['Tom Becker', 'Ana Moreau', 'Mei Lin'], 'design-system': ['Mei Lin', 'Riya Kapoor'] };
/** Commits on a busy weekday. */
const PACE: Record<string, number> = { 'acme-web': 9, 'acme-api': 6, 'design-system': 3 };
/** [subject, branch it was made on] */
const WORK: Record<string, [string, string][]> = {
  'acme-web': [
    ['feat(tree): pulse along the branch path', 'feat/branch-tree'], ['fix(fetch): prune branches deleted on origin', 'fix/stale-remote'], ['feat(agents): stream steps as they run', 'feat/agent-pane'],
    ['refactor(tree): measure rows once', 'feat/branch-tree'], ['fix(commit): keep the draft per branch', 'fix/commit-draft'], ['docs(changelog): add 0.6.0 changes', 'release/0.6.0'],
    ['test(tree): keyboard navigation', 'feat/tree-keys'], ['style(diff): theme tokens for added lines', 'feat/diff-tokens'],
    ['feat(tree): Home and End keys', 'feat/tree-keys'], ['fix(tree): long names push the row actions out', 'fix/long-names'], ['perf(tree): skip unchanged branch views', 'release/0.6.0'],
    ['feat(tickets): suggest a release when triaging', 'feat/triage'], ['fix(agents): keep the scroll at the newest step', 'feat/agent-pane'], ['chore(deps): bump vite', 'main'],
  ],
  'acme-api': [['feat(api): rate limit per token', 'feat/rate-limit'], ['fix(cart): integer cents for totals', 'fix/tax-rounding'], ['feat(webhooks): retry with backoff', 'feat/webhooks'], ['chore(deps): bump fastify', 'main'], ['fix(invoice): PDF fonts on Linux', 'fix/invoice-pdf']],
  'design-system': [['feat(tokens): dark palette', 'feat/dark-tokens'], ['docs(button): usage guidelines', 'docs/button-usage'], ['feat(date-picker): keyboard support', 'feat/date-picker'], ['fix(focus): ring on dark surfaces', 'fix/focus-ring']],
};
type Release = { project: string; version: string; ago: number; leadHours: number; featureTitles: string[]; fixTitles: string[]; branches: string[] };
const RELEASES: Release[] = [
  { project: 'acme-web', version: 'v0.3.0', ago: 84, leadHours: 19 * 24 + 5, featureTitles: ['Branches as a tree of releases', 'Agent pane per branch'], fixTitles: ['Windows paths with spaces'], branches: ['feat/release-tree', 'feat/agent-pane-v1', 'fix/win-paths'] },
  { project: 'design-system', version: 'v1.7.0', ago: 61, leadHours: 12 * 24, featureTitles: ['Toast component', 'Density tokens'], fixTitles: [], branches: ['feat/toast', 'feat/density'] },
  { project: 'acme-api', version: 'v2.2.0', ago: 66, leadHours: 9 * 24 + 7, featureTitles: ['Orders export'], fixTitles: ['Pagination off by one'], branches: ['feat/orders-export', 'fix/pagination'] },
  { project: 'acme-web', version: 'v0.4.0', ago: 52, leadHours: 14 * 24 + 2, featureTitles: ['Worktrees page', 'Ticket triage'], fixTitles: ['Stale ahead counts'], branches: ['feat/worktrees', 'feat/triage', 'fix/ahead-count'] },
  { project: 'acme-api', version: 'v2.3.0', ago: 31, leadHours: 11 * 24, featureTitles: ['Webhooks v2'], fixTitles: ['Refund rounding', 'Slow cart query'], branches: ['feat/webhooks-v2', 'fix/refund-rounding'] },
  { project: 'acme-web', version: 'v0.5.0', ago: 27, leadHours: 16 * 24 + 9, featureTitles: ['One-click ship', 'Squash merge detection'], fixTitles: ['Real parent for ahead and behind'], branches: ['feat/ship', 'feat/squash-detect', 'fix/real-parent'] },
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
function commitsOn(date: string, projects: string[]): DayCommit[] {
  return projects.flatMap((p) => {
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
}
function day(date: string, projects: string[]) {
  const list = commitsOn(date, projects);
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
function analytics(projects: string[], n: number) {
  const days = Array.from({ length: n }, (_, i) => day(daysAgo(n - 1 - i), projects));
  const prev = Array.from({ length: n }, (_, i) => commitsOn(daysAgo(2 * n - 1 - i), projects).length).reduce((a, b) => a + b, 0);
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
const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const GROUPS = [['feat', 'Features'], ['fix', 'Fixes'], ['other', 'Other']] as const;
/** `feat(ui): x` → feat; titles without a feat or fix prefix are other. */
const groupOf = (subject: string) => {
  const k = kindOf(/^(\w+)[(!:]/.exec(subject)?.[1] ?? '');
  return k === 'feat' || k === 'fix' ? k : 'other';
};

export default function Analytics() {
  const [days, setDays] = useState<Range>('14');
  // Empty means every project.
  const [ids, setIds] = useState<string[]>(['acme-web']);
  const a = analytics(ids.length ? ids : PROJECTS, Number(days));
  const multi = ids.length !== 1;
  const exportCsv = () => {
    const rows = [['date', 'commits'], ...a.days.map((d) => [d.date, String(d.total)])];
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
    link.download = `gitnetix-activity-${days}d.csv`;
    link.click();
  };

  return (
    <main className="page">
      <div className="col" style={{ gap: 32, maxWidth: 1200, marginInline: 'auto' }}>
        <div className="row wrap" style={{ margin: 0, gap: 12 }}>
          <Seg label="Time range" value={days} onChange={setDays} options={RANGES.map((d) => [d, `${d} days`])} />
          <ProjectPicker value={ids} onChange={setIds} />
          <span className="grow" />
          <button className="btn" onClick={exportCsv}>Export CSV</button>
        </div>
        <Body a={a} ids={ids.length ? ids : PROJECTS} multi={multi} />
      </div>
    </main>
  );
}

/** Dropdown of project checkboxes; nothing checked means all projects. */
function ProjectPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = value.length === 0 || value.length === PROJECTS.length ? 'All projects' : value.length === 1 ? value[0] : `${value.length} projects`;
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((p) => p !== id) : [...value, id];
    onChange(next.length === PROJECTS.length ? [] : next);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', down, true);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', down, true);
      removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="select row" style={{ height: 32, gap: 8 }} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sr-only">Projects: </span>
        <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="ctx-menu" role="group" aria-label="Projects to include" style={{ position: 'absolute', top: 36, left: 0, maxHeight: 360, overflowY: 'auto' }}>
          <label className="check ctx-item">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            <span className="grow ellipsis">All projects</span>
          </label>
          <div className="ctx-sep" role="separator" />
          {PROJECTS.map((p) => (
            <label key={p} className="check ctx-item">
              <input type="checkbox" checked={value.includes(p)} onChange={() => toggle(p)} />
              <span className="grow ellipsis">{p}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Body({ a, ids, multi }: { a: A; ids: string[]; multi: boolean }) {
  const [hd, setHd] = useState(-1);
  const [hb, setHb] = useState(-1);
  const [open, setOpen] = useState<string | null>(null);
  const [rel, setRel] = useState<A['releases'][number] | null>(null);
  const n = a.days.length;
  const total = a.days.reduce((s, d) => s + d.total, 0);
  const work = a.days.filter((d) => !d.weekend).length || 1;
  const max = niceMax(Math.max(1, ...a.days.map((d) => d.total)));
  const busiest = a.days.reduce((b, d) => (d.total > b.total ? d : b), a.days[0]);
  const labels = n <= 30 ? 6 : n <= 90 ? 7 : 12;
  const leadMax = niceMax(Math.max(1, ...a.releases.map((r) => r.leadHours / 24)));
  const hover = hd >= 0 ? a.days[hd] : null;
  const ticks = (m: number, unit = '') => [0, 1, 2, 3, 4].map((i) => ({ v: `${Math.round((m * i) / 4)}${unit && i === 4 ? unit : ''}`, top: 100 - i * 25 }));
  const side = (i: number, of: number) => (i / of < 0.2 ? '0' : i / of > 0.8 ? '-100%' : '-50%');

  return (
    <div className="col" style={{ gap: 32 }}>
      <section aria-label="Key figures" className="kpis">
        {a.kpis.map((k) => (
          <div key={k.label} className="kpi">
            <span className="muted" style={{ fontSize: 12 }}>{k.label}</span>
            <span className="v">{k.value}</span>
            <span className="faint" style={{ fontSize: 12 }}>{k.delta}</span>
          </div>
        ))}
      </section>

      <section className="section card" style={{ padding: 20 }}>
        <div className="row wrap" style={{ alignItems: 'baseline' }}>
          <div className="col grow" style={{ gap: 2 }}>
            <h2>Activity, last {n} days</h2>
            <span className="hint">Commits per day, everyone on the project</span>
          </div>
          <span className="muted"><strong style={{ color: 'var(--fg)' }}>{total.toLocaleString('en-US')}</strong> commits</span>
          <span className="muted"><strong style={{ color: 'var(--fg)' }}>{(Math.round((total / work) * 10) / 10).toString()}</strong> per working day</span>
        </div>
        <div className="chart" role="group" aria-label={`${total} commits over the last ${n} days. Busiest day ${fmt(busiest.date, { month: 'short', day: 'numeric' })} with ${busiest.total} commits.`}>
          <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
          <div className="chart-plot" style={{ gap: n <= 30 ? 3 : n <= 90 ? 2 : 0 }} onMouseLeave={() => setHd(-1)}>
            {ticks(max).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
            {a.days.map((d, i) => (
              <button key={d.date} className={`chart-bar${d.weekend ? ' weekend' : ''}${hd >= 0 && hd !== i ? ' dim' : ''}`} aria-label={`${fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${plural(d.total, 'commit')}`} onMouseEnter={() => setHd(i)} onFocus={() => setHd(i)} onClick={() => setOpen(d.date)}>
                <span style={{ height: `${(d.total / max) * 100}%` }} />
              </button>
            ))}
            {hover && (
              <div className="chart-tip" style={{ left: `${((hd + 0.5) / n) * 100}%`, transform: `translateX(${side(hd, n)})` }}>
                <div className="row">
                  <strong className="grow">{fmt(hover.date, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                  <span>{plural(hover.total, 'commit')}</span>
                </div>
                {hover.authors.map(([name, c]) => (
                  <div key={name} className="row">
                    <span className="avatar" style={{ width: 20, height: 20, flexBasis: 20, fontSize: 9 }}>{initials(name)}</span>
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
            {Array.from({ length: labels }, (_, j) => {
              const idx = Math.round((j * (n - 1)) / (labels - 1));
              const d = a.days[idx];
              return (
                <span key={j} style={{ left: `${((idx + 0.5) / n) * 100}%`, transform: `translateX(${j === 0 ? '0' : j === labels - 1 ? '-100%' : '-50%'})` }}>
                  {fmt(d.date, n > 90 ? { month: 'short' } : { month: 'short', day: 'numeric' })}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section card" style={{ padding: 20 }}>
        <div className="col" style={{ gap: 2 }}>
          <h2>Lead time per release</h2>
          <span className="hint">Days from the first commit to the tag · last {a.releases.length} releases</span>
        </div>
        <div className="chart" role="group" aria-label={`Lead time per release: ${a.releases.map((r) => `${r.version} ${lead(r.leadHours)}`).join(', ')}.`}>
          <div className="chart-y">{ticks(leadMax, ' d').map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{t.v}</span>)}</div>
          <div className="chart-plot" style={{ gap: 16 }} onMouseLeave={() => setHb(-1)}>
            {ticks(leadMax).map((t) => <div key={t.top} className="chart-grid" style={{ top: `${t.top}%` }} />)}
            {a.releases.map((r, i) => (
              <button key={`${r.project}:${r.version}`} className={`chart-bar${hb >= 0 && hb !== i ? ' dim' : ''}`} aria-label={`${r.version}: ${lead(r.leadHours)}`} onMouseEnter={() => setHb(i)} onFocus={() => setHb(i)} onClick={() => setRel(r)}>
                <span style={{ height: `${(r.leadHours / 24 / leadMax) * 100}%`, maxWidth: 56, borderRadius: '3px 3px 0 0' }} />
                {hb === i && (
                  <div className="chart-tip" style={{ left: i / a.releases.length < 0.2 ? 0 : i / a.releases.length > 0.8 ? '100%' : '50%', transform: `translateX(${side(i, a.releases.length)})` }}>
                    <div className="row">
                      <strong className="mono grow">{r.version}</strong>
                      <span>{lead(r.leadHours)}</span>
                    </div>
                    {([['Shipped', r.shipped], ['Features', r.featureTitles.length], ['Fixes', r.fixTitles.length]] as const).map(([k, v]) => (
                      <div key={k} className="row">
                        <span className="grow muted">{k}</span>
                        <span className="mono">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
          <div className="row" style={{ gridColumn: 2, gap: 16 }}>
            {a.releases.map((r) => <span key={`${r.project}:${r.version}`} className="mono faint" style={{ flex: '1 1 0', textAlign: 'center', fontSize: 11 }}>{r.version}</span>)}
          </div>
        </div>
      </section>
      {open && <DayModal date={open} ids={ids} multi={multi} onClose={() => setOpen(null)} />}
      {rel && <ReleaseModal r={rel} multi={multi} onClose={() => setRel(null)} />}
    </div>
  );
}

/** Who did what on `date`: each person's commits by type, with the branch each was made on. */
function DayModal({ date, ids, multi, onClose }: { date: string; ids: string[]; multi: boolean; onClose: () => void }) {
  const list = commitsOn(date, ids);
  const people = new Map<string, DayCommit[]>();
  for (const c of list) people.set(c.author, [...(people.get(c.author) ?? []), c]);
  return (
    <Modal title={fmt(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} sub={plural(list.length, 'commit')} onClose={onClose} width={720}>
      {list.length === 0 && <Empty>No commits this day.</Empty>}
      {[...people].sort((x, y) => y[1].length - x[1].length).map(([name, of]) => (
        <section key={name} className="col" style={{ gap: 8 }}>
          <div className="row">
            <span className="avatar" style={{ width: 24, height: 24, flexBasis: 24, fontSize: 10 }}>{initials(name)}</span>
            <strong className="grow">{name}</strong>
            <span className="muted">{plural(of.length, 'commit')}</span>
          </div>
          {GROUPS.map(([kind, label]) => {
            const mine = of.filter((c) => groupOf(c.subject) === kind);
            return mine.length > 0 && (
              <div key={kind} className="col" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>{label}</span>
                {mine.map((c, i) => (
                  <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
                    <span className="mono ellipsis grow" title={c.subject}>{c.subject}</span>
                    {multi && <span className="faint">{c.project}</span>}
                    <span className="mono faint ellipsis" style={{ maxWidth: 220 }} title={c.branch}>{c.branch}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      ))}
    </Modal>
  );
}

/** What a release shipped: its features, its fixes and the branches merged in. */
function ReleaseModal({ r, multi, onClose }: { r: A['releases'][number]; multi: boolean; onClose: () => void }) {
  const lists = [['Features', r.featureTitles], ['Fixes', r.fixTitles], ['Branches merged', r.branches]] as const;
  return (
    <Modal title={<span className="mono">{r.version}</span>} sub={`${multi ? `${r.project} · ` : ''}Shipped ${r.shipped} · ${lead(r.leadHours)} from first commit`} onClose={onClose} width={640}>
      {lists.map(([label, list]) => (
        <section key={label} className="col" style={{ gap: 6 }}>
          <div className="row">
            <h2 className="grow">{label}</h2>
            <span className="muted">{list.length}</span>
          </div>
          {list.length === 0 && <span className="faint">None</span>}
          {list.map((t, i) => {
            const k = label === 'Branches merged' ? kindOfBranch(t) : null;
            return (
              <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
                {k && <span className={`kind-chip ${k === 'fix' ? 'c-del' : 'c-mod'}`}>{k}</span>}
                <span className="mono ellipsis grow" title={t}>{t}</span>
              </div>
            );
          })}
        </section>
      ))}
    </Modal>
  );
}
